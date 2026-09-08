import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  inspectBrandReviewSemantics,
  inspectResearchSemantics
} from "./visual-evidence-semantic.mjs";
import { inspectArtifact } from "./visual-evidence/artifact-inspection.mjs";
import {
  assertContract,
  duplicates,
  isObject,
  makeRecorder,
  objectDigest,
  sameStringSet
} from "./visual-evidence/primitives.mjs";

export { assertContract, objectDigest } from "./visual-evidence/primitives.mjs";
export {
  detectMediaType,
  inspectBufferDimensions
} from "./visual-evidence/media.mjs";

export async function validateEvidence({
  workspace,
  manifest,
  contract,
  inspectDimensions = false,
  expectedTask,
  toolRunner = spawnSync,
  now = new Date()
}) {
  assertContract(contract);
  if (!isObject(manifest))
    throw new Error("Evidence manifest must be a JSON object.");
  const workspaceReal = await realpath(resolve(workspace));
  const workspaceStats = await stat(workspaceReal);
  if (!workspaceStats.isDirectory())
    throw new Error("Evidence workspace must be a directory.");

  const recorder = makeRecorder();
  recorder.check(
    "manifest.version",
    manifest.manifestVersion === 1,
    manifest.manifestVersion === 1
      ? "Manifest version is supported."
      : "manifestVersion must equal 1."
  );
  recorder.check(
    "manifest.agent",
    manifest.agent === contract.id,
    manifest.agent === contract.id
      ? `Manifest targets the ${contract.id} contract.`
      : `Manifest agent ${JSON.stringify(manifest.agent)} does not match contract ${contract.id}.`
  );
  recorder.check(
    "manifest.task",
    typeof manifest.task === "string" &&
      manifest.task.trim().length > 0 &&
      (expectedTask === undefined || manifest.task === expectedTask),
    typeof manifest.task === "string" &&
      manifest.task.trim().length > 0 &&
      (expectedTask === undefined || manifest.task === expectedTask)
      ? "Manifest identifies its task."
      : expectedTask === undefined
        ? "Manifest task is required."
        : "Manifest task does not match the expected managed-run task."
  );
  const fullCommitSha =
    typeof manifest.commitSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(manifest.commitSha);
  recorder.check(
    "manifest.commit-sha",
    fullCommitSha,
    fullCommitSha
      ? "Manifest is bound to a full Git object ID."
      : "Manifest commitSha must be a full 40- or 64-character hexadecimal Git object ID."
  );
  const artifactsDeclared = Array.isArray(manifest.artifacts);
  recorder.check(
    "manifest.artifacts",
    artifactsDeclared && manifest.artifacts.length > 0,
    artifactsDeclared && manifest.artifacts.length > 0
      ? `Manifest declares ${manifest.artifacts.length} artifact(s).`
      : "Manifest must declare at least one artifact."
  );
  const artifacts = artifactsDeclared ? manifest.artifacts : [];
  const ids = artifacts
    .map((artifact) => artifact?.id)
    .filter((id) => typeof id === "string");
  const duplicateIds = duplicates(ids);
  recorder.check(
    "manifest.unique-artifact-ids",
    duplicateIds.length === 0,
    duplicateIds.length === 0
      ? "Artifact IDs are unique."
      : `Duplicate artifact IDs: ${duplicateIds.join(", ")}.`
  );
  const normalizedPaths = artifacts
    .map((artifact) => artifact?.path)
    .filter((path) => typeof path === "string" && path.trim())
    .map((path) =>
      relative(
        workspaceReal,
        resolve(workspaceReal, path.replaceAll("\\", "/"))
      ).replaceAll("\\", "/")
    );
  const duplicatePaths = duplicates(normalizedPaths);
  recorder.check(
    "manifest.unique-artifact-paths",
    duplicatePaths.length === 0,
    duplicatePaths.length === 0
      ? "Artifact paths are unique after normalization."
      : `Duplicate artifact paths: ${duplicatePaths.join(", ")}.`
  );

  const taskRules = contract.checks?.taskBinding ?? {};
  const binding = isObject(manifest.taskBinding) ? manifest.taskBinding : null;
  const expectedTaskDigest = objectDigest({
    agent: manifest.agent,
    task: manifest.task,
    commitSha: manifest.commitSha
  });
  recorder.check(
    "task-binding.declaration",
    Boolean(binding) || !taskRules.required,
    binding
      ? "Manifest declares a task binding."
      : taskRules.required
        ? "This contract requires taskBinding."
        : "Task binding is optional for this contract."
  );
  if (binding) {
    recorder.check(
      "task-binding.digest",
      binding.sha256 === expectedTaskDigest,
      binding.sha256 === expectedTaskDigest
        ? "Task binding matches agent, exact task, and commit."
        : "taskBinding.sha256 does not match the manifest task identity."
    );
    recorder.check(
      "task-binding.artifacts",
      sameStringSet(binding.artifactIds, ids),
      sameStringSet(binding.artifactIds, ids)
        ? "Task binding names every artifact exactly once."
        : "taskBinding.artifactIds must exactly match all declared artifact IDs."
    );
  }

  const artifactResults = [];
  for (const [index, artifact] of artifacts.entries()) {
    artifactResults.push(
      await inspectArtifact({
        artifact,
        index,
        workspaceReal,
        contract,
        recorder,
        forceDimensions: inspectDimensions,
        toolRunner
      })
    );
  }

  const resolvedPaths = artifactResults
    .map((artifact) => artifact.realPath)
    .filter((path) => typeof path === "string");
  const duplicateResolvedPaths = duplicates(resolvedPaths);
  recorder.check(
    "manifest.unique-resolved-artifact-paths",
    duplicateResolvedPaths.length === 0,
    duplicateResolvedPaths.length === 0
      ? "Resolved artifact files are unique."
      : "Multiple artifact declarations resolve to the same file."
  );

  for (const requirement of contract.requiredEvidence) {
    const validCount = artifactResults.filter(
      (artifact) => artifact.kind === requirement.kind && artifact.passed
    ).length;
    recorder.check(
      `contract.required-evidence.${requirement.kind}`,
      validCount >= requirement.minCount,
      validCount >= requirement.minCount
        ? `${validCount} valid ${requirement.kind} artifact(s) satisfy the minimum of ${requirement.minCount}.`
        : `${requirement.kind} requires ${requirement.minCount} valid artifact(s); found ${validCount}.`
    );
  }

  const provenanceRules = contract.checks?.provenance?.requiredByKind ?? {};
  const artifactById = new Map(
    artifactResults.map((artifact) => [artifact.id, artifact])
  );
  for (const [kind, requiredKinds] of Object.entries(provenanceRules)) {
    for (const artifact of artifactResults.filter(
      (item) => item.kind === kind
    )) {
      const derivedFrom = Array.isArray(artifact.derivedFrom)
        ? artifact.derivedFrom
        : [];
      const references = derivedFrom.map((id) => artifactById.get(id));
      const unknown = derivedFrom.filter((id) => !artifactById.has(id));
      const referenceKinds = new Set(
        references.filter(Boolean).map((reference) => reference.kind)
      );
      const missingKinds = requiredKinds.filter(
        (requiredKind) => !referenceKinds.has(requiredKind)
      );
      const provenanceValid =
        derivedFrom.length > 0 &&
        new Set(derivedFrom).size === derivedFrom.length &&
        !derivedFrom.includes(artifact.id) &&
        unknown.length === 0 &&
        missingKinds.length === 0;
      recorder.check(
        `provenance.${artifact.id}`,
        provenanceValid,
        provenanceValid
          ? `${artifact.id} is bound to the required upstream evidence.`
          : `${artifact.id} provenance is invalid; unknown IDs: ${unknown.join(", ") || "none"}; missing kinds: ${missingKinds.join(", ") || "none"}.`,
        { artifactId: artifact.id }
      );
    }
  }

  const researchInspection = inspectResearchSemantics({
    artifacts: artifactResults,
    rules: contract.checks?.researchSemantics
  });
  for (const check of researchInspection.checks) {
    recorder.check(check.id, check.passed, check.message, {
      severity: check.severity
    });
  }
  const brandInspection = inspectBrandReviewSemantics({
    artifacts: artifactResults,
    rules: contract.checks?.brandReview
  });
  for (const check of brandInspection.checks) {
    recorder.check(check.id, check.passed, check.message, {
      severity: check.severity
    });
  }

  const contactRules = contract.checks?.contactSheet ?? {};
  const presentKinds = new Set(artifacts.map((artifact) => artifact?.kind));
  const conditionallyRequired = (
    contactRules.requiredWhenKindsPresent ?? []
  ).some((kind) => presentKinds.has(kind));
  const contactRequired = Boolean(
    contactRules.required || conditionallyRequired
  );
  const contact = isObject(manifest.contactSheet)
    ? manifest.contactSheet
    : null;
  recorder.check(
    "contact-sheet.declaration",
    Boolean(contact) || !contactRequired,
    contact
      ? "Contact-sheet coverage is declared."
      : contactRequired
        ? "This contract requires a contactSheet declaration."
        : "This contract does not require a contact sheet."
  );

  let contactSummary = null;
  if (contact) {
    const sheet = artifactResults.find(
      (artifact) => artifact.id === contact.artifactId
    );
    const sheetValid = Boolean(
      sheet && sheet.kind === "contact-sheet" && sheet.passed
    );
    recorder.check(
      "contact-sheet.artifact",
      sheetValid,
      sheetValid
        ? "Contact sheet references a valid contact-sheet artifact."
        : "contactSheet.artifactId must reference a valid contact-sheet artifact."
    );
    const covers = Array.isArray(contact.covers) ? contact.covers : [];
    const uniqueCovers = [...new Set(covers)];
    recorder.check(
      "contact-sheet.unique-coverage",
      uniqueCovers.length === covers.length,
      uniqueCovers.length === covers.length
        ? "Contact-sheet coverage IDs are unique."
        : "Contact-sheet coverage contains duplicate artifact IDs."
    );
    const knownIds = new Set(artifactResults.map((artifact) => artifact.id));
    const unknownCovers = uniqueCovers.filter((id) => !knownIds.has(id));
    recorder.check(
      "contact-sheet.known-coverage",
      unknownCovers.length === 0,
      unknownCovers.length === 0
        ? "Every coverage ID references a declared artifact."
        : `Unknown coverage artifact IDs: ${unknownCovers.join(", ")}.`
    );
    const coverageKinds = new Set(contactRules.coverageKinds ?? []);
    const requiredIds = artifactResults
      .filter((artifact) => coverageKinds.has(artifact.kind))
      .map((artifact) => artifact.id);
    const missingIds = requiredIds.filter((id) => !uniqueCovers.includes(id));
    const extraIds = uniqueCovers.filter((id) => !requiredIds.includes(id));
    recorder.check(
      "contact-sheet.complete-coverage",
      missingIds.length === 0 && extraIds.length === 0,
      missingIds.length === 0 && extraIds.length === 0
        ? `Contact sheet covers exactly all ${requiredIds.length} required artifact(s).`
        : `Contact-sheet coverage mismatch; missing: ${missingIds.join(", ") || "none"}; extra: ${extraIds.join(", ") || "none"}.`
    );
    recorder.check(
      "contact-sheet.no-self-coverage",
      !uniqueCovers.includes(contact.artifactId),
      !uniqueCovers.includes(contact.artifactId)
        ? "Contact sheet does not claim to cover itself."
        : "Contact sheet may not list itself in covers."
    );

    const entries = Array.isArray(contact.entries) ? contact.entries : [];
    const verifiedEntries = requiredIds.map((artifactId) => ({
      artifactId,
      sha256: artifactById.get(artifactId)?.sha256
    }));
    if (contactRules.cryptographicEntries) {
      const entryIds = entries
        .map((entry) => entry?.artifactId)
        .filter((id) => typeof id === "string");
      recorder.check(
        "contact-sheet.entry-coverage",
        entries.length === 0 || sameStringSet(entryIds, requiredIds),
        entries.length === 0
          ? "Validator generated cryptographic entries for exact render coverage."
          : sameStringSet(entryIds, requiredIds)
            ? "Contact-sheet entries exactly match required render coverage."
            : "contactSheet.entries must name every required render exactly once and no other artifact."
      );
      const invalidEntries = entries.filter((entry) => {
        const artifact = artifactById.get(entry?.artifactId);
        return !artifact || artifact.sha256 !== entry?.sha256;
      });
      recorder.check(
        "contact-sheet.entry-digests",
        invalidEntries.length === 0,
        invalidEntries.length === 0
          ? "Every contact-sheet entry is cryptographically bound to its render."
          : `${invalidEntries.length} contact-sheet entry digest(s) failed validation.`
      );
    }
    contactSummary = {
      artifactId: contact.artifactId,
      covers: uniqueCovers,
      requiredArtifactIds: requiredIds,
      missingArtifactIds: missingIds,
      extraArtifactIds: extraIds,
      entries: verifiedEntries
    };
  }

  const errors = recorder.checks.filter(
    (check) => !check.passed && check.severity === "error"
  );
  const warnings = recorder.checks.filter(
    (check) => !check.passed && check.severity === "warning"
  );
  return {
    evidenceVersion: 1,
    generatedAt: now.toISOString(),
    passed: errors.length === 0,
    workspace: workspaceReal,
    manifest: {
      agent: manifest.agent,
      task: manifest.task,
      commitSha: manifest.commitSha,
      artifactCount: artifacts.length,
      sha256: objectDigest(manifest)
    },
    contract: {
      id: contract.id,
      version: contract.version,
      sha256: objectDigest(contract),
      completionCriteria: contract.completionCriteria
    },
    summary: {
      checkedArtifacts: artifactResults.length,
      validArtifacts: artifactResults.filter((artifact) => artifact.passed)
        .length,
      failedChecks: errors.length,
      warnings: warnings.length
    },
    artifacts: artifactResults,
    contactSheet: contactSummary,
    semantic: {
      research: researchInspection.summary
    },
    checks: recorder.checks,
    errors: errors.map((check) => check.message),
    warnings: warnings.map((check) => check.message)
  };
}
