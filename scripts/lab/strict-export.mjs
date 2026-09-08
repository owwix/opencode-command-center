#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { labStateRoot } from "./host-state.mjs";
import { projectIdentity } from "./workspace-registry.mjs";

const runPattern = /^strict_[a-f0-9]{12}$/u;
const sandboxPattern = /^lab-[a-z0-9_-]{8,80}$/u;
const shaPattern = /^[a-f0-9]{40,64}$/u;
const maximumBundleBytes = 100 * 1024 * 1024;
const maximumBundleFiles = 10_000;

function execute(command, args, { cwd } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: maximumBundleBytes,
      timeout: 60_000
    }).trim();
  } catch (error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? "unknown error").trim()}`
    );
  }
}

function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function signingKey(envFile) {
  const env = parseEnvFile(envFile);
  const value =
    env.STRICT_EXPORT_SIGNING_KEY || env.AGENT_GATEWAY_SIGNING_KEY || "";
  if (Buffer.byteLength(value) < 32) {
    throw new Error(
      "STRICT_EXPORT_SIGNING_KEY must contain at least 32 bytes."
    );
  }
  return value;
}

function strictRunDirectory(stateRoot, runId) {
  if (!runPattern.test(runId)) throw new Error("Strict run ID is invalid.");
  return join(resolve(stateRoot), "strict", "runs", runId);
}

function safeState(stateRoot, runId) {
  const directory = strictRunDirectory(stateRoot, runId);
  const path = join(directory, "run.json");
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Strict run not found: ${runId}`);
  }
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (
    state.schemaVersion !== 1 ||
    state.runId !== runId ||
    !sandboxPattern.test(state.sandboxName ?? "") ||
    !shaPattern.test(state.baseSha ?? "") ||
    !String(state.sandboxWorkspace ?? "").startsWith("/") ||
    String(state.sandboxWorkspace).split("/").includes("..")
  ) {
    throw new Error("Strict run state is invalid or incomplete.");
  }
  const source = realpathSync(resolve(state.source));
  const identity = projectIdentity(source);
  if (
    identity.projectId !== state.projectId ||
    identity.workspaceHash !== state.workspaceHash
  ) {
    throw new Error(
      "Strict run source identity no longer matches its recorded workspace."
    );
  }
  return { directory, source, state };
}

function sandboxGit(state, args, runner) {
  return runner("sbx", [
    "exec",
    state.sandboxName,
    "git",
    "-C",
    state.sandboxWorkspace,
    ...args
  ]);
}

function assertSandboxExportableStatus(output) {
  const unsafe = String(output)
    .split("\n")
    .map((value) => value.trimEnd())
    .filter(Boolean)
    .filter(
      (value) =>
        !value.startsWith("?? artifacts/") &&
        value !== "?? artifacts/" &&
        value !== "?? .quality/verification.json"
    );
  if (unsafe.length > 0) {
    throw new Error(
      "Commit or discard sandbox code changes before strict export."
    );
  }
}

function safeChangedFiles(output) {
  const text = String(output);
  const files = (text.includes("\0") ? text.split("\0") : text.split("\n"))
    .filter(Boolean)
    .sort();
  if (
    files.length === 0 ||
    files.some(
      (value) =>
        value.startsWith("/") ||
        value.split("/").includes("..") ||
        ["\0", "\r", "\n"].some((character) => value.includes(character))
    )
  ) {
    throw new Error(
      "Strict export contains no changes or an unsafe changed path."
    );
  }
  return [...new Set(files)];
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bundleFiles(root) {
  const files = [];
  let totalBytes = 0;
  function visit(path) {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) {
      throw new Error("Strict exports cannot contain symbolic links.");
    }
    if (details.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    if (!details.isFile())
      throw new Error("Strict exports contain an unsupported file type.");
    totalBytes += details.size;
    if (totalBytes > maximumBundleBytes || files.length >= maximumBundleFiles) {
      throw new Error("Strict export exceeds the file-count or size limit.");
    }
    files.push({
      path: relative(root, path).split(sep).join("/"),
      bytes: details.size,
      sha256: hashFile(path)
    });
  }
  visit(root);
  return files;
}

function signature(key, manifestText) {
  return createHmac("sha256", key).update(manifestText).digest("base64url");
}

function safeBundlePath(root, value) {
  const candidate = resolve(root, value);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Strict export manifest contains an unsafe path.");
  }
  return candidate;
}

