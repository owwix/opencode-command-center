#!/usr/bin/env node
/**
 * Durable in-container local preview starter.
 *
 * Agents must use this instead of `npm run dev &`, which dies when the tool
 * shell exits. Starts a detached process, waits for :3000/:3001, then prints
 * the Mac preview URL (3100/3101 via the Lab relay).
 *
 *   node /opencode-config/scripts/local-preview/start.mjs start
 *   node /opencode-config/scripts/local-preview/start.mjs status
 *   node /opencode-config/scripts/local-preview/start.mjs stop
 *   node /opencode-config/scripts/local-preview/start.mjs restart
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nextDevPreviewHint } from "../lab/preview-readiness.mjs";
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  buildStartCommand,
  hostUrlForPort,
  processAlive,
  probePort,
  httpStatus,
  readMeta,
  readPid,
  startManagedProcess,
  statePaths,
  stopManagedProcess,
  tailLog,
  waitForPort
} from "./start-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checkScript = resolve(here, "check.mjs");

function usage() {
  return `Usage:
  node scripts/local-preview/start.mjs start [--workspace DIR] [--port 3000] [--cmd "…"] [--timeout-ms N]
  node scripts/local-preview/start.mjs status [--state-dir DIR]
  node scripts/local-preview/start.mjs stop [--state-dir DIR]
  node scripts/local-preview/start.mjs restart [same flags as start]

Default workspace: $OPENCODE_WORKSPACE or /workspace
Default state dir: /tmp/lab-preview
Never use bare \`npm run dev &\` — this command keeps the process alive.`;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("-"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  const workspace =
    argValue(rest, "--workspace") ||
    process.env.OPENCODE_WORKSPACE ||
    "/workspace";
  const stateDir =
    argValue(rest, "--state-dir") ||
    process.env.LAB_PREVIEW_STATE_DIR ||
    "/tmp/lab-preview";
  const port = Number(argValue(rest, "--port") || DEFAULT_PORT);
  const timeoutMs = Number(
    argValue(rest, "--timeout-ms") || DEFAULT_TIMEOUT_MS
  );
  const commandOverride = argValue(rest, "--cmd");
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("--port must be a positive integer.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000.");
  }
  return {
    command,
    workspace: resolve(workspace),
    stateDir: resolve(stateDir),
    port,
    timeoutMs,
    commandOverride
  };
}

function printStatus(options) {
  const paths = statePaths(options.stateDir);
  const meta = readMeta(options.stateDir);
  const pid = readPid(paths.pidFile);
  const alive = processAlive(pid);
  const port = meta?.port ?? options.port ?? DEFAULT_PORT;
  return probePort(port).then(async (up) => {
    const code = up ? await httpStatus(port) : 0;
    const hostUrl = hostUrlForPort(port);
    console.log("Lab local preview status");
    console.log(`  pid:        ${pid ?? "none"} (${alive ? "alive" : "dead"})`);
    console.log(
      `  port:       ${port} (${up ? `up http ${code || "n/a"}` : "not listening"})`
    );
    console.log(`  command:    ${meta?.command ?? "n/a"}`);
    console.log(`  log:        ${paths.logFile}`);
    if (hostUrl) console.log(`  mac url:    ${hostUrl}`);
    if (!alive && pid) {
      console.log("");
      console.log("Managed process is gone. Recent log:");
      console.log(tailLog(paths.logFile) || "(empty)");
    }
    return alive && up ? 0 : 1;
  });
}

async function runCheck() {
  const result = spawnSync(process.execPath, [checkScript], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

async function start(options) {
  // Validate command early so agents get a clear error before spawn.
  buildStartCommand({
    workspace: options.workspace,
    port: options.port,
    command: options.commandOverride
  });

  const launched = startManagedProcess({
    workspace: options.workspace,
    stateDir: options.stateDir,
    port: options.port,
    command: options.commandOverride
  });

  if (launched.alreadyRunning) {
    console.log(
      `Preview already running (pid ${launched.pid}) on :${launched.port}.`
    );
  } else {
    console.log(
      `Started detached preview (pid ${launched.pid}): ${launched.command}`
    );
    console.log(`Log: ${launched.logFile}`);
  }

  const ready = await waitForPort(options.port, {
    timeoutMs: options.timeoutMs
  });
  if (!ready) {
    console.error(
      `Timed out waiting for :${options.port} after ${options.timeoutMs}ms.`
    );
    console.error("Recent log:");
    console.error(tailLog(launched.logFile) || "(empty)");
    console.error(
      "If the bind address is wrong, pass --cmd with an explicit 0.0.0.0 server."
    );
    return 1;
  }

  const hostUrl = hostUrlForPort(options.port);
  console.log("");
  console.log(`Container :${options.port} is up.`);
  if (hostUrl) {
    console.log(`Open on your Mac: ${hostUrl}`);
    const hint = nextDevPreviewHint(options.workspace);
    if (hint) {
      console.log("");
      console.warn(`Note: ${hint}`);
    }
  }
  console.log("");
  return runCheck();
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    return 1;
  }

  if (options.command === "help") {
    console.log(usage());
    return 0;
  }

  if (options.command === "status") {
    return printStatus(options);
  }

  if (options.command === "stop") {
    const result = stopManagedProcess(options.stateDir);
    if (result.stopped) {
      console.log(`Stopped preview process ${result.pid}.`);
      return 0;
    }
    console.log(
      `Nothing to stop (${result.reason}${result.pid ? ` pid ${result.pid}` : ""}).`
    );
    return 0;
  }

  if (options.command === "restart") {
    stopManagedProcess(options.stateDir);
    return start(options);
  }

  if (options.command === "start") {
    return start(options);
  }

  console.error(`Unknown command: ${options.command}`);
  console.error(usage());
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main();
}

export { main, parseArgs };
