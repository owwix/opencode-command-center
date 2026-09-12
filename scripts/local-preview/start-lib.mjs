import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import net from "node:net";
import http from "node:http";

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST_PORT = 3100;
export const DEFAULT_TIMEOUT_MS = 60_000;

export function statePaths(stateDir) {
  const root = resolve(stateDir);
  return {
    root,
    pidFile: join(root, "server.pid"),
    logFile: join(root, "server.log"),
    metaFile: join(root, "meta.json")
  };
}

export function ensureStateDir(stateDir) {
  const paths = statePaths(stateDir);
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

export function readPid(pidFile) {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function processAlive(pid, { kill = process.kill } = {}) {
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function detectPackageManager(workspace) {
  const root = resolve(workspace);
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")))
    return "bun";
  return "npm";
}

export function readPackageScripts(workspace) {
  const path = join(resolve(workspace), "package.json");
  if (!existsSync(path)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    return pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return null;
  }
}

export function chooseDevScript(scripts) {
  if (!scripts) return null;
  if (typeof scripts.dev === "string") return "dev";
  if (typeof scripts.start === "string") return "start";
  return null;
}

/**
 * Build argv for a durable in-container HTTP preview process.
 * Prefer binding 0.0.0.0 so the Lab preview relay can reach it.
 */
export function buildStartCommand({
  workspace,
  port = DEFAULT_PORT,
  command = null,
  packageManager = null
}) {
  if (command) {
    return {
      shell: true,
      file: "/bin/sh",
      args: ["-c", command],
      cwd: resolve(workspace),
      display: command
    };
  }

  const scripts = readPackageScripts(workspace);
  if (!scripts) {
    throw new Error(
      `No package.json in ${workspace}. Pass --cmd, or use workspace docker compose.`
    );
  }
  const script = chooseDevScript(scripts);
  if (!script) {
    throw new Error(
      `package.json has no "dev" or "start" script. Pass --cmd with an explicit server command.`
    );
  }

  const manager = packageManager ?? detectPackageManager(workspace);
  const hostnameArgs =
    manager === "bun"
      ? ["--host", "0.0.0.0", "--port", String(port)]
      : ["--", "--hostname", "0.0.0.0", "--port", String(port)];

  if (manager === "pnpm") {
    return {
      shell: false,
      file: "pnpm",
      args: ["run", script, ...hostnameArgs],
      cwd: resolve(workspace),
      display: `pnpm run ${script} --hostname 0.0.0.0 --port ${port}`
    };
  }
  if (manager === "yarn") {
    return {
      shell: false,
      file: "yarn",
      args: [script, "--hostname", "0.0.0.0", "--port", String(port)],
      cwd: resolve(workspace),
      display: `yarn ${script} --hostname 0.0.0.0 --port ${port}`
    };
  }
  if (manager === "bun") {
    return {
      shell: false,
      file: "bun",
      args: ["run", script, ...hostnameArgs],
      cwd: resolve(workspace),
      display: `bun run ${script} --host 0.0.0.0 --port ${port}`
    };
  }
  return {
    shell: false,
    file: "npm",
    args: ["run", script, ...hostnameArgs],
    cwd: resolve(workspace),
    display: `npm run ${script} -- --hostname 0.0.0.0 --port ${port}`
  };
}

export function probePort(
  port,
  { connect = net.connect, timeoutMs = 800 } = {}
) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolveProbe(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.on("error", () => resolveProbe(false));
  });
}

export function httpStatus(
  port,
  path = "/",
  { get = http.get, timeoutMs = 1200 } = {}
) {
  return new Promise((resolveStatus) => {
    const req = get(
      { host: "127.0.0.1", port, path, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      }
    );
    req.on("error", () => resolveStatus(0));
    req.on("timeout", () => {
      req.destroy();
      resolveStatus(0);
    });
  });
}

export async function waitForPort(
  port,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = 500,
    probe = probePort,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = {}
) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await probe(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}

export function stopManagedProcess(
  stateDir,
  { kill = process.kill, alive = processAlive } = {}
) {
  const paths = statePaths(stateDir);
  const pid = readPid(paths.pidFile);
  if (!pid) {
    cleanupStateFiles(paths);
    return { stopped: false, reason: "no-pid" };
  }
  if (!alive(pid, { kill })) {
    cleanupStateFiles(paths);
    return { stopped: false, reason: "not-running", pid };
  }
  try {
    kill(-pid, "SIGTERM");
  } catch {
    try {
      kill(pid, "SIGTERM");
    } catch {
      cleanupStateFiles(paths);
      return { stopped: false, reason: "kill-failed", pid };
    }
  }
  cleanupStateFiles(paths);
  return { stopped: true, pid };
}

function cleanupStateFiles(paths) {
  for (const file of [paths.pidFile, paths.metaFile]) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

export function startManagedProcess(
  {
    workspace,
    stateDir,
    port = DEFAULT_PORT,
    command = null,
    packageManager = null,
    env = process.env
  },
  { spawnImpl = spawn, openSyncImpl = openSync, closeSyncImpl = closeSync } = {}
) {
  const paths = ensureStateDir(stateDir);
  const existing = readPid(paths.pidFile);
  if (existing && processAlive(existing)) {
    return {
      alreadyRunning: true,
      pid: existing,
      port,
      logFile: paths.logFile,
      metaFile: paths.metaFile
    };
  }

  const start = buildStartCommand({
    workspace,
    port,
    command,
    packageManager
  });
  const logFd = openSyncImpl(paths.logFile, "a");
  let child;
  try {
    child = spawnImpl(start.file, start.args, {
      cwd: start.cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...env,
        HOST: "0.0.0.0",
        PORT: String(port),
        HOSTNAME: "0.0.0.0"
      }
    });
  } finally {
    closeSyncImpl(logFd);
  }

  if (!child.pid) {
    throw new Error(`Failed to spawn preview process: ${start.display}`);
  }

  writeFileSync(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });
  writeFileSync(
    paths.metaFile,
    `${JSON.stringify(
      {
        pid: child.pid,
        port,
        workspace: resolve(workspace),
        command: start.display,
        startedAt: new Date().toISOString(),
        logFile: paths.logFile
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  child.unref();

  return {
    alreadyRunning: false,
    pid: child.pid,
    port,
    logFile: paths.logFile,
    metaFile: paths.metaFile,
    command: start.display
  };
}

export function readMeta(stateDir) {
  const paths = statePaths(stateDir);
  if (!existsSync(paths.metaFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.metaFile, "utf8"));
  } catch {
    return null;
  }
}

export function tailLog(logFile, maxBytes = 4000) {
  if (!existsSync(logFile)) return "";
  const raw = readFileSync(logFile, "utf8");
  return raw.length <= maxBytes ? raw : raw.slice(-maxBytes);
}

export function hostUrlForPort(port) {
  if (port === 3000) return "http://127.0.0.1:3100";
  if (port === 3001) return "http://127.0.0.1:3101";
  return null;
}
