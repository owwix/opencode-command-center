import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  processIsAlive,
  reconcileHostRegistry
} from "./workspace-registry.mjs";

function projectRows(registry, fileExists = existsSync) {
  return Object.values(registry.projects ?? {})
    .map((project) => ({
      projectId: project.projectId,
      name: basename(project.canonicalPath),
      canonicalPath: project.canonicalPath,
      profile: project.profile ?? "fast",
      lastOpenedAt: project.lastOpenedAt ?? null,
      exists: fileExists(project.canonicalPath),
      sessionCount: Object.keys(project.sessions ?? {}).length,
      runCount: new Set(project.runs ?? []).size
    }))
    .sort((left, right) => {
      const time = String(right.lastOpenedAt ?? "").localeCompare(
        String(left.lastOpenedAt ?? "")
      );
      return time || left.canonicalPath.localeCompare(right.canonicalPath);
    });
}

export function lifecycleSnapshot(
  registryPath,
  { alive = processIsAlive, fileExists = existsSync } = {}
) {
  const registry = reconcileHostRegistry(registryPath, { alive });
  const projects = projectRows(registry, fileExists);
  const backgroundSessions = [];
  for (const project of Object.values(registry.projects ?? {})) {
    for (const [sessionId, session] of Object.entries(project.sessions ?? {})) {
      if (!session.background || !alive(session.pid)) continue;
      backgroundSessions.push({
        projectId: project.projectId,
        canonicalPath: project.canonicalPath,
        sessionId,
        runId: session.runId,
        pid: session.pid,
        profile: session.profile,
        openedAt: session.openedAt
      });
    }
  }
  backgroundSessions.sort((left, right) =>
    String(right.openedAt).localeCompare(String(left.openedAt))
  );
  return {
    schemaVersion: 1,
    foreground: registry.foreground,
    projects,
    backgroundSessions
  };
}

export function resolveRecentProject(snapshot, selector) {
  const projects = snapshot.projects;
  const existingProjects = projects.filter((project) => project.exists);
  if (existingProjects.length === 0) {
    throw new Error("No existing recent projects are registered yet.");
  }
  if (!selector) return existingProjects[0];

  const requireExisting = (project) => {
    if (!project.exists) {
      throw new Error(
        `Recent project path no longer exists: ${project.canonicalPath}`
      );
    }
    return project;
  };

  const numeric = Number(selector);
  if (Number.isInteger(numeric) && String(numeric) === String(selector)) {
    const indexed = projects[numeric - 1];
    if (!indexed) {
      throw new Error(`Recent project index is out of range: ${selector}`);
    }
    return requireExisting(indexed);
  }

  const exact = projects.filter(
    (project) =>
      project.projectId === selector ||
      project.canonicalPath === resolve(selector)
  );
  if (exact.length === 1) return requireExisting(exact[0]);

  const named = projects.filter((project) => project.name === selector);
  if (named.length === 1) return requireExisting(named[0]);
  if (named.length > 1) {
    throw new Error(
      `Project name is ambiguous: ${selector}. Use its index, project ID, or full path.`
    );
  }
  throw new Error(`Recent project was not found: ${selector}`);
}

export function prepareNewWorkspace(
  requestedPath,
  {
    cwd = process.cwd(),
    exists = existsSync,
    lstat = lstatSync,
    list = readdirSync,
    mkdir = mkdirSync
  } = {}
) {
  if (!requestedPath)
    throw new Error("occtl new requires a project folder path.");
  const target = resolve(cwd, requestedPath);
  if (exists(target)) {
    const stats = lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`New project target must be a real directory: ${target}`);
    }
    if (list(target).length > 0) {
      throw new Error(
        `New project target is not empty: ${target}. Use \`occtl open\` instead.`
      );
    }
    return { path: target, created: false };
  }

  const parent = dirname(target);
  if (!exists(parent)) {
    throw new Error(`Parent directory does not exist: ${parent}`);
  }
  const parentStats = lstat(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Parent must be a real directory: ${parent}`);
  }
  mkdir(target, { mode: 0o755 });
  return { path: target, created: true };
}

function commandForPid(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds
  );
}

export function stopForegroundWorkspace(
  { registryPath, expectedLauncher, timeoutMs = 5000 },
  {
    alive = processIsAlive,
    readCommand = commandForPid,
    signal = process.kill,
    wait = sleep
  } = {}
) {
  const snapshot = lifecycleSnapshot(registryPath, { alive });
  const foreground = snapshot.foreground;
  if (!foreground) return { stopped: false, reason: "not-running" };

  let command;
  try {
    command = readCommand(foreground.pid);
  } catch {
    reconcileHostRegistry(registryPath, { alive });
    return { stopped: false, reason: "not-running" };
  }
  if (!command.includes(resolve(expectedLauncher))) {
    throw new Error(
      `Refusing to stop PID ${foreground.pid}: it is not the registered OpenCode Command Center launcher.`
    );
  }

  signal(foreground.pid, "SIGTERM");
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (
    let attempt = 0;
    attempt < attempts && alive(foreground.pid);
    attempt++
  ) {
    wait(100);
  }
  if (alive(foreground.pid)) {
    throw new Error(
      `OpenCode Command Center PID ${foreground.pid} did not stop within ${timeoutMs}ms.`
    );
  }
  reconcileHostRegistry(registryPath, { alive });
  return {
    stopped: true,
    projectId: foreground.projectId,
    canonicalPath: foreground.canonicalPath,
    pid: foreground.pid
  };
}

export function formatRecentProjects(snapshot) {
  if (snapshot.projects.length === 0) return "No recent projects yet.";
  return snapshot.projects
    .map((project, index) => {
      const availability = project.exists ? "" : " (missing)";
      const opened = project.lastOpenedAt ?? "unknown";
      return `${index + 1}. ${project.name}${availability}\n   ${project.canonicalPath}\n   ${project.profile} · last opened ${opened}`;
    })
    .join("\n");
}

export function formatLifecycleStatus(snapshot) {
  const foreground = snapshot.foreground
    ? `${snapshot.foreground.canonicalPath}\n  PID ${snapshot.foreground.pid} · ${snapshot.foreground.profile}`
    : "none";
  return [
    `Foreground: ${foreground}`,
    `Background sessions: ${snapshot.backgroundSessions.length}`,
    `Known projects: ${snapshot.projects.length}`
  ].join("\n");
}
