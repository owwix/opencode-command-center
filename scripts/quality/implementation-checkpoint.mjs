import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isSensitiveSnapshotPath } from "./dagger-source-policy.mjs";

const EVIDENCE_MANIFESTS = new Set([
  ".quality/evidence-manifest.json",
  "artifacts/quality/evidence-manifest.json"
]);
const CREDENTIAL_CONTENT = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u,
  /-----BEGIN OPENSSH PRIVATE KEY-----/u,
  /\b(?:sk|cf|ntn|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/u
];

function git(workspace, args, { allowedStatuses = [0], raw = false } = {}) {
  const result = spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(
      String(result.stderr || result.stdout || `git ${args[0]} failed`).trim()
    );
  }
  const output = String(result.stdout || "");
  return raw ? output : output.trim();
}

export function normalizeImplementationPath(value) {
  const normalized = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !normalized ||
    hasControlCharacter ||
    normalized.trim() !== normalized ||
    normalized.startsWith("/") ||
    isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe implementation path: ${value}`);
  }
  return normalized;
}

function uniquePaths(values) {
  return [...new Set((values ?? []).map(normalizeImplementationPath))].sort();
}

function names(workspace, args) {
  const output = git(workspace, [...args, "-z"], { raw: true });
  return output ? output.split("\0").filter(Boolean) : [];
}

export function listImplementationChanges(workspace, baseSha) {
  return uniquePaths([
    ...names(workspace, [
      "diff",
      "--name-only",
      "--no-renames",
      `${baseSha}...HEAD`
    ]),
    ...names(workspace, ["diff", "--name-only", "--no-renames"]),
    ...names(workspace, ["diff", "--cached", "--name-only", "--no-renames"]),
    ...names(workspace, ["ls-files", "--others", "--exclude-standard"])
  ]);
}

function assertSamePaths(label, expected, actual) {
  const left = uniquePaths(expected);
  const right = uniquePaths(actual);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} mismatch. Expected ${JSON.stringify(left)}, found ${JSON.stringify(right)}.`
    );
  }
  return left;
}

