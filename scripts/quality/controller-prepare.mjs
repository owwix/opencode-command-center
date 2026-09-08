import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildBranchName,
  createRunId,
  inferRequirements,
  workspaceLabel
} from "../quality-lib.mjs";
import { buildContextPack } from "./context-pack.mjs";
import { mergeTelemetry } from "./phase-telemetry.mjs";
import {
  inferRouteEnvelope,
  validateRouteEnvelope
} from "./routing-envelope.mjs";
import { validateModelRegistry } from "./model-registry.mjs";
import { searchMemory, workspacePolicy } from "./durable-state.mjs";
import { DURABLE_RUN_KINDS, readDurableRun } from "./run-service.mjs";

export function createPreparationOperations(runtime) {
  const {
    atomicWriteJson,
    controllerPackSet,
    exec,
    fail,
    git,
    harnessRoot,
    idempotencyRoot,
    limitsForLane,
    limitsFromOptions,
    loadContract,
    loadRun,
    preflightReviewPolicy,
    qualityRoot,
    readJson,
    routingPolicyPath,
    runPath,
    saveRun,
    selectRunModel,
    withFileLockSync
  } = runtime;
  void controllerPackSet;

  function prepareNew(options) {
    const registry = validateModelRegistry({
      routingPolicy: routingPolicyPath,
      openCodeConfig: join(harnessRoot, "opencode.json")
    });
    if (!registry.passed) {
      fail(`Model registry is invalid: ${registry.errors.join("; ")}`);
    }
    const source = resolve(options.workspace ?? process.cwd());
    if (!existsSync(join(source, ".git")))
      fail(`${source} is not a Git workspace.`);
    const operatorRoots = (process.env.QUALITY_WORKSPACE_ROOTS ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .map((value) => value.trim())
      .filter(Boolean);
    const policy = workspacePolicy({
      workspace: source,
      operator: process.env.USER ?? process.env.USERNAME ?? "operator",
      roots: operatorRoots
    });
    const runKind = options.run_kind?.trim() || "individual";
    if (!DURABLE_RUN_KINDS.includes(runKind)) {
      fail(`--run-kind must be one of: ${DURABLE_RUN_KINDS.join(", ")}.`);
    }
    const parentRunId = options.parent_run_id?.trim() || null;
    if (parentRunId) {
      const parent = readDurableRun({ root: qualityRoot, runId: parentRunId });
      if (!parent) fail(`Unknown parent durable run: ${parentRunId}`);
      if (parent.git?.source && resolve(parent.git.source) !== source) {
        fail(
          "Parent and child durable runs must belong to the same workspace."
        );
      }
    }
    const sourceStatus = git(source, ["status", "--porcelain=v1"]);
    if (sourceStatus && !options.allow_dirty_source) {
      fail(
        "Source worktree is dirty. Commit/stash it, or pass --allow-dirty-source to isolate from HEAD and leave those changes behind."
      );
    }
    const task = options.task?.trim();
    if (!task) fail("--task is required.");
    const agent = options.agent?.trim() || "lab";
    const model = selectRunModel(agent, task, options.model);
    const initialRequirements = inferRequirements([], task);
    const routeEnvelope = validateRouteEnvelope(
      inferRouteEnvelope({
        agent,
        task,
        requirements: initialRequirements,
        model
      })
    );
    if (!options.skip_review) {
      preflightReviewPolicy({ task, requirements: initialRequirements, model });
    }
    const baseRef = options.base?.trim() || "HEAD";
    const baseSha = git(source, ["rev-parse", baseRef]);
    const id = createRunId();
    const branch = buildBranchName(agent, task, id);
    const worktreeParent = resolve(
      options.worktree_root ??
        join(dirname(source), ".opencode-worktrees", workspaceLabel(source))
    );
    const workspace = join(worktreeParent, id);
    mkdirSync(worktreeParent, { recursive: true });
    exec(
      "git",
      ["-C", source, "worktree", "add", "-b", branch, workspace, baseSha],
      { capture: false }
    );
    const contextPack = buildContextPack({
      agent,
      task,
      paths: git(source, ["ls-files"]).split("\n").filter(Boolean)
    });
    const memory = searchMemory({
      root: qualityRoot,
      workspace: source,
      query: task
    });
    const run = saveRun({
      packRoots: controllerPackSet.packs.map(({ root }) => root),
      schemaVersion: 2,
      revision: 0,
      id,
      createdAt: new Date().toISOString(),
      traceId: `trace_${randomUUID().replaceAll("-", "")}`,
      state: "prepared",
      runKind,
      parentRunId,
      memberRunIds: [],
      maxAttempts: Math.max(1, Math.min(10, Number(options.max_attempts) || 3)),
      task,
      agent,
      model,
      route: routeEnvelope,
      contract: loadContract(agent),
      source,
      workspacePolicy: policy,
      workspace,
      branch,
      baseRef,
      baseSha,
      headSha: baseSha,
      clean: true,
      idempotency: options.idempotency_key
        ? {
            keyHash: createHash("sha256")
              .update(options.idempotency_key)
              .digest("hex"),
            fingerprint: options.idempotency_fingerprint
          }
        : null,
      limits: limitsFromOptions(options, model),
      reviewLimits: limitsForLane("review", options),
      limitEnforcement: {
        timeAndOutput: "hard process boundary",
        tokenCostAndToolCalls:
          "live and terminal enforcement when OpenCode/provider JSONL reports usage; unavailable usage is recorded, never inferred as zero-cost proof"
      },
      worker: null,
      releaseRequested: Boolean(options.release),
      changedFiles: [],
      requirements: initialRequirements,
      contextPack,
      memory,
      commands: options.verify,
      artifacts: {
        visual: options.artifact,
        migrationPlan: null,
        manifest: null,
        contractEvidence: null
      },
      verification: null,
      implementationResult: null,
      implementationCheckpoint: null,
      review: null,
      adoption: null,
      publishing: null,
      telemetry: mergeTelemetry(),
      implementationTelemetry: mergeTelemetry(),
      reviewTelemetry: mergeTelemetry(),
      research: null,
      approvals: [],
      timeline: [
        {
          from: null,
          to: "prepared",
          at: new Date().toISOString(),
          detail: "isolated worktree created"
        }
      ]
    });
    atomicWriteJson(runPath(id, "context-pack.json"), contextPack);
    return run;
  }

  function prepare(options) {
    const key = options.idempotency_key?.trim();
    if (key && (key.length < 8 || key.length > 200)) {
      fail("--idempotency-key must contain between 8 and 200 characters.");
    }
    const normalized = {
      packRoots: controllerPackSet.packs.map(({ root }) => root),
      workspace: resolve(options.workspace ?? process.cwd()),
      task: options.task?.trim() ?? "",
      agent: options.agent?.trim() || "lab",
      base: options.base?.trim() || "HEAD",
      release: Boolean(options.release),
      runKind: options.run_kind?.trim() || "individual",
      parentRunId: options.parent_run_id?.trim() || null,
      maxAttempts: Math.max(1, Math.min(10, Number(options.max_attempts) || 3)),
      model: options.model?.trim() || null,
      verify: options.verify ?? [],
      artifact: options.artifact ?? [],
      limits: limitsFromOptions(
        options,
        selectRunModel(
          options.agent?.trim() || "lab",
          options.task?.trim() ?? "",
          options.model
        )
      )
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    let run;
    let idempotentReplay = false;
    if (key) {
      const keyHash = createHash("sha256").update(key).digest("hex");
      const recordPath = join(idempotencyRoot, `${keyHash}.json`);
      run = withFileLockSync(`${recordPath}.lock`, () => {
        const existing = readJson(recordPath);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new Error(
              "This idempotency key was already used for a different managed-run request."
            );
          }
          if (!existsSync(runPath(existing.runId, "run.json"))) {
            throw new Error(
              `Idempotency record references missing run ${existing.runId}.`
            );
          }
          idempotentReplay = true;
          return loadRun(existing.runId);
        }
        const created = prepareNew({
          ...options,
          idempotency_key: key,
          idempotency_fingerprint: fingerprint
        });
        atomicWriteJson(recordPath, {
          keyHash,
          fingerprint,
          runId: created.id,
          createdAt: new Date().toISOString()
        });
        return created;
      });
    } else {
      run = prepareNew(options);
    }
    Object.defineProperty(run, "idempotentReplay", {
      value: idempotentReplay,
      enumerable: false
    });
    console.log(
      JSON.stringify(
        {
          id: run.id,
          workspace: run.workspace,
          branch: run.branch,
          state: run.state,
          worker: run.worker,
          idempotentReplay
        },
        null,
        2
      )
    );
    return run;
  }

  return { prepare, prepareNew };
}
