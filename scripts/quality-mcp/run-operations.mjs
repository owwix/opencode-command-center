import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { processIsAlive } from "../quality/run-control.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  managedRunProfiles
} from "../lab/pack-loader.mjs";
import { lookupRegistration } from "../lab/workspace-registry.mjs";
import { labStateRoot } from "../lab/host-state.mjs";
import {
  createDurableRun,
  linkDurableMembers,
  listDurableRuns,
  readDurableRun,
  reconcileDurableRuns,
  updateDurableRun
} from "../quality/run-service.mjs";
import {
  allowedRunActions,
  buildRunView,
  runBelongsToRegistration
} from "../quality/run-view.mjs";
import { buildRunArtifactIndex } from "../quality/run-artifacts.mjs";
import {
  listProjectNotifications,
  syncRunNotifications
} from "../quality/run-notifications.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const controller = join(harnessRoot, "scripts", "quality-controller.mjs");
export const stateRoot = resolve(
  process.env.QUALITY_STATE_ROOT ?? labStateRoot()
);
const runLogsRoot = join(stateRoot, "runs");
export const hostRegistryPath = join(stateRoot, "host-registry.json");
export const packSet = loadPackSet({
  roots: configuredPackRoots({ envFile: join(harnessRoot, "opencode.env") })
});
const profileDefinitions = managedRunProfiles(packSet, {
  ship: { agent: "lab", taskPrefix: "" },
  research: { agent: "research", taskPrefix: "" }
});
export const profiles = Object.freeze(
  Object.fromEntries(
    Object.entries(profileDefinitions).map(([kind, profile]) => [
      kind,
      profile.agent
    ])
  )
);
const launchedWorkers = new Map();
const parallelBatches = new Map();
const PARALLEL_BATCH_TTL_MS = 5 * 60 * 1000;
export const managedKinds = Object.keys(profiles);
export const managedKindSchema = z.enum(managedKinds);
export function registeredPolicy(registrationToken) {
  const registration = lookupRegistration(
    process.env.OPENCODE_LAB_REGISTRY_PATH ?? hostRegistryPath,
    registrationToken
  );
  if (!registration)
    throw new Error("Launch registration is invalid or no longer active.");
  const packs = loadPackSet({ roots: registration.packRoots ?? [] });
  const kinds = managedRunProfiles(packs, {
    ship: { agent: "lab" },
    research: { agent: "research" }
  });
  return {
    registration,
    packSet: packs,
    profiles: Object.fromEntries(
      Object.entries(kinds).map(([kind, value]) => [kind, value.agent])
    )
  };
}
export const limitsSchema = z
  .object({
    implementation_timeout_ms: z.number().positive().optional(),
    verification_timeout_ms: z.number().positive().optional(),
    review_timeout_ms: z.number().positive().optional(),
    max_output_bytes: z.number().positive().optional(),
    max_tokens: z.number().positive().optional(),
    max_cost: z.number().positive().optional(),
    max_tool_calls: z.number().positive().optional()
  })
  .optional();

export function jsonTool(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function allowedRoots() {
  const configured = process.env.QUALITY_WORKSPACE_ROOTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = [harnessRoot];
  return (configured?.length ? configured : defaults)
    .filter(existsSync)
    .map((path) => realpathSync(path));
}

export function resolveAllowedWorkspace(requested, { registrationToken } = {}) {
  const registration = registrationToken
    ? lookupRegistration(
        process.env.OPENCODE_LAB_REGISTRY_PATH ?? hostRegistryPath,
        registrationToken
      )
    : null;
  if (registrationToken && !registration) {
    throw new Error("Launch registration is invalid or no longer active.");
  }
  let hostRequested = requested;
  if (requested === "/workspace") {
    if (!registration) {
      throw new Error("Launch registration is invalid or no longer active.");
    }
    hostRequested = registration.canonicalPath;
  }
  const candidate = realpathSync(resolve(hostRequested));
  // A host-issued registration authorizes exactly its canonical workspace,
  // independently of whichever workspace first started this shared service.
  const roots = registration
    ? [realpathSync(registration.canonicalPath)]
    : allowedRoots();
  const allowed = roots.some(
    (root) =>
      candidate === root ||
      (!registration && candidate.startsWith(`${root}${sep}`))
  );
  if (!allowed)
    throw new Error("Workspace is outside the quality-service allowlist.");
  if (!existsSync(join(candidate, ".git"))) {
    throw new Error("Managed runs require a Git workspace.");
  }
  return candidate;
}

export function parseJsonOutput(output) {
  const objectStart = output.indexOf("{");
  const arrayStart = output.indexOf("[");
  const starts = [objectStart, arrayStart].filter((value) => value >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0)
    throw new Error(`Controller returned no JSON: ${output.trim()}`);
  return JSON.parse(output.slice(start));
}

export function controllerSync(args, environment = {}) {
  const result = spawnSync(process.execPath, [controller, ...args], {
    cwd: harnessRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 2 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "Controller failed").trim()
    );
  }
  return parseJsonOutput(result.stdout);
}