function validateChangedPath(root, path) {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`Implementation path escaped its worktree: ${path}`);
  }
  if (!existsSync(absolute)) return;
  if (isSensitiveSnapshotPath(path)) {
    throw new Error(`Refusing to checkpoint credential-class path: ${path}`);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to checkpoint symbolic link: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Implementation change is not a regular file: ${path}`);
  }
  const content = readFileSync(absolute);
  if (content.includes(0)) return;
  const text = content.toString("utf8");
  if (CREDENTIAL_CONTENT.some((pattern) => pattern.test(text))) {
    throw new Error(
      `Refusing to checkpoint credential-shaped content: ${path}`
    );
  }
}

function commit(
  workspace,
  message,
  expectedFiles,
  { runId, checkpointNonce, part }
) {
  git(workspace, [
    "-c",
    "user.name=OpenCode Command Center Controller",
    "-c",
    "user.email=controller@opencode-lab.local",
    "commit",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    message,
    "-m",
    `OpenCode-Lab-Run: ${runId}\nOpenCode-Lab-Checkpoint: ${checkpointNonce}\nOpenCode-Lab-Part: ${part}`
  ]);
  const sha = git(workspace, ["rev-parse", "HEAD"]);
  const committed = names(workspace, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    sha
  ]);
  assertSamePaths("Controller checkpoint commit", expectedFiles, committed);
  return sha;
}

function assertCheckpointCommit(
  workspace,
  sha,
  { runId, checkpointNonce, part }
) {
  const body = git(workspace, ["show", "-s", "--format=%B", sha]);
  for (const trailer of [
    `OpenCode-Lab-Run: ${runId}`,
    `OpenCode-Lab-Checkpoint: ${checkpointNonce}`,
    `OpenCode-Lab-Part: ${part}`
  ]) {
    if (!body.split("\n").includes(trailer)) {
      throw new Error(
        `Existing commit ${sha} is not the controller checkpoint recorded for ${runId}.`
      );
    }
  }
}

function recoverCheckpoint({
  workspace,
  baseSha,
  headSha,
  runId,
  checkpointNonce,
  declaredFiles
}) {
  if (git(workspace, ["status", "--porcelain=v1"])) {
    throw new Error(
      "Managed worktree contains follow-up changes after an interrupted controller checkpoint."
    );
  }
  const commits = git(workspace, [
    "rev-list",
    "--reverse",
    `${baseSha}..${headSha}`
  ])
    .split("\n")
    .filter(Boolean);
  if (commits.length < 1 || commits.length > 2) {
    throw new Error(
      "Managed HEAD moved without a recoverable controller checkpoint."
    );
  }
  const contentSha = commits[0];
  assertCheckpointCommit(workspace, contentSha, {
    runId,
    checkpointNonce,
    part: "content"
  });
  const evidenceSha = commits[1] ?? null;
  if (evidenceSha) {
    assertCheckpointCommit(workspace, evidenceSha, {
      runId,
      checkpointNonce,
      part: "evidence"
    });
  }
  const changedFiles = listImplementationChanges(workspace, baseSha);
  assertSamePaths(
    "Recovered implementation files",
    declaredFiles,
    changedFiles
  );
  const evidenceManifests = changedFiles.filter((path) =>
    EVIDENCE_MANIFESTS.has(path)
  );
  if (Boolean(evidenceSha) !== Boolean(evidenceManifests.length)) {
    throw new Error(
      "Recovered checkpoint has an invalid evidence commit shape."
    );
  }
  for (const path of evidenceManifests) {
    const manifest = JSON.parse(readFileSync(resolve(workspace, path), "utf8"));
    if (manifest.commitSha !== contentSha) {
      throw new Error(
        `Recovered evidence manifest ${path} is not bound to ${contentSha}.`
      );
    }
  }
  return {
    schemaVersion: 1,
    runId,
    baseSha,
    contentSha,
    headSha,
    changedFiles,
    evidenceManifests,
    checkpointNonce,
    recovered: true,
    recoveredAt: new Date().toISOString(),
    clean: true
  };
}

function rewriteEvidenceManifests(workspace, paths, contentSha) {
  for (const path of paths) {
    const absolute = resolve(workspace, path);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new Error(
        `Evidence manifest ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    manifest.commitSha = contentSha;
    writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function validateEvidenceManifests(workspace, paths) {
  for (const path of paths) {
    try {
      JSON.parse(readFileSync(resolve(workspace, path), "utf8"));
    } catch (error) {
      throw new Error(
        `Evidence manifest ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function createImplementationCheckpoint({
  workspace,
  baseSha,
  runId,
  task,
  declaredFiles,
  checkpointNonce
}) {
  const root = resolve(workspace);
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(String(checkpointNonce ?? ""))) {
    throw new Error("A controller checkpoint nonce is required.");
  }
  const startingHead = git(root, ["rev-parse", "HEAD"]);
  if (startingHead !== baseSha) {
    return recoverCheckpoint({
      workspace: root,
      baseSha,
      headSha: startingHead,
      runId,
      checkpointNonce,
      declaredFiles
    });
  }
  const actual = listImplementationChanges(root, baseSha);
  if (!actual.length)
    throw new Error("Implementation produced no file changes.");
  assertSamePaths("Declared implementation files", declaredFiles, actual);
  for (const path of actual) validateChangedPath(root, path);

  const manifests = actual.filter((path) => EVIDENCE_MANIFESTS.has(path));
  const contentFiles = actual.filter((path) => !EVIDENCE_MANIFESTS.has(path));
  if (!contentFiles.length) {
    throw new Error(
      "An evidence manifest cannot be the only implementation change."
    );
  }
  validateEvidenceManifests(root, manifests);

  git(root, ["reset", "--quiet", "HEAD", "--", ...actual]);
  git(root, ["add", "-A", "--", ...contentFiles]);
  assertSamePaths(
    "Staged implementation files",
    contentFiles,
    names(root, ["diff", "--cached", "--name-only", "--no-renames"])
  );
  const summary = String(task ?? "managed change")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 72);
  const contentSha = commit(
    root,
    `chore(agent): checkpoint ${summary || runId}`,
    contentFiles,
    { runId, checkpointNonce, part: "content" }
  );

  let headSha = contentSha;
  if (manifests.length) {
    rewriteEvidenceManifests(root, manifests, contentSha);
    git(root, ["add", "-A", "--", ...manifests]);
    headSha = commit(
      root,
      `chore(agent): bind evidence for ${runId}`,
      manifests,
      { runId, checkpointNonce, part: "evidence" }
    );
  }

  const finalFiles = listImplementationChanges(root, baseSha);
  assertSamePaths("Published implementation files", actual, finalFiles);
  const status = git(root, ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error("Controller checkpoint did not leave a clean worktree.");
  }
  return {
    schemaVersion: 1,
    runId,
    baseSha,
    contentSha,
    headSha,
    changedFiles: finalFiles,
    evidenceManifests: manifests,
    checkpointNonce,
    recovered: false,
    createdAt: new Date().toISOString(),
    clean: true
  };
}