export function verifyStrictExport({ directory, key }) {
  const root = realpathSync(resolve(directory));
  const manifestPath = join(root, "manifest.json");
  const signaturePath = join(root, "manifest.sig");
  if (!existsSync(manifestPath) || !existsSync(signaturePath)) {
    throw new Error("Strict export is incomplete.");
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const received = Buffer.from(readFileSync(signaturePath, "utf8").trim());
  const expected = Buffer.from(signature(key, manifestText));
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    throw new Error("Strict export signature is invalid.");
  }
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Strict export manifest schema is unsupported.");
  }
  for (const file of manifest.files) {
    const path = safeBundlePath(root, file.path);
    const details = lstatSync(path);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.size !== file.bytes ||
      hashFile(path) !== file.sha256
    ) {
      throw new Error(`Strict export file failed verification: ${file.path}`);
    }
  }
  return { directory: root, manifest };
}

function copyOptionalSandboxPath({ state, source, destination, runner }) {
  try {
    runner("sbx", ["cp", `${state.sandboxName}:${source}`, destination]);
    return true;
  } catch {
    return false;
  }
}

export function exportStrictRun({
  runId,
  envFile = resolve("opencode.env"),
  stateRoot = labStateRoot(),
  runner = execute,
  now = new Date()
}) {
  const key = signingKey(envFile);
  const { directory, state } = safeState(stateRoot, runId);
  const exportDirectory = join(directory, "export");
  if (existsSync(exportDirectory)) {
    return verifyStrictExport({ directory: exportDirectory, key });
  }
  assertSandboxExportableStatus(
    sandboxGit(
      state,
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      runner
    )
  );
  const headSha = sandboxGit(state, ["rev-parse", "HEAD"], runner);
  if (!shaPattern.test(headSha) || headSha === state.baseSha) {
    throw new Error("Strict run has no committed implementation to export.");
  }
  sandboxGit(
    state,
    ["merge-base", "--is-ancestor", state.baseSha, headSha],
    runner
  );
  const changedFiles = safeChangedFiles(
    sandboxGit(
      state,
      [
        "diff",
        "--name-only",
        "-z",
        "--format=",
        `${state.baseSha}..${headSha}`
      ],
      runner
    )
  );
  const temporary = mkdtempSync(join(directory, ".export-tmp-"));
  chmodSync(temporary, 0o700);
  try {
    const patchPath = join(temporary, "changes.patch");
    const patch = sandboxGit(
      state,
      ["diff", "--binary", "--full-index", `${state.baseSha}..${headSha}`],
      runner
    );
    if (!patch) throw new Error("Strict export patch is empty.");
    writeFileSync(patchPath, `${patch}\n`, { mode: 0o600 });

    const artifactsPath = join(temporary, "artifacts");
    copyOptionalSandboxPath({
      state,
      source: `${state.sandboxWorkspace}/artifacts`,
      destination: artifactsPath,
      runner
    });
    const evidenceDirectory = join(temporary, "evidence");
    mkdirSync(evidenceDirectory, { mode: 0o700 });
    copyOptionalSandboxPath({
      state,
      source: `${state.sandboxWorkspace}/.quality/verification.json`,
      destination: join(evidenceDirectory, "verification.json"),
      runner
    });

    const files = bundleFiles(temporary);
    const manifest = {
      schemaVersion: 1,
      kind: "opencode-lab-strict-export",
      runId,
      projectId: state.projectId,
      workspaceHash: state.workspaceHash,
      baseSha: state.baseSha,
      headSha,
      changedFiles,
      createdAt: now.toISOString(),
      files
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(temporary, "manifest.json"), manifestText, {
      mode: 0o600
    });
    writeFileSync(
      join(temporary, "manifest.sig"),
      `${signature(key, manifestText)}\n`,
      {
        mode: 0o600
      }
    );
    renameSync(temporary, exportDirectory);
    return verifyStrictExport({ directory: exportDirectory, key });
  } catch (error) {
    if (basename(temporary).startsWith(".export-tmp-")) {
      rmSync(temporary, { recursive: true, force: true });
    }
    throw error;
  }
}