export function controllerDetails(record) {
  if (!record?.controllerRunId) return null;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u.test(record.controllerRunId)) {
      return null;
    }
    const path = join(runLogsRoot, record.controllerRunId, "run.json");
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 * 1024
    ) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function launchExistingRun(runId) {
  const record = readDurableRun({ root: stateRoot, runId });
  if (!record?.controllerRunId) {
    throw new Error(`Run ${runId} has no resumable controller record.`);
  }
  const launched = launchedWorkers.get(record.controllerRunId);
  if (processIsAlive(launched?.pid)) {
    return {
      id: record.id,
      state: record.state,
      processId: launched.pid,
      leaseId: launched.leaseId,
      idempotentReplay: true
    };
  }
  if (launched) launchedWorkers.delete(record.controllerRunId);
  if (
    record.heartbeat?.status === "running" &&
    processIsAlive(record.heartbeat.workerPid)
  ) {
    return {
      id: record.id,
      state: record.state,
      processId: record.heartbeat.workerPid,
      leaseId: record.heartbeat.leaseId,
      idempotentReplay: true
    };
  }
  const runDirectory = join(runLogsRoot, record.controllerRunId);
  mkdirSync(runDirectory, { recursive: true });
  const logFile = join(runDirectory, "orchestrator.log");
  const output = openSync(logFile, "a");
  const leaseId = randomUUID();
  const child = spawn(
    process.execPath,
    [controller, "resume", "--run", record.controllerRunId],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        OPENCODE_LAB_PACKS: (controllerDetails(record)?.packRoots ?? []).join(
          delimiter
        ),
        QUALITY_DETACHED_WORKER: "1",
        QUALITY_WORKER_LEASE_ID: leaseId,
        CI: "1",
        OPENCODE_NON_INTERACTIVE: "1"
      },
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  if (!child.pid) throw new Error(`Could not resume managed run ${runId}.`);
  child.unref();
  launchedWorkers.set(record.controllerRunId, { pid: child.pid, leaseId });
  updateDurableRun({
    root: stateRoot,
    runId: record.id,
    update(current) {
      current.payload = {
        ...current.payload,
        background: {
          pid: child.pid,
          leaseId,
          logFile,
          launchedAt: new Date().toISOString()
        }
      };
      return current;
    }
  });
  child.once("error", () => launchedWorkers.delete(record.controllerRunId));
  child.once("exit", () => {
    if (launchedWorkers.get(record.controllerRunId)?.pid === child.pid) {
      launchedWorkers.delete(record.controllerRunId);
    }
  });
  return {
    id: record.id,
    state: record.state,
    processId: child.pid,
    leaseId,
    idempotentReplay: false
  };
}

export function listRunViews(registration) {
  reconcileDurableRuns({ root: stateRoot });
  return listDurableRuns({ root: stateRoot })
    .filter((record) => runBelongsToRegistration(record, registration))
    .map((record) => {
      const controller = controllerDetails(record);
      const artifactIndex = buildRunArtifactIndex({
        root: stateRoot,
        durable: record,
        controller
      });
      syncRunNotifications({
        root: stateRoot,
        durable: record,
        controller,
        artifactIndex
      });
      return buildRunView({
        durable: record,
        controller,
        artifactIndex,
        notifications: listProjectNotifications({
          root: stateRoot,
          projectId: registration.projectId,
          runId: record.id
        }),
        root: stateRoot
      });
    });
}

export function requireRegisteredRun(runId, registration) {
  const record = readDurableRun({ root: stateRoot, runId });
  if (!record || !runBelongsToRegistration(record, registration)) {
    throw new Error("Managed run is outside this registered project.");
  }
  return record;
}

