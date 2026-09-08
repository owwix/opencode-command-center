import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { evaluateReleaseGate } from "../quality-lib.mjs";
import { recordTraceEvent } from "./durable-state.mjs";
import { recordExternalAction } from "./run-service.mjs";
import { preparePullRequest } from "../github/publish-boundary.mjs";

export function createArtifactOperations(
  context,
  { publish = preparePullRequest } = {}
) {
  const {
    checkpointFailure,
    checkpointImplementation,
    contractName,
    exec,
    fail,
    git,
    harnessRoot,
    loadRun,
    qualityRoot,
    readJson,
    refreshRun,
    runsRoot,
    saveRun,
    withWorkerLease
  } = context;

  function validateArtifactManifest(run, manifestOption) {
    const manifestPath = resolve(run.workspace, manifestOption);
    const workspaceRoot = resolve(run.workspace);
    if (
      manifestPath !== workspaceRoot &&
      !manifestPath.startsWith(`${workspaceRoot}${sep}`)
    ) {
      fail("Artifact manifest must be inside the managed worktree.");
    }
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      fail(`Artifact manifest not found: ${manifestPath}`);
    }
    const evidencePath = join(runsRoot, run.id, "artifact-evidence.json");
    const contract = run.contract?.name ?? contractName(run.agent);
    const result = exec(
      process.execPath,
      [
        join(harnessRoot, "scripts/quality/visual-evidence.mjs"),
        "--workspace",
        run.workspace,
        "--manifest",
        relative(workspaceRoot, manifestPath),
        "--contract",
        contract,
        "--expected-task",
        run.task,
        "--output",
        evidencePath
      ],
      { cwd: harnessRoot, allowFailure: true }
    );
    const evidence = readJson(evidencePath, {
      passed: false,
      fatal: true,
      error: { message: "artifact validator produced no evidence" }
    });
    const headSha = git(run.workspace, ["rev-parse", "HEAD"]);
    const subjectSha =
      run.implementationCheckpoint?.contentSha ?? run.headSha ?? headSha;
    const evidenceSha = evidence.manifest?.commitSha ?? "";
    if (!evidenceSha || subjectSha !== evidenceSha) {
      evidence.passed = false;
      evidence.errors = [
        ...(evidence.errors ?? []),
        "Artifact manifest commitSha does not match the controller implementation subject."
      ];
    }
    evidence.subjectSha = subjectSha;
    evidence.reviewedHeadSha = headSha;
    evidence.exitCode = result.status;
    return { manifestPath, evidence };
  }

  function applyValidatedManifest(run, validated) {
    run.artifacts ??= {};
    run.artifacts.visual ??= [];
    run.artifacts.manifest = validated.manifestPath;
    run.artifacts.contractEvidence = validated.evidence;
    if (validated.evidence.passed) {
      run.artifacts.visual.push(
        ...validated.evidence.artifacts
          .filter((artifact) =>
            ["render", "contact-sheet"].includes(artifact.kind)
          )
          .map((artifact) => resolve(run.workspace, artifact.path))
      );
      run.artifacts.visual = [...new Set(run.artifacts.visual)];
    }
    return run;
  }

  async function recordArtifacts(options, { verify, review }) {
    const run = loadRun(options.run);
    run.artifacts ??= {};
    run.artifacts.visual ??= [];
    run.artifacts.migrationPlan ??= null;
    run.artifacts.manifest ??= null;
    run.artifacts.contractEvidence ??= null;
    if (options.manifest) {
      applyValidatedManifest(
        run,
        validateArtifactManifest(run, options.manifest)
      );
    }
    for (const artifact of options.artifact) {
      const path = isAbsolute(artifact)
        ? artifact
        : resolve(run.workspace, artifact);
      if (!existsSync(path) || !statSync(path).isFile())
        fail(`Visual artifact not found: ${path}`);
      run.artifacts.visual.push(path);
    }
    run.artifacts.visual = [...new Set(run.artifacts.visual)];
    if (options.migration_plan) {
      const path = isAbsolute(options.migration_plan)
        ? options.migration_plan
        : resolve(run.workspace, options.migration_plan);
      if (!existsSync(path)) fail(`Migration plan not found: ${path}`);
      run.artifacts.migrationPlan = path;
    }
    if (
      run.state === "needs_evidence" &&
      (!run.requirements.visual || run.artifacts.visual.length) &&
      (!run.requirements.migration || run.artifacts.migrationPlan) &&
      (!run.contract ||
        run.contract.name === "coding" ||
        run.artifacts.contractEvidence?.passed)
    ) {
      saveRun(run);
      await withWorkerLease(run, "artifacts", async (leasedRun) => {
        const verified = await verify(leasedRun);
        if (!["failed", "cancelled"].includes(verified.state)) {
          await review(verified);
        }
      });
    } else saveRun(run);
    console.log(JSON.stringify(run.artifacts, null, 2));
  }

  function listRuns() {
    if (!existsSync(runsRoot)) return [];
    return readdirSync(runsRoot)
      .filter((id) => existsSync(join(runsRoot, id, "run.json")))
      .map((id) => loadRun(id));
  }

  function status(options) {
    if (options.run) {
      console.log(JSON.stringify(loadRun(options.run), null, 2));
      return;
    }
    const runs = listRuns();
    if (!runs.length) return console.log("[]");
    const staleHours = Number(options.stale_hours ?? 24);
    const rows = runs.map(
      ({ id, state, agent, task, workspace, worker, updatedAt }) => ({
        id,
        state,
        agent,
        task,
        workspace,
        worker,
        stale:
          [
            "prepared",
            "implementing",
            "verifying",
            "reviewing",
            "needs_evidence"
          ].includes(state) &&
          Date.now() - new Date(worker?.heartbeatAt ?? updatedAt).getTime() >
            staleHours * 60 * 60 * 1000
      })
    );
    console.log(JSON.stringify(rows, null, 2));
  }

  function gate(options) {
    const run = refreshRun(loadRun(options.run));
    const result = evaluateReleaseGate(run);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  }

  function finalize(options) {
    const run = loadRun(options.run);
    try {
      checkpointImplementation(run, {
        declaredFiles: run.implementationResult?.result?.changedFiles
      });
    } catch (error) {
      checkpointFailure(run, error);
      throw error;
    }
    console.log(JSON.stringify(run.implementationCheckpoint, null, 2));
    return run;
  }

  function requirePassedRelease(run) {
    const refreshed = refreshRun(run);
    const release = evaluateReleaseGate(refreshed);
    if (!release.passed) {
      fail(`Run ${run.id} is not releasable: ${release.blockers.join("; ")}`);
    }
    return refreshed;
  }

  function adopt(options) {
    const run = requirePassedRelease(loadRun(options.run));
    if (run.adoption?.headSha === run.headSha) {
      console.log(JSON.stringify(run.adoption, null, 2));
      return run;
    }
    const sourceStatus = git(run.source, ["status", "--porcelain=v1"]);
    if (sourceStatus) {
      fail("Source worktree must be clean before adopting a managed run.");
    }
    const previousSha = git(run.source, ["rev-parse", "HEAD"]);
    if (![run.baseSha, run.headSha].includes(previousSha)) {
      fail(
        `Source HEAD moved from ${run.baseSha} to ${previousSha}; refusing to overwrite newer work.`
      );
    }
    if (previousSha !== run.headSha) {
      git(run.source, ["merge", "--ff-only", run.headSha]);
    }
    const adoptedSha = git(run.source, ["rev-parse", "HEAD"]);
    if (adoptedSha !== run.headSha) {
      fail(`Adoption ended at ${adoptedSha}, expected ${run.headSha}.`);
    }
    run.adoption = {
      source: run.source,
      previousSha,
      headSha: run.headSha,
      adoptedAt: new Date().toISOString()
    };
    saveRun(run);
    recordExternalAction({
      root: qualityRoot,
      runId: run.id,
      action: "adopt",
      key: run.headSha,
      receipt: run.adoption
    });
    recordTraceEvent({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      type: "implementation.adopted",
      phase: "release",
      data: run.adoption
    });
    console.log(JSON.stringify(run.adoption, null, 2));
    return run;
  }

  function preparePr(options) {
    const run = requirePassedRelease(loadRun(options.run));
    const base = options.base?.trim() || "main";
    const prior = run.publishing?.pr;
    if (
      prior?.url &&
      prior.headSha === run.headSha &&
      prior.branch === run.branch &&
      prior.base === base
    ) {
      console.log(JSON.stringify(prior, null, 2));
      return run;
    }
    const title = (
      options.title?.trim() || `agent(${run.agent}): ${run.task}`
    ).slice(0, 200);
    const description =
      options.body?.trim() ||
      [
        "## Managed run",
        `- Run: \`${run.id}\``,
        `- Verified head: \`${run.headSha}\``,
        `- Verification: ${run.verification?.passed ? "passed" : "failed"}`,
        `- Independent review: ${run.review?.passed ? "passed" : "failed"}`,
        "",
        "The controller verified this exact commit before publication."
      ].join("\n");
    const prepared = publish({
      workspace: run.workspace,
      title,
      body: description,
      base,
      expectedBranch: run.branch,
      expectedHeadSha: run.headSha
    });
    run.publishing ??= {};
    run.publishing.pr = {
      url: prepared.url,
      remote: prepared.remote,
      base,
      branch: run.branch,
      headSha: run.headSha,
      created: prepared.created,
      reused: prepared.reused,
      preparedAt: new Date().toISOString(),
      correlationId: run.traceId
    };
    saveRun(run);
    recordExternalAction({
      root: qualityRoot,
      runId: run.id,
      action: "preparePr",
      key: `${base}:${run.branch}:${run.headSha}`,
      receipt: run.publishing.pr
    });
    recordTraceEvent({
      root: qualityRoot,
      runId: run.id,
      traceId: run.traceId,
      type: "pull_request.prepared",
      phase: "release",
      data: run.publishing.pr
    });
    console.log(JSON.stringify(run.publishing.pr, null, 2));
    return run;
  }

  return {
    adopt,
    applyValidatedManifest,
    finalize,
    gate,
    listRuns,
    preparePr,
    recordArtifacts,
    requirePassedRelease,
    status,
    validateArtifactManifest
  };
}
