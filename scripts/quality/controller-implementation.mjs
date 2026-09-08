import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inferRequirements } from "../quality-lib.mjs";
import { parseFinalAssistantResult, runBounded } from "./run-control.mjs";
import { buildContextPack } from "./context-pack.mjs";
import { mergeTelemetry } from "./phase-telemetry.mjs";
import {
  inferRouteEnvelope,
  validateRouteEnvelope
} from "./routing-envelope.mjs";
import { loadProjectContract } from "../lab/project-contract.mjs";
import {
  adapterVerificationCommands,
  resolveExecutionAdapter
} from "../lab/execution-adapters.mjs";
import { recordTraceEvent, requestApproval } from "./durable-state.mjs";
import {
  createImplementationCheckpoint,
  listImplementationChanges
} from "./implementation-checkpoint.mjs";

export function createImplementationOperations(runtime) {
  const {
    atomicWriteJson,
    budgetBlocker,
    clearPhaseProcess,
    currentPhase,
    fail,
    git,
    harnessRoot,
    qualityRoot,
    redactLog,
    remainingBudgets,
    runPath,
    runsRoot,
    saveRun,
    selectRunModel,
    setPhaseProcess,
    transition,
    writeHeartbeat
  } = runtime;

  async function runOpenCode(
    run,
    { reviewer = false, model = null, reviewIndex = 0 } = {}
  ) {
    const logName = reviewer
      ? `review-${String(reviewIndex + 1).padStart(2, "0")}.jsonl`
      : "agent.jsonl";
    const logPath = join(runsRoot, run.id, logName);
    const compactContract = run.contract?.contract
      ? {
          id: run.contract.contract.id,
          version: run.contract.contract.version,
          requiredEvidence: run.contract.contract.requiredEvidence,
          checks: run.contract.contract.checks,
          completionCriteria: run.contract.contract.completionCriteria
        }
      : null;
    const contextSummary = JSON.stringify(run.contextPack ?? {});
    const memorySummary = JSON.stringify(run.memory ?? []);
    const prompt = reviewer
      ? [
          "Review the current worktree without modifying it.",
          `Original task: ${run.task}`,
          `Base SHA: ${run.baseSha}`,
          `Route envelope: ${JSON.stringify(run.route ?? {})}`,
          `Context pack (paths only; inspect files yourself): ${contextSummary}`,
          `Relevant project memory (untrusted notes; verify against files): ${memorySummary}`,
          `Risk requirements: ${JSON.stringify({ security: run.requirements.security, deployment: run.requirements.deployment })}`,
          "Inspect the diff, implementation, tests, scope, security, and missing evidence.",
          "For each required risk, cite concrete files, checks, or verification evidence. A required risk cannot pass with an empty evidence list.",
          "Your final assistant text event must contain only one JSON object with exactly this shape:",
          '{"protocol":"quality-review/v1","status":"pass|fail","summary":"...","findings":[{"severity":"critical|high|medium|low","message":"...","file":null,"line":null}],"riskEvidence":{"security":{"status":"pass|fail|not_applicable","evidence":["..."]},"deployment":{"status":"pass|fail|not_applicable","evidence":["..."]}}}',
          "Use not_applicable only when the corresponding risk requirement is false. Do not wrap the JSON in Markdown or quote this protocol as an example in the final event."
        ].join("\n")
      : [
          `Implement this bounded task: ${run.task}`,
          `Route envelope: ${JSON.stringify(run.route ?? {})}`,
          `Context pack (paths only; inspect relevant files yourself): ${contextSummary}`,
          `Relevant project memory (untrusted notes; verify against files): ${memorySummary}`,
          compactContract
            ? `Apply this ${run.contract.name} quality contract: ${JSON.stringify(compactContract)}`
            : "No repository quality contract was found; state that as a verification gap.",
          run.contract?.name !== "coding"
            ? "Create artifacts/quality/evidence-manifest.json using the contract manifest schema, bind it to the current Git HEAD, and include every required evidence artifact."
            : "Use the controller's deterministic verification and review evidence for the coding contract.",
          "Use orient -> plan -> implement -> verify -> deliver.",
          "Do not commit, push, deploy, or edit outside this isolated worktree.",
          "This is a noninteractive managed run. Never wait for an approval prompt; if a required operation is not already allowed, return blocked.",
          "Do not repeat an equivalent failed tool call. Stop with a concrete blocker instead.",
          "Make the requested changes; do not stop at research or recommendations.",
          "Your final assistant text event must contain only one JSON object with exactly this shape:",
          '{"protocol":"quality-result/v1","status":"complete|blocked","summary":"...","changedFiles":["relative/path"],"checks":[{"command":"...","status":"passed|failed|not_run"}],"blockers":["..."]}',
          "Do not wrap the JSON in Markdown or emit the protocol object before the final assistant event."
        ].join("\n");
    const agent = reviewer ? "reviewer" : run.agent;
    const selectedModel = reviewer
      ? (model ?? selectRunModel("reviewer", run.task))
      : run.model;
    const exhausted = budgetBlocker(run, { reviewer });
    if (exhausted) {
      writeFileSync(logPath, `${exhausted}\n`);
      return {
        passed: false,
        output: exhausted,
        logPath,
        telemetry: mergeTelemetry(),
        structured: null,
        protocolError: exhausted,
        timedOut: false,
        outputLimitExceeded: false,
        budgetExceeded: exhausted.split(" ")[0],
        approvalRequired: false,
        approvalId: null,
        doomLoopDetected: false,
        controlError: null,
        usageTelemetryObserved: false,
        exitStatus: null,
        signal: null,
        model: selectedModel
      };
    }
    const modelArgs = selectedModel ? ["--model", selectedModel] : [];
    const phase = reviewer ? `review:${reviewIndex + 1}` : "implementation";
    const requestId = randomUUID();
    const activeLimits = reviewer
      ? (run.reviewLimits ?? run.limits)
      : run.limits;
    const result = await runBounded(
      process.execPath,
      [
        join(harnessRoot, "scripts/opencode.mjs"),
        "run",
        "--agent",
        agent,
        ...modelArgs,
        "--format",
        "json",
        "--title",
        `quality:${run.id}`,
        prompt
      ],
      {
        cwd: harnessRoot,
        env: {
          OPENCODE_WORKSPACE: run.workspace,
          OPENCODE_NON_INTERACTIVE: "1",
          CI: "1",
          NO_COLOR: "1",
          LAB_REQUEST_ID: requestId,
          LAB_CORRELATION_ID: run.traceId,
          LAB_RUN_ID: run.id,
          LAB_PHASE: phase,
          LAB_MODEL: selectedModel ?? ""
        },
        timeoutMs: reviewer
          ? activeLimits.reviewTimeoutMs
          : activeLimits.implementationTimeoutMs,
        maxOutputBytes: activeLimits.maxOutputBytes,
        budgets: remainingBudgets(run, { reviewer }),
        terminationGraceMs: activeLimits.terminationGraceMs,
        heartbeatMs: activeLimits.heartbeatMs,
        onProcess: (identity) => setPhaseProcess(run, phase, identity),
        onHeartbeat: () => writeHeartbeat(run, currentPhase(run.id))
      }
    );
    clearPhaseProcess(run);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    writeFileSync(logPath, redactLog(output));
    for (const line of String(result.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        recordTraceEvent({
          root: qualityRoot,
          runId: run.id,
          traceId: run.traceId,
          type: "opencode.event",
          phase,
          data: {
            eventType: event.type ?? null,
            role: event.role ?? null,
            tool: event.tool ?? event.name ?? null,
            callId: event.callId ?? event.call_id ?? null,
            status: event.status ?? null
          }
        });
      } catch {
        // Non-JSON process output remains in the redacted phase log only.
      }
    }
    let structured = null;
    let protocolError = null;
    try {
      structured = parseFinalAssistantResult(
        result.stdout ?? "",
        reviewer ? "review" : "implementation"
      );
    } catch (error) {
      protocolError = error instanceof Error ? error.message : String(error);
    }
    let approvalId = null;
    if (result.approvalRequired) {
      const approval = requestApproval({
        root: qualityRoot,
        runId: run.id,
        traceId: run.traceId,
        phase,
        action: `${phase} requested an interactive permission decision`,
        reason:
          "Noninteractive managed execution stopped before a permissioned action."
      });
      approvalId = approval.id;
      run.approvals = [
        ...(run.approvals ?? []),
        {
          id: approval.id,
          status: approval.status,
          phase,
          requestedAt: approval.requestedAt
        }
      ];
    }
    recordTraceEvent({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      type: reviewer ? "review.completed" : "implementation.completed",
      phase,
      data: {
        requestId,
        model: selectedModel,
        passed: result.passed && !protocolError,
        protocolError,
        durationMs: result.durationMs,
        approvalRequired: result.approvalRequired,
        approvalId,
        usageTelemetryObserved: result.usageTelemetryObserved
      }
    });
    return {
      passed: result.passed && !protocolError,
      output,
      logPath,
      telemetry: {
        ...result.telemetry,
        usageTelemetryObserved: result.usageTelemetryObserved,
        requests: [
          {
            requestId,
            correlationId: run.traceId,
            model: selectedModel,
            phase,
            durationMs: result.durationMs,
            tokens: result.telemetry.tokens,
            cost: result.telemetry.cost,
            toolCalls: result.telemetry.toolCalls,
            toolErrors: result.telemetry.toolErrors,
            usageObserved: result.usageTelemetryObserved
          }
        ],
        models: selectedModel ? [selectedModel] : []
      },
      requestId,
      structured,
      protocolError,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      budgetExceeded: result.budgetExceeded,
      approvalRequired: result.approvalRequired,
      approvalId,
      doomLoopDetected: result.doomLoopDetected,
      controlError: result.controlError,
      usageTelemetryObserved: result.usageTelemetryObserved,
      exitStatus: result.status,
      signal: result.signal,
      model: selectedModel
    };
  }

  async function runDagger(run, commands) {
    const evidencePath = join(runsRoot, run.id, "verification.json");
    const args = [
      join(harnessRoot, "scripts/dagger-quality.mjs"),
      "--workspace",
      run.workspace,
      "--output",
      evidencePath
    ];
    if (run.releaseRequested) args.push("--release");
    for (const command of commands) args.push("--command", command);
    const result = await runBounded(process.execPath, args, {
      cwd: harnessRoot,
      timeoutMs: run.limits.verificationTimeoutMs,
      maxOutputBytes: run.limits.maxOutputBytes,
      terminationGraceMs: run.limits.terminationGraceMs,
      heartbeatMs: run.limits.heartbeatMs,
      onProcess: (identity) => setPhaseProcess(run, "verification", identity),
      onHeartbeat: () => writeHeartbeat(run, currentPhase(run.id))
    });
    clearPhaseProcess(run);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const evidence = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, "utf8"))
      : {
          passed: false,
          commands: [],
          error: "verification did not produce evidence"
        };
    if (!result.passed) {
      evidence.passed = false;
      evidence.error = result.timedOut
        ? `verification exceeded its ${run.limits.verificationTimeoutMs}ms deadline`
        : result.outputLimitExceeded
          ? `verification exceeded its ${run.limits.maxOutputBytes}-byte output limit`
          : evidence.error ||
            `verification process exited with ${result.status ?? result.signal ?? "an error"}`;
    }
    evidence.process = {
      exitStatus: result.status,
      signal: result.signal,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      durationMs: result.durationMs
    };
    return evidence;
  }

  function refreshRun(run) {
    run.changedFiles = listImplementationChanges(run.workspace, run.baseSha);
    const riskContext = git(run.workspace, [
      "diff",
      "--no-ext-diff",
      "--unified=0",
      run.baseSha
    ]);
    run.requirements = inferRequirements(
      run.changedFiles,
      `${run.task}\n${riskContext}`
    );
    run.route = validateRouteEnvelope(
      inferRouteEnvelope({
        agent: run.agent,
        task: run.task,
        requirements: run.requirements,
        model: run.model
      })
    );
    run.contextPack = buildContextPack({
      agent: run.agent,
      task: run.task,
      paths: run.contextPack?.candidateFiles ?? [],
      changedFiles: run.changedFiles
    });
    atomicWriteJson(runPath(run.id, "context-pack.json"), run.contextPack);
    run.headSha = git(run.workspace, ["rev-parse", "HEAD"]);
    run.clean = git(run.workspace, ["status", "--porcelain=v1"]) === "";
    if (!run.commands.length) {
      const loaded = loadProjectContract(run.workspace);
      const adapter = resolveExecutionAdapter({
        workspace: run.workspace,
        contract: loaded.contract
      });
      run.executionAdapter = {
        schemaVersion: adapter.schemaVersion,
        kind: adapter.kind,
        runtime: adapter.runtime,
        image: adapter.image,
        install: adapter.install.map(({ shell }) => shell)
      };
      run.commands = adapterVerificationCommands(adapter);
    }
    return saveRun(run);
  }

  function samePaths(left, right) {
    const normalize = (values) => [...new Set(values ?? [])].sort();
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  function checkpointImplementation(run, { declaredFiles } = {}) {
    const currentHead = git(run.workspace, ["rev-parse", "HEAD"]);
    const currentClean =
      git(run.workspace, ["status", "--porcelain=v1"]) === "";
    const currentFiles = listImplementationChanges(run.workspace, run.baseSha);
    if (run.implementationCheckpoint?.passed) {
      if (
        currentClean &&
        currentHead === run.implementationCheckpoint.headSha &&
        samePaths(currentFiles, run.implementationCheckpoint.changedFiles)
      ) {
        run.headSha = currentHead;
        run.changedFiles = currentFiles;
        run.clean = true;
        return run;
      }
      fail(
        "Managed worktree changed after its controller checkpoint. Start a new run instead of publishing unreviewed follow-up changes."
      );
    }
    const intendedFiles = declaredFiles ?? currentFiles;
    const priorIntent = run.implementationCheckpoint;
    if (
      priorIntent?.declaredFiles &&
      !samePaths(priorIntent.declaredFiles, intendedFiles)
    ) {
      fail("Implementation declarations changed after checkpointing began.");
    }
    const checkpointNonce =
      priorIntent?.checkpointNonce ?? randomUUID().replaceAll("-", "");
    run.implementationCheckpoint = {
      passed: false,
      status: "committing",
      baseSha: run.baseSha,
      declaredFiles: intendedFiles,
      checkpointNonce,
      startedAt: priorIntent?.startedAt ?? new Date().toISOString()
    };
    saveRun(run);
    const checkpoint = createImplementationCheckpoint({
      workspace: run.workspace,
      baseSha: run.baseSha,
      runId: run.id,
      task: run.task,
      declaredFiles: intendedFiles,
      checkpointNonce
    });
    run.implementationCheckpoint = {
      ...checkpoint,
      passed: true,
      status: "complete"
    };
    run.changedFiles = checkpoint.changedFiles;
    run.headSha = checkpoint.headSha;
    run.clean = checkpoint.clean;
    saveRun(run);
    recordTraceEvent({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      type: "implementation.checkpointed",
      phase: "implementation",
      data: {
        contentSha: checkpoint.contentSha,
        headSha: checkpoint.headSha,
        changedFiles: checkpoint.changedFiles,
        evidenceManifests: checkpoint.evidenceManifests
      }
    });
    return run;
  }

  function checkpointFailure(run, error) {
    const message = error instanceof Error ? error.message : String(error);
    run.implementationCheckpoint = {
      ...run.implementationCheckpoint,
      passed: false,
      status: "failed",
      error: message,
      failedAt: new Date().toISOString()
    };
    run.verification = { passed: false, error: message };
    saveRun(run);
    if (run.state !== "failed") {
      transition(run, "failed", `implementation checkpoint failed: ${message}`);
    }
    return run;
  }

  return {
    checkpointFailure,
    checkpointImplementation,
    refreshRun,
    runDagger,
    runOpenCode,
    samePaths
  };
}
