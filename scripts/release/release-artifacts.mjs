#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportPublicTree } from "./export-public-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_VERSION = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function execute(runner, command, args, options = {}) {
  const result = runner(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeout ?? 5 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(
        result.error?.message ??
          result.stderr ??
          result.stdout ??
          "unknown error"
      ).trim()}`
    );
  }
  return String(result.stdout ?? "").trim();
}

function safeOutputDirectory(value) {
  const output = resolve(value);
  if (
    output === resolve("/") ||
    output === resolve(process.env.HOME ?? "/nonexistent")
  )
    throw new Error("Unsafe release output directory.");
  if (existsSync(output) && readdirSync(output).length > 0)
    throw new Error("Release output directory must be empty.");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return output;
}

export function assertSignedTag(tag, runner = spawnSync) {
  if (!RELEASE_VERSION.test(tag)) throw new Error("Release tag is invalid.");
  const object = execute(runner, "git", ["cat-file", "-p", `refs/tags/${tag}`]);
  if (!/-----BEGIN (?:PGP|SSH) SIGNATURE-----/u.test(object))
    throw new Error(`Release tag ${tag} is not signed.`);
  return true;
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeChecksums(outputDirectory) {
  const output = resolve(outputDirectory);
  const files = readdirSync(output)
    .filter((name) => name !== "SHA256SUMS")
    .filter((name) => {
      const stat = lstatSync(join(output, name));
      return stat.isFile() && !stat.isSymbolicLink();
    })
    .sort();
  const lines = files.map((name) => `${sha256(join(output, name))}  ${name}`);
  const path = join(output, "SHA256SUMS");
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { path, files };
}

export function bundleRelease({
  version,
  outputDirectory,
  runner = spawnSync,
  commit = process.env.GITHUB_SHA ?? null
}) {
  if (!RELEASE_VERSION.test(version))
    throw new Error("Release version is invalid.");
  const output = safeOutputDirectory(outputDirectory);
  const temporary = mkdtempSync(join(tmpdir(), "opencode-lab-release-"));
  const tree = join(temporary, "tree");
  try {
    const exported = exportPublicTree(tree);
    const migrations = JSON.parse(
      readFileSync(join(tree, "migrations", "manifest.json"), "utf8")
    );
    writeFileSync(
      join(tree, "release-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version,
          commit,
          createdAt: new Date().toISOString(),
          files: exported.files,
          migrations
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    const archive = join(output, `opencode-command-center-${version}.tar.gz`);
    execute(runner, "tar", ["-czf", archive, "-C", tree, "."], {
      cwd: temporary
    });
    return { archive, version, files: exported.files };
  } finally {
    if (basename(temporary).startsWith("opencode-lab-release-"))
      rmSync(temporary, { recursive: true, force: true });
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === "verify-tag") {
      assertSignedTag(option("--tag"));
      console.log("Release tag is signed.");
    } else if (command === "bundle") {
      console.log(
        JSON.stringify(
          bundleRelease({
            version: option("--version"),
            outputDirectory: option("--out")
          }),
          null,
          2
        )
      );
    } else if (command === "checksums") {
      console.log(JSON.stringify(writeChecksums(option("--out")), null, 2));
    } else {
      throw new Error(
        "Usage: release-artifacts.mjs verify-tag --tag vX | bundle --version vX --out DIR | checksums --out DIR"
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
