import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateRiskGate,
  evidenceDigest,
  selectReviewerRoutes
} from "../quality-lib.mjs";
import { recordPhaseTelemetry } from "./phase-telemetry.mjs";
import { recordTraceEvent } from "./durable-state.mjs";

export function createLifecycleOperations(context) {
  const {
    applyValidatedManifest,
    budgetBlocker,
    checkpointFailure,
    checkpointImplementation,
    fail,
    git,
    loadRun,
    prepare,
    preflightReviewPolicy,
    qualityRoot,
    readJson,
    refreshRun,
    routingPolicyPath,
    runDagger,
    runOpenCode,
    saveRun,
    transition,
    validateArtifactManifest,
    withWorkerLease
  } = context;

  async function verify(run) {
    if (
      ![
        "prepared",
        "implementing",
        "failed",
        "passed",
        "needs_evidence"
      ].includes(run.state)
    ) {
      fail(`Run ${run.id} cannot enter verification from ${run.state}.`);
    }
    const exhausted = budgetBlocker(run);
    if (exhausted) {
      run.verification = { passed: false, error: exhausted };
      return transition(run, "failed", exhausted);
    }
    try {
      checkpointImplementation(run, {
        declaredFiles: run.implementationResult?.result?.changedFiles
      });
    } catch (error) {
      return checkpointFailure(run, error);
    }
    transition(run, "verifying", "deterministic Dagger checks started");
    refreshRun(run);
    if (run.contract?.name !== "coding" && !run.artifacts?.contractEvidence) {
      for (const candidate of [
        "artifacts/quality/evidence-manifest.json",
        ".quality/evidence-manifest.json"
      ]) {
        if (existsSync(resolve(run.workspace, candidate))) {
          applyValidatedManifest(run, validateArtifactManifest(run, candidate));
          saveRun(run);
          break;
        }
      }
    }
    if (!run.changedFiles.length) {
      run.verification = {
        passed: false,
        error: "agent produced no file changes"
      };
      transition(run, "failed", "no changed files");
      return run;
    }
    if (!run.commands.length) {
      run.verification = {
        passed: false,
        error: "no verification command could be inferred; use --verify"
      };
      transition(run, "failed", "verification contract missing");
      return run;
    }
    run.verification = await runDagger(run, run.commands);
    recordTraceEvent({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      type: "verification.completed",
      phase: "verification",
      data: {
        passed: run.verification.passed,
        commands: run.commands,
        evidenceDigest: evidenceDigest(run.verification)
      }
    });
    const latest = loadRun(run.id);
    if (latest.state === "cancelled") return latest;
    run.verification.sha = git(run.workspace, ["rev-parse", "HEAD"]);
    run.verification.correlationId = run.traceId;
    run.verification.evidenceDigest = evidenceDigest(run.verification);
    saveRun(run);
    if (!run.verification.passed)
      transition(run, "failed", "deterministic verification failed");
    return run;
  }

  async function review(run) {
    if (run.state !== "verifying")
      fail(`Run ${run.id} must have green verification before review.`);
    let reviewerRoutes;
    try {
      reviewerRoutes = selectReviewerRoutes(
        run.task,
        run.requirements,
        readJson(routingPolicyPath, {}),
        run.model
      );
    } catch (error) {
      run.review = {
        passed: false,
        configurationError:
          error instanceof Error ? error.message : String(error),
        reviewers: []
      };
      saveRun(run);
      return transition(
        run,
        "failed",
        `review policy unavailable: ${run.review.configurationError}`
      );
    }
    transition(run, "reviewing", "read-only reviewer started");
    const results = [];
    for (const [index, route] of reviewerRoutes.entries()) {
      const result = await runOpenCode(run, {
        reviewer: true,
        model: route.model,
        reviewIndex: index
      });
      const latest = loadRun(run.id);
      if (latest.state === "cancelled") return latest;
      recordPhaseTelemetry(run, "review", result.telemetry);
      const structuredPassed =
        result.structured?.status === "pass" &&
        !result.structured.findings.some((finding) =>
          ["critical", "high"].includes(finding.severity)
        ) &&
        ["security", "deployment"].every((risk) =>
          run.requirements[risk]
            ? result.structured?.riskEvidence?.[risk]?.status === "pass"
            : result.structured?.riskEvidence?.[risk]?.status !== "fail"
        );
      results.push({
        passed: result.passed && structuredPassed,
        model: route.model,
        family: route.family,
        distinctFromImplementation: route.distinctFromImplementation,
        result: result.structured,
        protocolError: result.protocolError,
        log: result.logPath,
        process: {
          timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded,
          budgetExceeded: result.budgetExceeded,
          approvalRequired: result.approvalRequired,
          approvalId: result.approvalId,
          exitStatus: result.exitStatus,
          signal: result.signal
        }
      });
      saveRun(run);
      if (!result.passed || !structuredPassed) break;
    }
    const riskEvidence = Object.fromEntries(
      ["security", "deployment"].map((risk) => {
        const required = Boolean(run.requirements[risk]);
        const allPassed = results.every(
          (entry) => entry.result?.riskEvidence?.[risk]?.status === "pass"
        );
        return [
          risk,
          {
            status: required
              ? allPassed && results.length === reviewerRoutes.length
                ? "pass"
                : "fail"
              : "not_applicable",
            evidence: results.flatMap((entry) =>
              (entry.result?.riskEvidence?.[risk]?.evidence ?? []).map(
                (evidence) => `${entry.model}: ${evidence}`
              )
            )
          }
        ];
      })
    );
    run.review = {
      passed:
        results.length === reviewerRoutes.length &&
        results.every((result) => result.passed),
      sha: git(run.workspace, ["rev-parse", "HEAD"]),
      log: results[0]?.log ?? null,
      logs: results.map((result) => result.log),
      reviewers: results,
      correlationId: run.traceId,
      distinctFromImplementation:
        results.length > 0 &&
        results.every((result) => result.distinctFromImplementation),
      riskEvidence
    };
    const riskGate = evaluateRiskGate(run);
    run.review.passed &&= riskGate.passed;
    run.review.riskGate = riskGate;
    run.review.evidenceDigest = evidenceDigest(run.review);
    saveRun(run);
    if (!run.review.passed)
      return transition(run, "failed", "independent review failed");
    refreshRun(run);
    const missingVisual =
      run.requirements.visual && !run.artifacts.visual.length;
    const missingMigrationPlan =
      run.requirements.migration && !run.artifacts.migrationPlan;
    const missingContractEvidence =
      Boolean(run.contract) &&
      run.contract.name !== "coding" &&
      !run.artifacts.contractEvidence?.passed;
    if (missingVisual || missingMigrationPlan || missingContractEvidence) {
      const missing = [
        missingVisual && "rendered visual evidence",
        missingMigrationPlan && "a migration compatibility and recovery plan",
        missingContractEvidence && `${run.contract?.name} contract evidence`
      ].filter(Boolean);
      return transition(
        run,
        "needs_evidence",
        `${missing.join(" and ")} required`
      );
    }
    return transition(
      run,
      "passed",
      "verification and independent review passed"
    );
  }

  async function execute(options) {
    const prepared = prepare(options);
    if (prepared.idempotentReplay) return prepared;
    return withWorkerLease(prepared, "run", async (run) => {
      if (!options.skip_agent) {
        if (!options.skip_review) preflightReviewPolicy(run);
        transition(
          run,
          "implementing",
          "OpenCode implementation agent started"
        );
        const result = await runOpenCode(run);
        const latest = loadRun(run.id);
        if (latest.state === "cancelled") return latest;
        recordPhaseTelemetry(run, "implementation", result.telemetry);
        run.implementationResult = {
          passed: result.passed && result.structured?.status === "complete",
          result: result.structured,
          protocolError: result.protocolError,
          log: result.logPath,
          process: {
            timedOut: result.timedOut,
            outputLimitExceeded: result.outputLimitExceeded,
            budgetExceeded: result.budgetExceeded,
            approvalRequired: result.approvalRequired,
            approvalId: result.approvalId,
            doomLoopDetected: result.doomLoopDetected,
            controlError: result.controlError,
            usageTelemetryObserved: result.usageTelemetryObserved,
            exitStatus: result.exitStatus,
            signal: result.signal
          }
        };
        saveRun(run);
        if (!run.implementationResult.passed) {
          const reason =
            result.protocolError ||
            (result.timedOut && "implementation deadline exceeded") ||
            (result.outputLimitExceeded &&
              "implementation output limit exceeded") ||
            (result.approvalRequired &&
              "implementation requested interactive approval") ||
            (result.doomLoopDetected &&
              "implementation triggered the doom-loop guard") ||
            result.controlError ||
            (result.budgetExceeded &&
              `implementation ${result.budgetExceeded} budget exceeded`) ||
            (result.structured?.status === "blocked" &&
              `implementation blocked: ${result.structured.blockers.join("; ")}`) ||
            "implementation process failed";
          return transition(run, "failed", reason);
        }
      }
      const verified = await verify(run);
      if (
        ["failed", "cancelled"].includes(verified.state) ||
        options.skip_review
      ) {
        return verified;
      }
      return review(verified);
    });
  }

  return { execute, review, verify };
}
