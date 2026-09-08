#!/usr/bin/env node

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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { inferRequirements, summarizeRuns } from "./quality-lib.mjs";
import {
  inferRouteEnvelope,
  validateRouteEnvelope
} from "./quality/routing-envelope.mjs";
import {
  checkpointRun,
  claimJob,
  enqueueJob,
  finishJob,
  listApprovals,
  listJobs,
  putMemory,
  readTrace,
  replayCheckpoint,
  retryJob,
  resolveApproval,
  searchMemory
} from "./quality/durable-state.mjs";
import { synthesizeParallel } from "./quality/parallel-synthesis.mjs";
import {
  linkDurableMembers,
  readDurableRun,
  reconcileDurableRuns,
  updateDurableRun
} from "./quality/run-service.mjs";
import { pruneRunArtifactCache } from "./quality/run-artifacts.mjs";
import { summarizeOperationalMetrics } from "./quality/run-outcomes.mjs";
import { createControllerRuntime } from "./quality/controller-runtime.mjs";
import { createPreparationOperations } from "./quality/controller-prepare.mjs";
import { createImplementationOperations } from "./quality/controller-implementation.mjs";
import { createLifecycleOperations } from "./quality/controller-lifecycle.mjs";
import { createArtifactOperations } from "./quality/controller-artifacts.mjs";
import { createProcessOperations } from "./quality/controller-process.mjs";
import { controllerPorts } from "./quality/controller-ports.mjs";
const runtime = createControllerRuntime();
const {
  qualityRoot,
  runsRoot,
  researchStagingRoot,
  idempotencyRoot,
  fail,
  parseArgs,
  runPath,
  selectRunModel,
  withWorkerLease,
  loadRun,
  saveRun
} = runtime;

const { prepare } = createPreparationOperations(
  controllerPorts("prepare", runtime)
);

const implementation = createImplementationOperations(
  controllerPorts("implementation", runtime)
);

const artifacts = createArtifactOperations(
  controllerPorts("artifacts", runtime, implementation)
);
const { adopt, finalize, gate, listRuns, preparePr, recordArtifacts, status } =
  artifacts;
const lifecycleOperations = createLifecycleOperations(
  controllerPorts("lifecycle", runtime, implementation, artifacts, { prepare })
);
const { execute, review, verify } = lifecycleOperations;

const { abandon, archive, cancelRun, cleanup, resume, setRunExitCode } =
  createProcessOperations(
    controllerPorts("process", runtime, implementation, lifecycleOperations)
  );

function metrics(options) {
  const runs = listRuns();
  const result = summarizeRuns(runs, {
    staleHours: Number(options.stale_hours ?? 24)
  });
  console.log(
    JSON.stringify(
      { ...result, operational: summarizeOperationalMetrics(runs) },
      null,
      2
    )
  );
}

