#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "../..");
export const policyPath = path.join(repositoryRoot, "provenance/policy.json");
export const inventoryPath = path.join(repositoryRoot, "provenance/files.json");
const inventoryRelativePath = "provenance/files.json";
const allowedClassifications = new Set([
  "original",
  "attributed-upstream",
  "unknown"
]);

function runGit(arguments_, options = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${arguments_.join(" ")} failed: ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

export function releaseFiles() {
  const files = runGit(["ls-files", "-co", "--exclude-standard"])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => existsSync(path.join(repositoryRoot, file)))
    .filter((file) => file !== inventoryRelativePath);
  files.push(inventoryRelativePath);
  return files.sort((left, right) => left.localeCompare(right));
}

function rootImportFiles(commit) {
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", commit], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split("\n").filter(Boolean));
}

function sha256(file) {
  return createHash("sha256")
    .update(readFileSync(path.join(repositoryRoot, file)))
    .digest("hex");
}

export function readPolicy() {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported provenance policy ${policy.schemaVersion}.`);
  }
  for (const [name, source] of Object.entries(policy.sources ?? {})) {
    if (!allowedClassifications.has(source.classification)) {
      throw new Error(`Source ${name} has an invalid classification.`);
    }
  }
  return policy;
}

export function buildInventory() {
  const policy = readPolicy();
  const imported = rootImportFiles(policy.rootImportCommit);
  const files = releaseFiles().map((file) => {
    const source =
      policy.overrides?.[file] ??
      (imported.has(file)
        ? "cloudflare-harness-import"
        : "opencode-command-center");
    const sourcePolicy = policy.sources[source];
    if (!sourcePolicy) {
      return {
        path: file,
        classification: "unknown",
        source,
        license: "unknown",
        notice: null,
        sha256: file === inventoryRelativePath ? null : sha256(file)
      };
    }
    return {
      path: file,
      classification: sourcePolicy.classification,
      source,
      license: sourcePolicy.license,
      notice: sourcePolicy.notice,
      sha256: file === inventoryRelativePath ? null : sha256(file)
    };
  });
  return {
    schemaVersion: 1,
    generatedFrom: "tracked and unignored release tree",
    files
  };
}

export function readInventory() {
  if (!existsSync(inventoryPath)) {
    throw new Error(
      "provenance/files.json is missing; run provenance:generate."
    );
  }
  return JSON.parse(readFileSync(inventoryPath, "utf8"));
}

export function checkInventory() {
  const policy = readPolicy();
  const expectedFiles = new Set(releaseFiles());
  const actual = readInventory();
  const actualFiles = new Map(actual.files.map((entry) => [entry.path, entry]));
  const errors = [];

  for (const file of expectedFiles) {
    if (!actualFiles.has(file))
      errors.push(`unclassified release file: ${file}`);
  }
  for (const file of actualFiles.keys()) {
    if (!expectedFiles.has(file))
      errors.push(`stale provenance entry: ${file}`);
  }
  for (const [file, entry] of actualFiles) {
    const source = policy.sources[entry.source];
    if (!source) {
      errors.push(
        `unrecognized provenance source for ${file}: ${entry.source}`
      );
      continue;
    }
    if (entry.classification === "unknown") {
      errors.push(`unknown provenance is release-blocking: ${file}`);
    }
    for (const key of ["classification", "license", "notice"]) {
      if (entry[key] !== source[key])
        errors.push(`provenance drift for ${file}: ${key}`);
    }
    const expectedHash = file === inventoryRelativePath ? null : sha256(file);
    if (entry.sha256 !== expectedHash) {
      errors.push(`provenance drift for ${file}: sha256`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return actual;
}

function writeInventory() {
  const inventory = buildInventory();
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, {
    mode: 0o644
  });
  return inventory;
}

function report(inventory) {
  const counts = inventory.files.reduce((result, entry) => {
    result[entry.classification] = (result[entry.classification] ?? 0) + 1;
    return result;
  }, {});
  console.log(
    `${inventory.files.length} release files classified: ${JSON.stringify(counts)}`
  );
}

const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedDirectly) {
  const command = process.argv[2] ?? "check";
  try {
    if (command === "generate") report(writeInventory());
    else if (command === "check") report(checkInventory());
    else if (command === "report") report(readInventory());
    else throw new Error(`Unknown provenance command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
