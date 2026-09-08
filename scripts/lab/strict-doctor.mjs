#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(command, args, execute) {
  const result = execute(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000
  });
  return {
    passed: !result.error && result.status === 0,
    output: String(result.stdout ?? "").trim(),
    error: String(result.stderr ?? result.error?.message ?? "").trim()
  };
}

function check(id, passed, summary, detail = null) {
  return { id, passed, summary, detail };
}

function supportedMacVersion(value) {
  const major = Number(String(value).split(".")[0]);
  return Number.isInteger(major) && major >= 14;
}

export function strictDoctor({
  platform = process.platform,
  arch = process.arch,
  execute = spawnSync
} = {}) {
  const checks = [];
  checks.push(
    check(
      "platform",
      platform === "darwin",
      platform === "darwin"
        ? "macOS host detected."
        : "Strict mode currently requires macOS."
    )
  );
  checks.push(
    check(
      "architecture",
      arch === "arm64",
      arch === "arm64"
        ? "Apple silicon detected."
        : "Strict mode currently requires Apple silicon."
    )
  );

  const version =
    platform === "darwin"
      ? run("sw_vers", ["-productVersion"], execute)
      : { passed: false, output: "", error: "not macOS" };
  checks.push(
    check(
      "macos-version",
      version.passed && supportedMacVersion(version.output),
      version.passed && supportedMacVersion(version.output)
        ? `macOS ${version.output} is supported.`
        : "Docker Sandboxes requires macOS 14 or newer.",
      version.error || version.output || null
    )
  );

  const docker = run("docker", ["info", "--format", "{{json .}}"], execute);
  let dockerInfo = null;
  if (docker.passed) {
    try {
      dockerInfo = JSON.parse(docker.output);
    } catch {
      // The check below reports malformed Docker information.
    }
  }
  const desktop = /docker desktop/iu.test(
    `${dockerInfo?.OperatingSystem ?? ""} ${dockerInfo?.Name ?? ""}`
  );
  checks.push(
    check(
      "docker-desktop",
      docker.passed && Boolean(dockerInfo) && desktop,
      docker.passed && dockerInfo && desktop
        ? `Docker Desktop ${dockerInfo.ServerVersion ?? "unknown"} is ready.`
        : "Docker Desktop is not reachable or did not identify itself.",
      docker.error || docker.output || null
    )
  );

  const sbxPath = run("which", ["sbx"], execute);
  const sbxVersion = sbxPath.passed
    ? run("sbx", ["version"], execute)
    : { passed: false, output: "", error: "sbx not found" };
  checks.push(
    check(
      "sbx",
      sbxPath.passed && sbxVersion.passed,
      sbxPath.passed && sbxVersion.passed
        ? `Docker Sandboxes CLI is ready: ${sbxVersion.output}`
        : "Install the standalone Docker Sandboxes CLI and sign in before strict mode.",
      sbxPath.error || sbxVersion.error || null
    )
  );

  return {
    schemaVersion: 1,
    backend: "docker-sbx",
    ready: checks.every(({ passed }) => passed),
    checks
  };
}

export function formatStrictDoctor(result) {
  return [
    "OpenCode Command Center strict-mode doctor",
    ...result.checks.map(
      ({ passed, summary, detail }) =>
        `${passed ? "PASS" : "FAIL"} ${summary}${!passed && detail ? `\n     ${detail}` : ""}`
    ),
    result.ready
      ? "Strict mode is ready."
      : "Strict mode is unavailable; normal Lab mode is unchanged."
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = strictDoctor();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatStrictDoctor(result)
  );
  if (!result.ready) process.exitCode = 1;
}