export function operateRun({ runId, action, input = {}, registration }) {
  const record = requireRegisteredRun(runId, registration);
  const controllerRunId = record.controllerRunId;
  const details = controllerDetails(record);
  const allowed = allowedRunActions(record, details);
  if (!allowed.includes(action)) {
    throw new Error(
      `Run ${runId} does not allow ${action} from state ${record.state}.`
    );
  }
  if (["resume", "retry"].includes(action)) return launchExistingRun(runId);
  if (!controllerRunId) {
    throw new Error(`Run ${runId} does not support the ${action} action.`);
  }
  if (["approve", "reject"].includes(action)) {
    const pendingApprovals = (details?.approvals ?? []).filter(
      (candidate) => candidate.status === "pending"
    );
    const requestedApproval = input.approval_id
      ? String(input.approval_id)
      : null;
    const approval = requestedApproval
      ? pendingApprovals.find((candidate) => candidate.id === requestedApproval)
      : pendingApprovals.length === 1
        ? pendingApprovals[0]
        : null;
    if (!approval) {
      throw new Error(
        pendingApprovals.length > 1
          ? `Run ${runId} requires one explicit approval ID.`
          : `Run ${runId} has no matching pending approval.`
      );
    }
    return controllerSync([
      "approve",
      "--approval",
      approval.id,
      "--decision",
      action === "approve" ? "approved" : "rejected",
      "--actor",
      "tui-operator",
      ...(input.note ? ["--note", String(input.note).slice(0, 500)] : [])
    ]);
  }
  const commands = {
    cancel: ["cancel", "--run", controllerRunId],
    archive: ["archive", "--run", controllerRunId],
    cleanup: ["cleanup", "--run", controllerRunId],
    adopt: ["adopt", "--run", controllerRunId],
    "prepare-pr": ["prepare-pr", "--run", controllerRunId]
  };
  const args = commands[action];
  if (!args) throw new Error(`Unsupported run action: ${action}`);
  return controllerSync(args);
}

export function startManagedRun(
  {
    kind,
    task,
    workspace,
    release = false,
    idempotency_key,
    limits,
    run_kind = "background",
    parent_run_id = null
  },
  { registrationToken } = {}
) {
  const policy = registrationToken
    ? registeredPolicy(registrationToken)
    : { profiles, packSet };
  const packEnvironment = {
    OPENCODE_LAB_PACKS: policy.packSet.packs
      .map(({ root }) => root)
      .join(delimiter)
  };
  const agent = policy.profiles[kind];
  if (!agent) throw new Error(`Unsupported managed-run kind: ${kind}`);
  const source = resolveAllowedWorkspace(workspace, { registrationToken });
  const args = [
    "prepare",
    "--workspace",
    source,
    "--agent",
    agent,
    "--task",
    task
  ];
  if (release) args.push("--release");
  args.push("--run-kind", run_kind);
  if (parent_run_id) args.push("--parent-run-id", parent_run_id);
  if (idempotency_key) args.push("--idempotency-key", idempotency_key);
  const limitArgs = {
    implementation_timeout_ms: "--implementation-timeout-ms",
    verification_timeout_ms: "--verification-timeout-ms",
    review_timeout_ms: "--review-timeout-ms",
    max_output_bytes: "--max-output-bytes",
    max_tokens: "--max-tokens",
    max_cost: "--max-cost",
    max_tool_calls: "--max-tool-calls"
  };
  for (const [name, flag] of Object.entries(limitArgs)) {
    if (limits?.[name] !== undefined) args.push(flag, String(limits[name]));
  }
  const prepared = controllerSync(args, packEnvironment);
  const terminal = [
    "passed",
    "failed",
    "cancelled",
    "abandoned",
    "archived"
  ].includes(prepared.state);
  const launched = launchedWorkers.get(prepared.id);
  const launchedIsAlive = processIsAlive(launched?.pid);
  if (launched && !launchedIsAlive) launchedWorkers.delete(prepared.id);
  if (
    prepared.idempotentReplay &&
    (terminal || processIsAlive(prepared.worker?.pid) || launchedIsAlive)
  ) {
    return {
      ...prepared,
      kind,
      agent,
      processId: prepared.worker?.pid ?? launched?.pid ?? null,
      leaseId: prepared.worker?.leaseId ?? launched?.leaseId ?? null,
      statusCommand: `npm run quality:status -- --run ${prepared.id}`
    };
  }
  const runDirectory = join(runLogsRoot, prepared.id);
  mkdirSync(runDirectory, { recursive: true });
  const output = openSync(join(runDirectory, "orchestrator.log"), "a");
  const leaseId = randomUUID();
  const child = spawn(
    process.execPath,
    [controller, "resume", "--run", prepared.id],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        ...packEnvironment,
        QUALITY_DETACHED_WORKER: "1",
        QUALITY_WORKER_LEASE_ID: leaseId,
        CI: "1",
        OPENCODE_NON_INTERACTIVE: "1"
      },
      detached: true,
      stdio: ["ignore", output, output]
    }
  );
  closeSync(output);
  if (!child.pid) {
    throw new Error(`Could not start managed run ${prepared.id}.`);
  }
  child.unref();
  launchedWorkers.set(prepared.id, { pid: child.pid, leaseId });
  updateDurableRun({
    root: stateRoot,
    runId: prepared.id,
    update(record) {
      record.payload = {
        ...record.payload,
        background: {
          pid: child.pid,
          leaseId,
          logFile: join(runDirectory, "orchestrator.log"),
          launchedAt: new Date().toISOString()
        }
      };
      return record;
    }
  });
  child.once("error", (error) => {
    launchedWorkers.delete(prepared.id);
    console.error(
      `Could not start managed run ${prepared.id}: ${error.message}`
    );
  });
  child.once("exit", () => {
    if (launchedWorkers.get(prepared.id)?.pid === child.pid) {
      launchedWorkers.delete(prepared.id);
    }
  });
  return {
    ...prepared,
    kind,
    agent,
    processId: child.pid,
    leaseId,
    statusCommand: `npm run quality:status -- --run ${prepared.id}`
  };
}

