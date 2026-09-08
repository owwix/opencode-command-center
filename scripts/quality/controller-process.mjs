import { existsSync } from "node:fs";
import { processIsAlive, terminateProcessIdentity } from "./run-control.mjs";
import { recordPhaseTelemetry } from "./phase-telemetry.mjs";
import { listApprovals } from "./durable-state.mjs";
import {
  archiveDurableRun,
  assertDurableCleanupSafe,
  markDurableRunCleaned,
  readDurableRun
} from "./run-service.mjs";

export function createProcessOperations(context) {
  const {
    currentPhase,
    exec,
    fail,
    loadRun,
    preflightReviewPolicy,
    qualityRoot,
    readJson,
    refreshRun,
    review,
    runOpenCode,
    runPath,
    saveRun,
    transition,
    verify,
    withWorkerLease
  } = context;

  function setRunExitCode(run) {
    if (["failed", "cancelled", "abandoned"].includes(run?.state)) {
      process.exitCode = 1;
    }
    return run;
  }

  async function resume(options) {
    const initial = loadRun(options.run);
    if (initial.state === "archived") fail("Archived runs cannot be resumed.");
    if (initial.state === "passed") {
      console.log(JSON.stringify(initial, null, 2));
      return initial;
    }
    return withWorkerLease(initial, "resume", async (leasedRun) => {
      const run = refreshRun(leasedRun);
      const pendingApprovals = listApprovals({
        root: qualityRoot,
        runId: run.id,
        status: "pending"
      });
      const rejectedApprovals = listApprovals({
        root: qualityRoot,
        runId: run.id,
        status: "rejected"
      });
      if (pendingApprovals.length) {
        run.approvals = pendingApprovals.map((approval) => ({
          id: approval.id,
          status: approval.status,
          phase: approval.phase,
          requestedAt: approval.requestedAt
        }));
        saveRun(run);
        console.log(
          JSON.stringify(
            {
              id: run.id,
              state: run.state,
              blocked: "approval_pending",
              approvals: pendingApprovals
            },
            null,
            2
          )
        );
        return run;
      }
      if (rejectedApprovals.length) {
        console.log(
          JSON.stringify(
            {
              id: run.id,
              state: run.state,
              blocked: "approval_rejected",
              approvals: rejectedApprovals
            },
            null,
            2
          )
        );
        return run;
      }
      if (run.state === "archived") fail("Archived runs cannot be resumed.");
      if (run.state === "passed") {
        console.log(JSON.stringify(run, null, 2));
        return run;
      }
      if (run.state === "needs_evidence") {
        console.log(
          JSON.stringify(
            {
              id: run.id,
              state: run.state,
              next: "Record the required visual artifacts or migration plan with the artifacts command."
            },
            null,
            2
          )
        );
        return run;
      }
      if (["verifying", "reviewing"].includes(run.state)) {
        transition(run, "failed", `recovered interrupted ${run.state} phase`);
      }
      if (
        ["abandoned", "cancelled"].includes(run.state) &&
        run.changedFiles.length
      ) {
        transition(
          run,
          "implementing",
          `${run.state} work resumed from existing changes`
        );
      }
      if (!run.changedFiles.length) {
        if (!options.skip_review) preflightReviewPolicy(run);
        if (["failed", "abandoned", "cancelled"].includes(run.state)) {
          transition(run, "implementing", "implementation resumed");
        } else if (run.state === "prepared") {
          transition(run, "implementing", "implementation started from resume");
        }
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
          return transition(
            run,
            "failed",
            result.protocolError ||
              (result.approvalRequired &&
                "resumed implementation requested interactive approval") ||
              (result.doomLoopDetected &&
                "resumed implementation triggered the doom-loop guard") ||
              result.controlError ||
              (result.budgetExceeded &&
                `resumed implementation ${result.budgetExceeded} budget exceeded`) ||
              "resumed implementation failed or blocked"
          );
        }
      }
      const verified = await verify(run);
      if (
        ["failed", "cancelled"].includes(verified.state) ||
        options.skip_review
      )
        return verified;
      return review(verified);
    });
  }

  async function stopRun(options, targetState) {
    const run = loadRun(options.run);
    if (run.state === targetState) {
      console.log(JSON.stringify({ id: run.id, state: run.state }, null, 2));
      return run;
    }
    if (["passed", "archived", "cancelled", "abandoned"].includes(run.state)) {
      fail(`Run ${run.id} cannot be ${targetState} from ${run.state}.`);
    }
    const phase = currentPhase(run.id);
    const heartbeat = readJson(runPath(run.id, "heartbeat.json"));
    const leaseIsFresh =
      Boolean(heartbeat && run.worker?.leaseId) &&
      heartbeat?.leaseId === run.worker?.leaseId &&
      Date.now() < new Date(heartbeat.leaseExpiresAt ?? 0).getTime();
    const identities = [];
    if (
      leaseIsFresh &&
      phase?.leaseId === run.worker?.leaseId &&
      processIsAlive(phase.pid)
    ) {
      identities.push(phase);
    }
    if (
      leaseIsFresh &&
      run.worker?.status === "running" &&
      processIsAlive(run.worker.pid) &&
      !identities.some(
        (identity) =>
          identity.processGroupId &&
          identity.processGroupId === run.worker.processGroupId
      )
    ) {
      identities.push(run.worker);
    }
    run.cancellation = {
      requestedAt: new Date().toISOString(),
      reason:
        options.reason ??
        (targetState === "cancelled"
          ? "cancelled by operator"
          : "abandoned by operator"),
      requestedByPid: process.pid,
      processes: identities.map(({ pid, processGroupId }) => ({
        pid,
        processGroupId
      }))
    };
    transition(run, targetState, run.cancellation.reason);
    const signalled = identities.map((identity) => ({
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      sigterm: terminateProcessIdentity(identity, "SIGTERM")
    }));
    if (signalled.some((result) => result.sigterm)) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, run.limits?.terminationGraceMs ?? 2_000)
      );
      for (const identity of identities) {
        if (processIsAlive(identity.pid)) {
          terminateProcessIdentity(identity, "SIGKILL");
        }
      }
    }
    console.log(
      JSON.stringify({ id: run.id, state: run.state, signalled }, null, 2)
    );
    return run;
  }

  function cancelRun(options) {
    return stopRun(options, "cancelled");
  }

  function abandon(options) {
    return stopRun(options, "abandoned");
  }

  function archive(options) {
    const run = loadRun(options.run);
    if (!["passed", "failed", "cancelled", "abandoned"].includes(run.state)) {
      fail(
        "Only passed, failed, cancelled, or abandoned runs can be archived."
      );
    }
    transition(run, "archived", "run record archived");
    archiveDurableRun({ root: qualityRoot, runId: run.id });
    console.log(JSON.stringify({ id: run.id, state: run.state }, null, 2));
  }

  function cleanup(options) {
    const run = loadRun(options.run);
    if (
      !["passed", "failed", "cancelled", "abandoned", "archived"].includes(
        run.state
      )
    ) {
      fail("Only terminal runs can be cleaned up.");
    }
    if (!existsSync(run.workspace)) {
      assertDurableCleanupSafe(
        readDurableRun({ root: qualityRoot, runId: run.id })
      );
      run.cleanedAt = run.cleanedAt ?? new Date().toISOString();
      saveRun(run);
      markDurableRunCleaned({ root: qualityRoot, runId: run.id });
      console.log(
        JSON.stringify(
          { id: run.id, cleanedAt: run.cleanedAt, branchPreserved: run.branch },
          null,
          2
        )
      );
      return;
    }
    refreshRun(run);
    assertDurableCleanupSafe(
      readDurableRun({ root: qualityRoot, runId: run.id })
    );
    exec("git", ["-C", run.source, "worktree", "remove", run.workspace], {
      capture: false
    });
    run.cleanedAt = new Date().toISOString();
    saveRun(run);
    markDurableRunCleaned({ root: qualityRoot, runId: run.id });
    console.log(
      JSON.stringify(
        { id: run.id, cleanedAt: run.cleanedAt, branchPreserved: run.branch },
        null,
        2
      )
    );
  }

  return {
    abandon,
    archive,
    cancelRun,
    cleanup,
    resume,
    setRunExitCode,
    stopRun
  };
}
