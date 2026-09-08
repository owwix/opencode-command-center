#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityLease } from "../../docker/agent-gateway/capability-lease.mjs";
import { labStateRoot } from "./host-state.mjs";
import { projectIdentity } from "./workspace-registry.mjs";
import { strictDoctor } from "./strict-doctor.mjs";

const defaultModel = "@cf/openai/gpt-oss-120b";

function execute(
  command,
  args,
  { cwd, stdio = "pipe", env = process.env } = {}
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio,
    timeout: stdio === "inherit" ? undefined : 30_000
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.filter((value) => !String(value).includes("AGENT_GATEWAY_TOKEN")).join(" ")} failed: ${String(result.stderr ?? result.error?.message ?? "unknown error").trim()}`
    );
  }
  return String(result.stdout ?? "").trim();
}

function git(workspace, args, runner) {
  return runner("git", ["-C", workspace, ...args], { cwd: workspace });
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

function ensureHostSecret(path, name, values) {
  if (values[name]) return values[name];
  const details = lstatSync(path);
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    details.size > 1024 * 1024
  ) {
    throw new Error("Strict mode refuses an unsafe opencode.env file.");
  }
  const token = randomBytes(32).toString("hex");
  const original = readFileSync(path, "utf8");
  const line = `${name}=${token}`;
  const expression = new RegExp(`^${name}=.*$`, "mu");
  const updated = expression.test(original)
    ? original.replace(expression, line)
    : `${original.replace(/\n*$/u, "\n")}${line}\n`;
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, updated);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  chmodSync(path, 0o600);
  values[name] = token;
  return token;
}

function strictGateway(value) {
  if (!String(value ?? "").trim()) {
    throw new Error("STRICT_GATEWAY_URL is required for strict mode.");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "STRICT_GATEWAY_URL must be an HTTPS URL without embedded credentials."
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function assertSource(workspace, runner) {
  const requested = resolve(workspace);
  const details = lstatSync(requested);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Strict workspace must be a real directory.");
  }
  const source = realpathSync(requested);
  const root = realpathSync(
    git(source, ["rev-parse", "--show-toplevel"], runner)
  );
  if (root !== source)
    throw new Error("Strict mode must start at the repository root.");
  const gitDir = realpathSync(
    resolve(source, git(source, ["rev-parse", "--git-dir"], runner))
  );
  const commonDir = realpathSync(
    resolve(source, git(source, ["rev-parse", "--git-common-dir"], runner))
  );
  if (gitDir !== commonDir) {
    throw new Error(
      "Strict clone mode must start from the main checkout, not a Git worktree."
    );
  }
  if (git(source, ["status", "--porcelain=v1"], runner)) {
    throw new Error("Strict mode requires a clean source repository.");
  }
  return source;
}

function strictConfig(gatewayUrl) {
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    default_agent: "build",
    model: `cloudflare-ai/${defaultModel}`,
    provider: {
      "cloudflare-ai": {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCode Command Center strict gateway",
        options: {
          baseURL: `${gatewayUrl}/v1`,
          apiKey: "{env:AGENT_GATEWAY_TOKEN}",
          headers: {
            "x-lab-request-id": "{env:LAB_REQUEST_ID}",
            "x-lab-correlation-id": "{env:LAB_CORRELATION_ID}"
          }
        },
        models: { [defaultModel]: { name: "GPT-OSS 120B" } }
      }
    },
    mcp: {}
  };
}

function writeState(root, runId, value) {
  const directory = join(resolve(root), "strict", "runs", runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "run.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function launchStrictRun({
  workspace,
  envFile = resolve("opencode.env"),
  stateRoot = labStateRoot(),
  runner = execute,
  doctor = strictDoctor,
  interactive = true,
  now = new Date(),
  uuid = randomUUID
}) {
  const readiness = doctor();
  if (!readiness.ready)
    throw new Error("Strict backend is not ready. Run `occtl strict doctor`.");
  const source = assertSource(workspace, runner);
  const identity = projectIdentity(source);
  const env = parseEnvFile(envFile);
  const gatewayUrl = strictGateway(env.STRICT_GATEWAY_URL ?? "");
  const signingKey = ensureHostSecret(
    envFile,
    "AGENT_GATEWAY_SIGNING_KEY",
    env
  );
  const suffix = uuid().replaceAll("-", "").slice(0, 12);
  const runId = `strict_${suffix}`;
  const sessionId = `strict_session_${suffix}`;
  const sandboxName = `lab-${identity.projectId.slice(-12)}-${suffix}`;
  const correlationId = `trace_${uuid().replaceAll("-", "")}`;
  const lease = createCapabilityLease({
    key: signingKey,
    workspaceHash: identity.workspaceHash,
    projectId: identity.projectId,
    sessionId,
    runId,
    routes: ["chat"],
    actions: ["chat:invoke"],
    ttlSeconds: 60 * 60,
    now
  });
  const temporary = mkdtempSync(join(tmpdir(), "opencode-lab-strict-"));
  chmodSync(temporary, 0o700);
  const configPath = join(temporary, "opencode.json");
  const sessionEnvPath = join(temporary, "session.env");
  writeFileSync(
    configPath,
    `${JSON.stringify(strictConfig(gatewayUrl), null, 2)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    sessionEnvPath,
    [
      `AGENT_GATEWAY_TOKEN=${lease}`,
      "OPENCODE_CONFIG=/tmp/opencode-lab/opencode.json",
      `LAB_REQUEST_ID=${runId}`,
      `LAB_CORRELATION_ID=${correlationId}`,
      "OPENCODE_DISABLE_AUTOUPDATE=1"
    ].join("\n") + "\n",
    { mode: 0o600 }
  );
  const state = {
    schemaVersion: 1,
    runId,
    sessionId,
    correlationId,
    sandboxName,
    source,
    projectId: identity.projectId,
    workspaceHash: identity.workspaceHash,
    baseSha: git(source, ["rev-parse", "HEAD"], runner),
    backend: "docker-sbx",
    mode: "clone",
    sharedSkills: false,
    credentials: "short-lived chat capability only",
    status: "creating",
    createdAt: now.toISOString()
  };
  const statePath = writeState(stateRoot, runId, state);
  try {
    runner(
      "sbx",
      [
        "create",
        "--clone",
        "--no-share-skills",
        "--name",
        sandboxName,
        "opencode",
        source
      ],
      { cwd: source }
    );
    runner("sbx", ["exec", sandboxName, "mkdir", "-p", "/tmp/opencode-lab"], {
      cwd: source
    });
    runner(
      "sbx",
      ["cp", configPath, `${sandboxName}:/tmp/opencode-lab/opencode.json`],
      { cwd: source }
    );
    state.sandboxWorkspace =
      runner("sbx", ["exec", sandboxName, "pwd"], {
        cwd: source
      }) || "/workspace";
    state.status = "ready";
    state.readyAt = new Date().toISOString();
    writeState(stateRoot, runId, state);
    const sessionOutput = runner(
      "sbx",
      ["run", "--name", sandboxName, "--env-file", sessionEnvPath],
      { cwd: source, stdio: interactive ? "inherit" : "pipe" }
    );
    state.status = "stopped";
    state.stoppedAt = new Date().toISOString();
    writeState(stateRoot, runId, state);
    return { ...state, statePath, sessionOutput };
  } catch (error) {
    state.status = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.failedAt = new Date().toISOString();
    writeState(stateRoot, runId, state);
    throw error;
  } finally {
    if (basename(temporary).startsWith("opencode-lab-strict-")) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = launchStrictRun({
      workspace: process.argv[2] ?? process.cwd()
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
