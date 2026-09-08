/**
 * Trusted managed-run controller and CLI.
 *
 * The controller owns run preparation, isolated Git worktrees, exact result
 * parsing, controller commits, deterministic verification, independent review,
 * evidence, approvals, adoption, and PR receipts. All downstream quality and
 * publishing claims bind to the controller-owned implementation SHA. State is
 * written atomically under the host Lab state root; external actions and final
 * operations are idempotent. Unknown options, unsafe paths, dirty/undeclared
 * changes, missing evidence, invalid transitions, and interrupted work fail
 * closed. See docs/managed-runs.md for the lifecycle contract.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTransition,
  selectModelRoute,
  selectReviewerRoutes
} from "../quality-lib.mjs";
import { normalizeRunLimits, processIsAlive } from "./run-control.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  packAgentConfig,
  qualityContractPath
} from "../lab/pack-loader.mjs";
import { checkpointRun, recordTraceEvent } from "./durable-state.mjs";
import {
  beginDurableAttempt,
  finishDurableAttempt,
  heartbeatDurableRun
} from "./run-service.mjs";
import { labStateRoot } from "../lab/host-state.mjs";
import { rebuildRunProjections } from "./run-projections.mjs";
import { assertNoMaintenance } from "../lab/state-volumes.mjs";

export function createControllerRuntime() {
  const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const controllerPackSet = loadPackSet({
    roots: configuredPackRoots({ envFile: join(harnessRoot, "opencode.env") })
  });
  const qualityRoot = resolve(process.env.QUALITY_STATE_ROOT ?? labStateRoot());
  assertNoMaintenance(join(qualityRoot, "updates"));
  const runsRoot = join(qualityRoot, "runs");
  const researchStagingRoot = join(qualityRoot, "research-staging");
  const idempotencyRoot = join(qualityRoot, "idempotency");
  const routingPolicyPath = join(harnessRoot, "quality", "model-routing.json");
  const shortCommandTimeoutMs = Number(
    process.env.QUALITY_COMMAND_TIMEOUT_MS ?? 2 * 60 * 1000
  );
  const shortCommandOutputBytes = Number(
    process.env.QUALITY_COMMAND_OUTPUT_BYTES ?? 8 * 1024 * 1024
  );

  function fail(message) {
    throw new Error(message);
  }

  function parseArgs(argv) {
    const [command = "help", ...rest] = argv;
    const options = { command, verify: [], artifact: [], member: [] };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`);
      const key = token.slice(2).replaceAll("-", "_");
      if (
        ["release", "allow_dirty_source", "skip_agent", "skip_review"].includes(
          key
        )
      ) {
        options[key] = true;
        continue;
      }
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) fail(`Missing value for ${token}`);
      index += 1;
      if (["verify", "artifact", "member"].includes(key))
        options[key].push(value);
      else options[key] = value;
    }
    return options;
  }

  function exec(
    command,
    args,
    {
      cwd,
      env,
      capture = true,
      allowFailure = false,
      timeoutMs = shortCommandTimeoutMs,
      maxOutputBytes = shortCommandOutputBytes
    } = {}
  ) {
    const result = spawnSync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      killSignal: "SIGKILL"
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new Error(`${command} exceeded its ${timeoutMs}ms deadline.`);
      }
      if (result.error.code === "ENOBUFS") {
        throw new Error(
          `${command} exceeded its ${maxOutputBytes}-byte output limit.`
        );
      }
      throw result.error;
    }
    if (result.status !== 0 && !allowFailure) {
      const detail = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      throw new Error(
        `${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`
      );
    }
    return result;
  }

  function git(workspace, args, options = {}) {
    return exec("git", ["-C", workspace, ...args], options).stdout.trim();
  }

  function readJson(path, fallback = null) {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  function waitSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  function withFileLockSync(lockPath, action, { timeoutMs = 5_000 } = {}) {
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let descriptor;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        writeSync(
          descriptor,
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
        );
        fsyncSync(descriptor);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let lock = {};
        try {
          lock = readJson(lockPath, {});
        } catch {
          // The owner may still be flushing the newly created lock record.
        }
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        const knownOwner =
          Number.isInteger(Number(lock.pid)) && Number(lock.pid) > 1;
        if (ageMs > 30_000 || (knownOwner && !processIsAlive(lock.pid))) {
          try {
            unlinkSync(lockPath);
          } catch (unlinkError) {
            if (unlinkError?.code !== "ENOENT") throw unlinkError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for state lock: ${lockPath}`);
        }
        waitSync(20);
      }
    }
    let result;
    let actionError;
    try {
      result = action();
    } catch (error) {
      actionError = error;
    }
    let cleanupError;
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && !cleanupError) cleanupError = error;
    }
    if (actionError) throw actionError;
    if (cleanupError) throw cleanupError;
    return result;
  }

  function atomicWriteJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(
      dirname(path),
      `.${process.pid}-${randomUUID()}-${path.split(sep).at(-1)}.tmp`
    );
    const descriptor = openSync(temporary, "wx", 0o600);
    let writeError;
    try {
      writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(descriptor);
    } catch (error) {
      writeError = error;
    } finally {
      closeSync(descriptor);
    }
    if (writeError) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the original write failure.
      }
      throw writeError;
    }
    try {
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the original rename failure.
      }
      throw error;
    }
  }

  function runPath(runId, name) {
    return join(runsRoot, runId, name);
  }

  function contractName(agent) {
    if (agent === "research") return "research";
    const contributed = packAgentConfig(controllerPackSet, agent);
    if (contributed?.qualityContract) return contributed.qualityContract;
    if (controllerPackSet.qualityContracts[agent]) return agent;
    return "coding";
  }

  function loadContract(agent) {
    const name = contractName(agent);
    const path = qualityContractPath(
      controllerPackSet,
      name,
      join(harnessRoot, "quality", "contracts")
    );
    const contract = readJson(path);
    return contract ? { name, path, contract } : null;
  }

  function selectRunModel(agent, task, override) {
    if (override) return override;
    const contributed = packAgentConfig(controllerPackSet, agent);
    if (contributed?.model) return contributed.model;
    const policy = readJson(routingPolicyPath, {});
    return selectModelRoute(agent, task, policy);
  }

  function routeLane(model) {
    const policy = readJson(routingPolicyPath, {});
    return Object.values(policy?.lanes ?? {}).find(
      (lane) => lane?.model === model
    );
  }

  function limitsForLane(laneName, options = {}) {
    const policy = readJson(routingPolicyPath, {});
    const lane = policy?.lanes?.[laneName];
    return normalizeRunLimits({
      maxTokens: options.max_tokens ?? lane?.maxTokens,
      maxCost: options.max_cost ?? lane?.maxCost,
      maxToolCalls: options.max_tool_calls ?? lane?.maxToolCalls,
      reviewTimeoutMs: options.review_timeout_ms,
      implementationTimeoutMs: options.implementation_timeout_ms,
      verificationTimeoutMs: options.verification_timeout_ms
    });
  }

  function limitsFromOptions(options = {}, model = null) {
    const lane = routeLane(model ?? options.model);
    return normalizeRunLimits({
      implementationTimeoutMs:
        options.implementation_timeout_ms ??
        process.env.QUALITY_IMPLEMENTATION_TIMEOUT_MS,
      verificationTimeoutMs:
        options.verification_timeout_ms ??
        process.env.QUALITY_VERIFICATION_TIMEOUT_MS,
      reviewTimeoutMs:
        options.review_timeout_ms ?? process.env.QUALITY_REVIEW_TIMEOUT_MS,
      maxOutputBytes:
        options.max_output_bytes ?? process.env.QUALITY_MAX_OUTPUT_BYTES,
      maxTokens:
        options.max_tokens ?? process.env.QUALITY_MAX_TOKENS ?? lane?.maxTokens,
      maxCost:
        options.max_cost ?? process.env.QUALITY_MAX_COST ?? lane?.maxCost,
      maxToolCalls:
        options.max_tool_calls ??
        process.env.QUALITY_MAX_TOOL_CALLS ??
        lane?.maxToolCalls,
      heartbeatMs: process.env.QUALITY_HEARTBEAT_MS,
      terminationGraceMs: process.env.QUALITY_TERMINATION_GRACE_MS
    });
  }

  function remainingBudgets(run, { reviewer = false } = {}) {
    const limits = reviewer ? (run.reviewLimits ?? run.limits) : run.limits;
    const telemetry = reviewer
      ? run.reviewTelemetry
      : (run.implementationTelemetry ?? run.telemetry);
    return {
      maxTokens: Math.max(
        0,
        Number(limits.maxTokens) - Number(telemetry?.tokens ?? 0)
      ),
      maxCost: Math.max(
        0,
        Number(limits.maxCost) - Number(telemetry?.cost ?? 0)
      ),
      maxToolCalls: Math.max(
        0,
        Number(limits.maxToolCalls) - Number(telemetry?.toolCalls ?? 0)
      )
    };
  }

  function budgetBlocker(run, { reviewer = false } = {}) {
    const remaining = remainingBudgets(run, { reviewer });
    const exhausted = Object.entries(remaining).find(([, value]) => value <= 0);
    return exhausted ? `${exhausted[0]} budget is exhausted` : null;
  }

  function phasePath(runId) {
    return runPath(runId, "phase-process.json");
  }

  function leaseDurationMs(run) {
    return Math.max(
      run.limits.heartbeatMs * 3,
      shortCommandTimeoutMs + run.limits.terminationGraceMs
    );
  }

  function writeHeartbeat(run, phase = null, status = "running") {
    if (!run.worker?.leaseId) return;
    const now = Date.now();
    const heartbeat = {
      runId: run.id,
      leaseId: run.worker.leaseId,
      workerPid: run.worker.pid,
      heartbeatAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseDurationMs(run)).toISOString(),
      phase,
      status
    };
    atomicWriteJson(runPath(run.id, "heartbeat.json"), heartbeat);
    heartbeatDurableRun({
      root: qualityRoot,
      runId: run.id,
      leaseId: heartbeat.leaseId,
      workerPid: heartbeat.workerPid,
      phase: typeof phase === "string" ? phase : phase?.phase,
      leaseExpiresAt: heartbeat.leaseExpiresAt
    });
  }

  function currentPhase(runId) {
    const phase = readJson(phasePath(runId));
    return phase?.runId === runId ? phase : null;
  }

  function setPhaseProcess(run, phase, identity) {
    const record = {
      runId: run.id,
      leaseId: run.worker?.leaseId ?? null,
      phase,
      ...identity
    };
    atomicWriteJson(phasePath(run.id), record);
    writeHeartbeat(run, record);
  }

  function clearPhaseProcess(run) {
    const path = phasePath(run.id);
    const phase = readJson(path);
    if (phase && phase.leaseId === run.worker?.leaseId) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    writeHeartbeat(run);
  }

  function beginWorkerLease(initialRun, operation) {
    const run = loadRun(initialRun.id);
    run.limits = normalizeRunLimits(run.limits ?? {});
    const priorHeartbeat = readJson(runPath(run.id, "heartbeat.json"));
    const priorIsFresh =
      Boolean(priorHeartbeat && run.worker) &&
      priorHeartbeat.leaseId === run.worker.leaseId &&
      Date.now() < new Date(priorHeartbeat.leaseExpiresAt ?? 0).getTime();
    if (
      run.worker?.status === "running" &&
      run.worker.pid !== process.pid &&
      processIsAlive(run.worker.pid)
    ) {
      throw new Error(
        `Run ${run.id} already has a ${priorIsFresh ? "live" : "stale-but-running"} worker (${run.worker.pid}); cancel it before starting another.`
      );
    }
    run.worker = {
      leaseId: process.env.QUALITY_WORKER_LEASE_ID?.trim() || randomUUID(),
      pid: process.pid,
      processGroupId:
        process.env.QUALITY_DETACHED_WORKER === "1" &&
        process.platform !== "win32"
          ? process.pid
          : null,
      operation,
      status: "running",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs(run)).toISOString(),
      phase: null
    };
    beginDurableAttempt({
      root: qualityRoot,
      runId: run.id,
      leaseId: run.worker.leaseId,
      workerPid: run.worker.pid,
      operation,
      leaseExpiresAt: run.worker.leaseExpiresAt
    });
    saveRun(run);
    writeHeartbeat(run);
    const heartbeat = setInterval(() => {
      try {
        writeHeartbeat(run, currentPhase(run.id));
      } catch (error) {
        console.error(
          `Run ${run.id} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }, run.limits.heartbeatMs);
    heartbeat.unref();
    return {
      run,
      stop(status = "finished") {
        clearInterval(heartbeat);
        clearPhaseProcess(run);
        writeHeartbeat(run, null, status);
        const latest = loadRun(run.id);
        if (latest.worker?.leaseId === run.worker.leaseId) {
          latest.worker.status = status;
          latest.worker.endedAt = new Date().toISOString();
          latest.worker.phase = null;
          saveRun(latest);
        }
        finishDurableAttempt({
          root: qualityRoot,
          runId: run.id,
          leaseId: run.worker.leaseId,
          status,
          error: ["failed", "cancelled"].includes(latest.state)
            ? (latest.timeline?.at(-1)?.detail ?? latest.state)
            : null
        });
      }
    };
  }

  async function withWorkerLease(initialRun, operation, action) {
    const lease = beginWorkerLease(initialRun, operation);
    try {
      return await action(lease.run);
    } finally {
      const latest = loadRun(lease.run.id);
      lease.stop(
        ["failed", "cancelled", "abandoned"].includes(latest.state)
          ? latest.state
          : "completed"
      );
    }
  }

  function redactLog(value) {
    return String(value)
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
      .replace(
        /((?:api[_-]?token|access[_-]?token|secret|password|credential)\s*[:=]\s*)[^\s,"']+/giu,
        "$1[REDACTED]"
      )
      .replace(
        /\b(?:sk|cf|ntn|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
        "[REDACTED_TOKEN]"
      );
  }

  function loadRun(runId) {
    const path = runPath(runId, "run.json");
    if (!existsSync(path)) fail(`Unknown quality run: ${runId}`);
    const run = JSON.parse(readFileSync(path, "utf8"));
    const heartbeat = readJson(runPath(runId, "heartbeat.json"));
    if (heartbeat && run.worker?.leaseId === heartbeat.leaseId) {
      run.worker.heartbeatAt = heartbeat.heartbeatAt;
      run.worker.leaseExpiresAt = heartbeat.leaseExpiresAt;
      run.worker.phase = heartbeat.phase ?? null;
    }
    return run;
  }

  function saveRun(run) {
    const runDirectory = join(runsRoot, run.id);
    mkdirSync(runDirectory, { recursive: true });
    const path = join(runDirectory, "run.json");
    withFileLockSync(join(runDirectory, ".run.lock"), () => {
      const existing = readJson(path);
      const expectedRevision = Number(run.revision ?? 0);
      const actualRevision = Number(existing?.revision ?? 0);
      if (existing && actualRevision !== expectedRevision) {
        throw new Error(
          `Run ${run.id} changed concurrently (expected revision ${expectedRevision}, found ${actualRevision}). Reload it before writing.`
        );
      }
      run.updatedAt = new Date().toISOString();
      run.revision = actualRevision + 1;
      atomicWriteJson(path, run);
    });
    try {
      checkpointRun({
        root: qualityRoot,
        run,
        phase: run.worker?.phase ?? null,
        reason: "run state persisted"
      });
      recordTraceEvent({
        root: qualityRoot,
        runId: run.id,
        traceId: run.traceId,
        type: "run.state.persisted",
        phase: run.worker?.phase ?? null,
        data: { state: run.state, revision: run.revision }
      });
      rebuildRunProjections({ root: qualityRoot, run });
    } catch {
      // The authoritative commit succeeded. Readers repair stale projections by
      // revision; do not rerun an external action because a UI cache write failed.
      console.warn(
        `Run ${run.id} revision ${run.revision} saved; projections need repair.`
      );
    }
    return run;
  }

  function transition(run, next, detail) {
    assertTransition(run.state, next);
    run.timeline.push({
      from: run.state,
      to: next,
      at: new Date().toISOString(),
      detail
    });
    run.state = next;
    return saveRun(run);
  }

  function preflightReviewPolicy({ task, requirements, model }) {
    try {
      return selectReviewerRoutes(
        task,
        requirements,
        readJson(routingPolicyPath, {}),
        model
      );
    } catch (error) {
      fail(
        `Review policy unavailable before implementation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    harnessRoot,
    controllerPackSet,
    qualityRoot,
    runsRoot,
    researchStagingRoot,
    idempotencyRoot,
    routingPolicyPath,
    shortCommandTimeoutMs,
    shortCommandOutputBytes,
    fail,
    parseArgs,
    exec,
    git,
    readJson,
    waitSync,
    withFileLockSync,
    atomicWriteJson,
    runPath,
    contractName,
    loadContract,
    selectRunModel,
    routeLane,
    limitsForLane,
    limitsFromOptions,
    remainingBudgets,
    budgetBlocker,
    phasePath,
    leaseDurationMs,
    writeHeartbeat,
    currentPhase,
    setPhaseProcess,
    clearPhaseProcess,
    beginWorkerLease,
    withWorkerLease,
    redactLog,
    loadRun,
    saveRun,
    transition,
    preflightReviewPolicy
  };
}