function parallelFingerprint({ workspace, runs }, policy = null) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace,
        policy,
        runs: runs.map(({ kind, task, release = false, limits }) => ({
          kind,
          task,
          release,
          limits: limits ?? null
        }))
      })
    )
    .digest("hex");
}

export function validateParallelRequest(
  { workspace, runs },
  allowedProfiles = profiles
) {
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new Error("Parallel runs require one workspace.");
  }
  if (!Array.isArray(runs) || runs.length < 2 || runs.length > 4) {
    throw new Error("Parallel batches require between 2 and 4 runs.");
  }
  for (const [index, run] of runs.entries()) {
    if (!allowedProfiles[run?.kind]) {
      throw new Error(`Run ${index + 1} has an unsupported kind.`);
    }
    if (
      typeof run.task !== "string" ||
      run.task.trim().length < 4 ||
      run.task.length > 4000
    ) {
      throw new Error(`Run ${index + 1} requires a concrete task.`);
    }
  }
  return { workspace, runs };
}

export function startParallelRuns(
  input,
  {
    starter = (run) => startManagedRun(run, { registrationToken }),
    registrationToken,
    now = Date.now,
    root = stateRoot
  } = {}
) {
  const policy = registrationToken ? registeredPolicy(registrationToken) : null;
  const request = validateParallelRequest(input, policy?.profiles ?? profiles);
  if (registrationToken)
    request.workspace = resolveAllowedWorkspace(request.workspace, {
      registrationToken
    });
  const fingerprint = parallelFingerprint(
    request,
    policy?.packSet.packs.map(({ root }) => root) ?? null
  );
  const currentTime = now();
  for (const [key, batch] of parallelBatches) {
    if (currentTime - batch.createdAt >= PARALLEL_BATCH_TTL_MS) {
      parallelBatches.delete(key);
    }
  }
  const cached = parallelBatches.get(fingerprint);
  if (cached && currentTime - cached.createdAt < PARALLEL_BATCH_TTL_MS) {
    return { ...cached.result, idempotentReplay: true };
  }
  const durableReplay = listDurableRuns({ root, kind: "parallel" }).find(
    (record) =>
      record.payload?.fingerprint === fingerprint &&
      currentTime - new Date(record.createdAt).getTime() < PARALLEL_BATCH_TTL_MS
  );
  if (durableReplay?.payload?.result) {
    return { ...durableReplay.payload.result, idempotentReplay: true };
  }
  const batchId = `parallel_${randomUUID()}`;
  createDurableRun({
    root,
    id: batchId,
    kind: "parallel",
    state: "queued",
    task: `Parallel batch with ${request.runs.length} managed runs`,
    source: request.workspace,
    controllerRunId: null,
    maxAttempts: 1,
    payload: {
      fingerprint,
      definitions: request.runs.map(({ kind, task, release = false }) => ({
        kind,
        task,
        release
      }))
    }
  });
  const started = [];
  const failures = [];
  for (const [index, run] of request.runs.entries()) {
    try {
      started.push(
        starter({
          ...run,
          workspace: request.workspace,
          run_kind: "individual",
          parent_run_id: batchId,
          idempotency_key: `parallel:${batchId}:${index + 1}:${run.kind}`
        })
      );
    } catch (error) {
      failures.push({
        index,
        kind: run.kind,
        task: run.task,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const result = {
    batchId,
    state:
      failures.length === 0
        ? "started"
        : started.length > 0
          ? "partially-started"
          : "failed",
    workspace: request.workspace,
    runs: started,
    failures,
    statusCommands: started.map((run) => run.statusCommand)
  };
  linkDurableMembers({
    root,
    runId: batchId,
    memberIds: started.map((run) => run.id),
    payload: { fingerprint, result }
  });
  updateDurableRun({
    root,
    runId: batchId,
    update(record) {
      record.state = failures.length === 0 ? "running" : "failed";
      record.phase = failures.length === 0 ? "coordination" : "terminal";
      return record;
    }
  });
  parallelBatches.set(fingerprint, { createdAt: currentTime, result });
  return result;
}