function retention(options) {
  if (!options.run) fail("retention requires --run ID.");
  const durable = readDurableRun({ root: qualityRoot, runId: options.run });
  if (!durable) fail(`Unknown quality run: ${options.run}`);
  const result = pruneRunArtifactCache({
    root: qualityRoot,
    durable,
    retentionDays:
      options.days ?? process.env.QUALITY_ARTIFACT_RETENTION_DAYS ?? 30
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseJsonOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(
      `Invalid JSON value: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function checkpoint(options) {
  const run = loadRun(options.run);
  const record = checkpointRun({
    root: qualityRoot,
    run,
    phase: options.phase ?? run.worker?.phase ?? null,
    reason: options.reason ?? "operator checkpoint"
  });
  console.log(JSON.stringify(record, null, 2));
}

function replay(options) {
  if (!options.run || !options.sequence)
    fail("replay requires --run and --sequence.");
  console.log(
    JSON.stringify(
      replayCheckpoint({
        root: qualityRoot,
        runId: options.run,
        sequence: options.sequence
      }),
      null,
      2
    )
  );
}

function approvals(options) {
  console.log(
    JSON.stringify(
      listApprovals({
        root: qualityRoot,
        runId: options.run ?? null,
        status: options.status ?? null
      }),
      null,
      2
    )
  );
}

function approve(options) {
  if (!options.approval || !options.decision)
    fail("approve requires --approval ID and --decision approved|rejected.");
  const record = resolveApproval({
    root: qualityRoot,
    approvalId: options.approval,
    decision: options.decision,
    actor: options.actor ?? process.env.USER ?? "operator",
    note: options.note ?? ""
  });
  const runPathname = runPath(record.runId, "run.json");
  if (existsSync(runPathname)) {
    const run = loadRun(record.runId);
    run.approvals = listApprovals({
      root: qualityRoot,
      runId: record.runId
    }).map((approval) => ({
      id: approval.id,
      status: approval.status,
      phase: approval.phase,
      requestedAt: approval.requestedAt,
      resolvedAt: approval.resolvedAt
    }));
    saveRun(run);
  }
  console.log(JSON.stringify(record, null, 2));
}

function queueCommand(options) {
  const action = options.action ?? "list";
  let result;
  if (action === "enqueue") {
    result = enqueueJob({
      root: qualityRoot,
      kind: options.kind,
      payload: parseJsonOption(options.payload, {}),
      priority: options.priority,
      dedupeKey: options.dedupe_key ?? null,
      maxAttempts: options.max_attempts
    });
  } else if (action === "claim") {
    result = claimJob({
      root: qualityRoot,
      workerId: options.worker ?? `worker_${process.pid}`
    });
  } else if (action === "complete" || action === "fail") {
    if (!options.job) fail(`queue ${action} requires --job ID.`);
    result = finishJob({
      root: qualityRoot,
      jobId: options.job,
      status: action === "complete" ? "completed" : "failed",
      error: options.error ?? null
    });
  } else if (action === "retry") {
    if (!options.job) fail("queue retry requires --job ID.");
    result = retryJob({ root: qualityRoot, jobId: options.job });
  } else if (action === "list") {
    result = listJobs({ root: qualityRoot, status: options.status ?? null });
  } else {
    fail(`Unknown queue action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function memoryCommand(options) {
  const action = options.action ?? "search";
  const workspace = resolve(options.workspace ?? process.cwd());
  let result;
  if (action === "put") {
    result = putMemory({
      root: qualityRoot,
      workspace,
      text: options.text,
      source: options.source ?? "operator",
      tags: parseJsonOption(
        options.tags,
        String(options.tags ?? "")
          .split(",")
          .filter(Boolean)
      )
    });
  } else if (action === "search") {
    result = searchMemory({
      root: qualityRoot,
      workspace,
      query: options.query ?? "",
      limit: options.limit
    });
  } else {
    fail(`Unknown memory action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function trace(options) {
  if (!options.run) fail("trace requires --run ID.");
  console.log(
    JSON.stringify(
      readTrace({ root: qualityRoot, runId: options.run }),
      null,
      2
    )
  );
}

function parallel(options) {
  const result = synthesizeParallel({
    root: qualityRoot,
    groupId: options.group,
    runIds: options.member
  });
  if (readDurableRun({ root: qualityRoot, runId: options.group })) {
    linkDurableMembers({
      root: qualityRoot,
      runId: options.group,
      memberIds: result.runIds,
      payload: { synthesis: result }
    });
    updateDurableRun({
      root: qualityRoot,
      runId: options.group,
      update(record) {
        record.state =
          result.status === "ready"
            ? "passed"
            : result.status === "incomplete"
              ? "running"
              : "failed";
        record.phase =
          result.status === "incomplete" ? "coordination" : "terminal";
        return record;
      }
    });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "ready") process.exitCode = 1;
}

function stageResearch(options) {
  const run = loadRun(options.run);
  const input = resolve(run.workspace, options.file ?? "");
  const workspacePrefix = `${resolve(run.workspace)}/`;
  if (
    !options.file ||
    (!input.startsWith(workspacePrefix) && input !== resolve(run.workspace))
  ) {
    fail("--file must identify a file inside the managed worktree.");
  }
  if (!existsSync(input) || !statSync(input).isFile()) {
    fail(`Research deliverable not found: ${input}`);
  }
  mkdirSync(researchStagingRoot, { recursive: true });
  const stagedPath = join(researchStagingRoot, `${run.id}.md`);
  const body = readFileSync(input, "utf8");
  writeFileSync(
    stagedPath,
    [
      "---",
      `run: ${run.id}`,
      `source: ${JSON.stringify(input)}`,
      `target: ${JSON.stringify(options.target ?? null)}`,
      `staged_at: ${new Date().toISOString()}`,
      "approved: false",
      "---",
      "",
      body
    ].join("\n")
  );
  run.research = {
    stagedPath,
    source: input,
    target: options.target ?? null,
    stagedAt: new Date().toISOString(),
    approvedAt: null,
    publishedAt: null
  };
  saveRun(run);
  console.log(JSON.stringify(run.research, null, 2));
}

function approveResearch(options) {
  const run = loadRun(options.run);
  if (!run.research?.stagedPath)
    fail("This run has no staged research deliverable.");
  run.research.approvedAt = new Date().toISOString();
  saveRun(run);
  console.log(
    JSON.stringify(
      {
        ...run.research,
        note: "Approval records readiness only; publishing to Notion remains a separate authorized action."
      },
      null,
      2
    )
  );
}

function route(options) {
  const agent = options.agent ?? "lab";
  const task = options.task ?? "";
  const model = selectRunModel(agent, task, options.model);
  const requirements = inferRequirements([], task);
  const routeEnvelope = validateRouteEnvelope(
    inferRouteEnvelope({ agent, task, requirements, model })
  );
  console.log(
    JSON.stringify(
      { agent, task, model, requirements, route: routeEnvelope },
      null,
      2
    )
  );
}

function help() {
  console.log(`OpenCode Command Center quality controller

Commands:
  run       --workspace PATH --task TEXT [--agent NAME] [--verify COMMAND] [--release]
  prepare   --workspace PATH --task TEXT [--agent NAME]
  resume    --run ID
  finalize  --run ID
  verify    --run ID
  review    --run ID
  status    [--run ID]
  artifacts --run ID [--manifest PATH] [--artifact PATH] [--migration-plan PATH]
  gate      --run ID
  adopt     --run ID
  prepare-pr --run ID [--title TEXT] [--body TEXT] [--base main]
  cancel    --run ID [--reason TEXT]
  abandon   --run ID [--reason TEXT]
  archive   --run ID
  cleanup   --run ID
  metrics   [--stale-hours NUMBER]
  retention --run ID [--days NUMBER]
  checkpoint --run ID [--phase NAME] [--reason TEXT]
  replay    --run ID --sequence NUMBER
  approvals [--run ID] [--status pending|approved|rejected]
  approve   --approval ID --decision approved|rejected [--note TEXT]
  trace     --run ID
  queue     --action list|enqueue|claim|complete|fail|retry [queue options]
  memory    --action put|search --workspace PATH [memory options]
  parallel  --group ID --member RUN_ID --member RUN_ID [...]
  route     --agent NAME --task TEXT
  research-stage   --run ID --file PATH [--target NOTION_PAGE]
  research-approve --run ID

The source worktree must be clean unless --allow-dirty-source is supplied. Dirty
source changes are never copied into the isolated run. Cleanup never deletes a
branch or a dirty worktree. Managed runs accept --idempotency-key plus bounded
--implementation-timeout-ms, --verification-timeout-ms, --review-timeout-ms,
--max-output-bytes, --max-tokens, --max-cost, --max-tool-calls, and
--max-attempts values. Controller adapters may also supply --run-kind and
--parent-run-id to join detached, parallel, and fleet work to the same durable
run graph.
Time and output limits are hard process boundaries. Usage budgets are enforced
live and at completion when provider JSONL includes usage; missing telemetry is
recorded as unavailable and is never treated as proof of zero usage.`);
}

mkdirSync(runsRoot, { recursive: true });
mkdirSync(idempotencyRoot, { recursive: true });
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "help") reconcileDurableRuns({ root: qualityRoot });
  if (options.command === "run") setRunExitCode(await execute(options));
  else if (options.command === "prepare") prepare(options);
  else if (options.command === "resume") setRunExitCode(await resume(options));
  else if (options.command === "finalize") finalize(options);
  else if (options.command === "verify") {
    const run = loadRun(options.run);
    setRunExitCode(
      await withWorkerLease(run, "verify", (leasedRun) => verify(leasedRun))
    );
  } else if (options.command === "review") {
    const run = loadRun(options.run);
    setRunExitCode(
      await withWorkerLease(run, "review", (leasedRun) => review(leasedRun))
    );
  } else if (options.command === "status") status(options);
  else if (options.command === "artifacts")
    await recordArtifacts(options, { verify, review });
  else if (options.command === "gate") gate(options);
  else if (options.command === "adopt") adopt(options);
  else if (options.command === "prepare-pr") preparePr(options);
  else if (options.command === "cancel") await cancelRun(options);
  else if (options.command === "abandon") await abandon(options);
  else if (options.command === "archive") archive(options);
  else if (options.command === "cleanup") cleanup(options);
  else if (options.command === "metrics") metrics(options);
  else if (options.command === "retention") retention(options);
  else if (options.command === "checkpoint") checkpoint(options);
  else if (options.command === "replay") replay(options);
  else if (options.command === "approvals") approvals(options);
  else if (options.command === "approve") approve(options);
  else if (options.command === "trace") trace(options);
  else if (options.command === "queue") queueCommand(options);
  else if (options.command === "memory") memoryCommand(options);
  else if (options.command === "parallel") parallel(options);
  else if (options.command === "route") route(options);
  else if (options.command === "research-stage") stageResearch(options);
  else if (options.command === "research-approve") approveResearch(options);
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
