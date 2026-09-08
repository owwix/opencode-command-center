#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);

export function countPhysicalLines(contents) {
  if (!contents) return 0;
  return contents.endsWith("\n")
    ? contents.split("\n").length - 1
    : contents.split("\n").length;
}

function walkFiles(root, policy, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!policy.excludedDirectories.includes(entry.name)) {
        walkFiles(path, policy, output);
      }
      continue;
    }
    if (!entry.isFile() || !policy.extensions.includes(extname(entry.name))) {
      continue;
    }
    if (policy.excludedSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
      continue;
    }
    output.push(path);
  }
  return output;
}

export function evaluateModuleBudget({ root, policy }) {
  const files = policy.roots.flatMap((directory) => {
    const path = resolve(root, directory);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return [];
    return walkFiles(path, policy);
  });
  const modules = files
    .map((path) => ({
      path: relative(root, path),
      lines: countPhysicalLines(readFileSync(path, "utf8"))
    }))
    .sort((left, right) => right.lines - left.lines);
  return {
    passed: modules.every(({ lines }) => lines <= policy.maxLines),
    maxLines: policy.maxLines,
    modules,
    violations: modules.filter(({ lines }) => lines > policy.maxLines)
  };
}

export function loadModuleBudgetPolicy(
  path = join(repositoryRoot, "quality", "module-budget.json")
) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (policy.schemaVersion !== 1) {
    throw new Error(
      `Unsupported module-budget schema: ${policy.schemaVersion}`
    );
  }
  if (!Number.isInteger(policy.maxLines) || policy.maxLines < 100) {
    throw new Error("Module maxLines must be an integer of at least 100.");
  }
  return policy;
}

function main() {
  const result = evaluateModuleBudget({
    root: repositoryRoot,
    policy: loadModuleBudgetPolicy()
  });
  if (result.passed) {
    const largest = result.modules[0];
    console.log(
      `Module budget passed: ${result.modules.length} production modules, largest ${largest.path} (${largest.lines}/${result.maxLines} lines).`
    );
    return;
  }
  console.error(`Module budget failed (${result.maxLines} lines maximum):`);
  for (const violation of result.violations) {
    console.error(`- ${violation.path}: ${violation.lines} lines`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
