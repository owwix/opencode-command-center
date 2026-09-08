#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkInventory, repositoryRoot } from "./provenance.mjs";

const forbiddenPaths = [
  /^\.git(?:\/|$)/,
  /^\.quality(?:\/|$)/,
  /^\.agent-/,
  /^artifacts(?:\/|$)/,
  /(^|\/)opencode\.env$/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets)(?:\.|$)/i
];

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${result.stderr.trim()}`
    );
  }
  return result.stdout.trim();
}

function assertSafeDestination(destination) {
  if (!path.isAbsolute(destination)) {
    throw new Error("Public export destination must be an absolute path.");
  }
  const resolved = path.resolve(destination);
  const forbidden = new Set([
    path.parse(resolved).root,
    path.resolve(os.homedir()),
    path.resolve(repositoryRoot)
  ]);
  if (forbidden.has(resolved)) {
    throw new Error(`Refusing unsafe public export destination: ${resolved}`);
  }
  if (resolved.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) {
    throw new Error(
      "Public export cannot be created inside the private repository."
    );
  }
  if (existsSync(resolved) && readdirSync(resolved).length > 0) {
    throw new Error("Public export destination must be absent or empty.");
  }
  return resolved;
}

export function exportPublicTree(destination, { initialize = false } = {}) {
  const resolvedDestination = assertSafeDestination(destination);
  const inventory = checkInventory();
  const unknown = inventory.files.filter(
    (entry) => entry.classification === "unknown"
  );
  if (unknown.length > 0) {
    throw new Error("Public export is blocked by unknown provenance.");
  }

  mkdirSync(resolvedDestination, { recursive: true, mode: 0o700 });
  for (const entry of inventory.files) {
    if (forbiddenPaths.some((pattern) => pattern.test(entry.path))) {
      throw new Error(`Sensitive path is not exportable: ${entry.path}`);
    }
    const source = path.join(repositoryRoot, entry.path);
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile()) {
      throw new Error(`Only regular files may be exported: ${entry.path}`);
    }
    const target = path.join(resolvedDestination, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, {
      dereference: false,
      errorOnExist: true,
      force: false
    });
    chmodSync(target, sourceStat.mode & 0o777);
  }

  if (initialize) {
    run("git", ["init", "-b", "main"], resolvedDestination);
    run(
      "git",
      ["config", "user.name", "OpenCode Command Center Release"],
      resolvedDestination
    );
    run(
      "git",
      ["config", "user.email", "release@opencode-lab.invalid"],
      resolvedDestination
    );
    // The allowlisted inventory is authoritative even when a broad project
    // ignore pattern (for example `artifacts/`) also matches a source folder.
    run("git", ["add", "--force", "--all"], resolvedDestination);
    run(
      "git",
      ["commit", "-m", "feat: publish OpenCode Command Center core"],
      resolvedDestination
    );
    const count = run(
      "git",
      ["rev-list", "--count", "--all"],
      resolvedDestination
    );
    if (count !== "1")
      throw new Error("Public export must contain one root commit.");
  }

  return {
    destination: realpathSync(resolvedDestination),
    files: inventory.files.length,
    initialized: initialize
  };
}

function parseArguments(arguments_) {
  const initialize = arguments_.includes("--init");
  const positionals = arguments_.filter((argument) => argument !== "--init");
  if (positionals.length !== 1) {
    throw new Error(
      "Usage: node scripts/release/export-public-tree.mjs <empty-absolute-directory> [--init]"
    );
  }
  return { destination: positionals[0], initialize };
}

const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = exportPublicTree(options.destination, options);
    console.log(
      `Exported ${result.files} classified files to ${result.destination}${
        result.initialized ? " with one clean root commit" : ""
      }.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
