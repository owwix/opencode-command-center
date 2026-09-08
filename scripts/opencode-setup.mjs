#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  collectLaunchSnapshot,
  snapshotLines
} from "./lab/launch-snapshot.mjs";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, "opencode.env");
const envExamplePath = resolve(root, "opencode.env.example");
const checks = [];

function pass(label, detail = "") {
  checks.push({ label, ok: true, detail });
}

function fail(label, detail) {
  checks.push({ label, ok: false, detail });
}

function commandAvailable(command, args = ["--version"]) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 24 || (major === 24 && minor >= 11)) {
  pass("Node.js", `v${process.versions.node}`);
} else {
  fail("Node.js", `v${process.versions.node}; need 24.11 or newer`);
}

if (commandAvailable("docker", ["info"])) {
  pass("Docker Desktop", "running");
} else {
  fail("Docker Desktop", "start Docker Desktop before launching OpenCode");
}

if (!existsSync(envPath)) {
  if (!existsSync(envExamplePath)) {
    fail("Harness configuration", "opencode.env.example is missing");
  } else {
    copyFileSync(envExamplePath, envPath);
    chmodSync(envPath, 0o600);
    pass(
      "Harness configuration",
      "created opencode.env; fill in the Cloudflare values once"
    );
  }
} else {
  chmodSync(envPath, 0o600);
  const contents = readFileSync(envPath, "utf8");
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
  const missing = required.filter((name) => {
    const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
    return !match?.[1]?.trim();
  });
  if (missing.length) {
    fail(
      "Harness configuration",
      `add ${missing.join(" and ")} to opencode.env`
    );
  } else {
    pass("Harness configuration", "required credentials are present");
  }
}

function gitConfig(name) {
  try {
    return execFileSync("git", ["config", "--global", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

const gitName = gitConfig("user.name");
const gitEmail = gitConfig("user.email");
if (gitName && gitEmail) {
  pass("Git identity", `${gitName} <${gitEmail}>`);
} else {
  fail("Git identity", "set git config --global user.name and user.email");
}

const launchSnapshot = collectLaunchSnapshot({ root });
if (!launchSnapshot.runtimeConfig.writable) {
  fail(
    "Runtime configuration",
    `cannot write ${launchSnapshot.runtimeConfig.path}`
  );
} else {
  pass(
    "Runtime configuration",
    `${launchSnapshot.runtimeConfig.path} is writable`
  );
}

console.log("\nOpenCode setup\n");
for (const check of checks) {
  console.log(`${check.ok ? "✓" : "!"} ${check.label}: ${check.detail}`);
}

console.log("");
for (const line of snapshotLines(launchSnapshot)) console.log(line);

const failures = checks.filter((check) => !check.ok);
if (failures.length) {
  console.log(
    "\nFinish the items marked !, then run `occtl open` again. No workspace was started."
  );
  process.exitCode = 1;
} else {
  console.log(
    "\nReady. Run `occtl open` to choose a workspace, or `occtl open <folder>` to open one directly."
  );
}