function hostGit(source, args, runner) {
  return runner("git", ["-C", source, ...args], { cwd: source });
}

function sameFiles(actual, expected) {
  return (
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

export function adoptStrictRun({
  runId,
  approved = false,
  envFile = resolve("opencode.env"),
  stateRoot = labStateRoot(),
  runner = execute,
  now = new Date()
}) {
  if (!approved)
    throw new Error("Strict adoption requires the explicit --approve flag.");
  const key = signingKey(envFile);
  const { directory, source, state } = safeState(stateRoot, runId);
  const verified = verifyStrictExport({
    directory: join(directory, "export"),
    key
  });
  const { manifest } = verified;
  if (
    manifest.runId !== runId ||
    manifest.projectId !== state.projectId ||
    manifest.workspaceHash !== state.workspaceHash ||
    manifest.baseSha !== state.baseSha
  ) {
    throw new Error("Strict export does not belong to this run and workspace.");
  }
  const receiptPath = join(directory, "adoption.json");
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (hostGit(source, ["rev-parse", "HEAD"], runner) !== receipt.commitSha) {
      throw new Error(
        "Strict adoption receipt does not match the current repository HEAD."
      );
    }
    return receipt;
  }
  if (hostGit(source, ["status", "--porcelain=v1"], runner)) {
    throw new Error("Strict adoption requires a clean host repository.");
  }
  if (hostGit(source, ["rev-parse", "HEAD"], runner) !== manifest.baseSha) {
    throw new Error(
      "Host HEAD moved after the strict run; start a new strict run or review manually."
    );
  }
  const patchPath = join(verified.directory, "changes.patch");
  hostGit(
    source,
    ["apply", "--check", "--whitespace=nowarn", patchPath],
    runner
  );
  let applied = false;
  try {
    hostGit(source, ["apply", "--whitespace=nowarn", patchPath], runner);
    applied = true;
    const changedFiles = safeChangedFiles(
      hostGit(source, ["diff", "--name-only", "-z"], runner)
    );
    if (!sameFiles(changedFiles, manifest.changedFiles)) {
      throw new Error(
        "Applied strict patch changed files outside its signed manifest."
      );
    }
    hostGit(source, ["add", "-A", "--", ...manifest.changedFiles], runner);
    hostGit(
      source,
      [
        "-c",
        "user.name=OpenCode Command Center Controller",
        "-c",
        "user.email=controller@opencode-lab.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        `adopt(strict): ${runId}`
      ],
      runner
    );
    applied = false;
    const commitSha = hostGit(source, ["rev-parse", "HEAD"], runner);
    const committedFiles = safeChangedFiles(
      hostGit(
        source,
        ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", "HEAD"],
        runner
      )
    );
    if (!sameFiles(committedFiles, manifest.changedFiles)) {
      throw new Error(
        "Adoption commit does not contain exactly the signed changed files."
      );
    }
    if (hostGit(source, ["status", "--porcelain=v1"], runner)) {
      throw new Error("Strict adoption did not leave a clean host repository.");
    }
    const receipt = {
      schemaVersion: 1,
      runId,
      projectId: state.projectId,
      baseSha: manifest.baseSha,
      strictHeadSha: manifest.headSha,
      commitSha,
      changedFiles: manifest.changedFiles,
      adoptedAt: now.toISOString()
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600
    });
    return receipt;
  } catch (error) {
    if (applied) {
      try {
        hostGit(
          source,
          ["apply", "--reverse", "--whitespace=nowarn", patchPath],
          runner
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Strict adoption failed and rollback also failed."
        );
      }
    }
    throw error;
  }
}

function usage() {
  return "Usage: occtl strict export <run> | occtl strict adopt <run> --approve";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, runId, ...options] = process.argv.slice(2);
    let result;
    if (command === "export" && runId && options.length === 0) {
      result = exportStrictRun({ runId });
    } else if (
      command === "adopt" &&
      runId &&
      options.length === 1 &&
      options[0] === "--approve"
    ) {
      result = adoptStrictRun({ runId, approved: true });
    } else {
      throw new Error(usage());
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
