/**
 * Host-owned project and foreground-launch registry.
 *
 * Canonical paths map to stable project IDs. Exactly one verified foreground
 * interactive launch is registered at a time, while background runs may
 * coexist. Registration tokens bind start/stop/unregister operations to the
 * exact launcher and are never exposed to project code. Registry files are
 * size/type checked, lock-protected, and atomically replaced; stale PIDs are
 * reconciled rather than trusted. Reference: docs/architecture.md.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export const HOST_REGISTRY_SCHEMA_VERSION = 1;

function emptyRegistry() {
  return {
    schemaVersion: HOST_REGISTRY_SCHEMA_VERSION,
    foreground: null,
    projects: {}
  };
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function projectIdentity(workspace) {
  const canonicalPath = realpathSync(resolve(workspace));
  const workspaceHash = createHash("sha256")
    .update(canonicalPath)
    .digest("hex");
  return {
    canonicalPath,
    workspaceHash,
    projectId: `project_${workspaceHash.slice(0, 24)}`
  };
}

export function registrationTokenHash(token) {
  const value = String(token ?? "");
  if (value.length < 32) throw new Error("Registration token is invalid.");
  return createHash("sha256").update(value).digest("hex");
}

export function readHostRegistry(registryPath) {
  if (!existsSync(registryPath)) return emptyRegistry();
  if (!lstatSync(registryPath).isFile()) {
    throw new Error("Host registry must be a regular file.");
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (
    parsed?.schemaVersion !== HOST_REGISTRY_SCHEMA_VERSION ||
    !parsed.projects ||
    typeof parsed.projects !== "object"
  ) {
    throw new Error("Host registry schema is unsupported.");
  }
  return parsed;
}

function writeHostRegistry(registryPath, registry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(registry, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, registryPath);
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds
  );
}

function withRegistryLock(registryPath, operation) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  let descriptor;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        // A partial stale lock is handled below.
      }
      if (!processIsAlive(owner)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      sleep(10);
    }
  }
  if (descriptor === undefined) throw new Error("Host registry is busy.");
  let result;
  let operationError;
  try {
    const registry = readHostRegistry(registryPath);
    result = operation(registry);
    writeHostRegistry(registryPath, registry);
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && cleanupError === undefined) {
      cleanupError = error;
    }
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

function activeForeground(registry, alive = processIsAlive) {
  const foreground = registry.foreground;
  if (!foreground) return null;
  if (alive(foreground.pid)) return foreground;
  const project = registry.projects[foreground.projectId];
  if (project?.activeLaunch?.launchId === foreground.launchId) {
    project.activeLaunch = null;
    delete project.sessions?.[foreground.sessionId];
  }
  registry.foreground = null;
  return null;
}

export function reconcileHostRegistry(
  registryPath,
  { alive = processIsAlive } = {}
) {
  return withRegistryLock(registryPath, (registry) => {
    activeForeground(registry, alive);
    for (const project of Object.values(registry.projects)) {
      for (const [sessionId, session] of Object.entries(
        project.sessions ?? {}
      )) {
        if (session.background && !alive(session.pid)) {
          if (session.resources) session.interrupted = true;
          else delete project.sessions[sessionId];
        }
      }
    }
    return structuredClone(registry);
  });
}

export function finishManagedRecovery(registryPath, launchId) {
  return withRegistryLock(registryPath, (registry) => {
    for (const project of Object.values(registry.projects ?? {})) {
      for (const [id, session] of Object.entries(project.sessions ?? {})) {
        if (
          session.launchId === launchId &&
          session.background &&
          !processIsAlive(session.pid)
        )
          delete project.sessions[id];
      }
    }
  });
}

export function registerForegroundLaunch(
  {
    registryPath,
    identity,
    launchId,
    sessionId,
    runId,
    profile,
    packRoots = [],
    pid = process.pid,
    registrationToken,
    conflictAction = "reject",
    now = () => new Date().toISOString()
  },
  {
    alive = processIsAlive,
    stop = () => {
      throw new Error(
        "Foreground replacement requires a verified stop handler."
      );
    }
  } = {}
) {
  return withRegistryLock(registryPath, (registry) => {
    const existing = activeForeground(registry, alive);
    if (existing && existing.launchId !== launchId) {
      if (conflictAction === "resume") {
        return { registered: false, action: "resume", existing };
      }
      if (conflictAction !== "stop") {
        return { registered: false, action: "conflict", existing };
      }
      stop(existing.pid);
      const prior = registry.projects[existing.projectId];
      if (prior?.activeLaunch?.launchId === existing.launchId) {
        prior.activeLaunch = null;
        delete prior.sessions?.[existing.sessionId];
      }
      registry.foreground = null;
    }

    const openedAt = now();
    const launch = {
      packRoots: [...packRoots],
      launchId,
      sessionId,
      runId,
      pid,
      profile,
      registrationTokenHash: registrationTokenHash(registrationToken),
      startedAt: openedAt
    };
    const priorProject = registry.projects[identity.projectId] ?? {};
    registry.projects[identity.projectId] = {
      ...priorProject,
      projectId: identity.projectId,
      canonicalPath: identity.canonicalPath,
      workspaceHash: identity.workspaceHash,
      profile,
      activeLaunch: launch,
      sessions: {
        ...(priorProject.sessions ?? {}),
        [sessionId]: {
          launchId,
          runId,
          profile,
          pid,
          registrationTokenHash: launch.registrationTokenHash,
          openedAt
        }
      },
      helpers: priorProject.helpers ?? {},
      runs: priorProject.runs ?? [],
      lastOpenedAt: openedAt
    };
    registry.foreground = {
      projectId: identity.projectId,
      workspaceHash: identity.workspaceHash,
      canonicalPath: identity.canonicalPath,
      ...launch
    };
    return { registered: true, launch: registry.foreground };
  });
}

export function unregisterForegroundLaunch({
  registryPath,
  launchId,
  registrationToken
}) {
  return withRegistryLock(registryPath, (registry) => {
    const foreground = registry.foreground;
    if (
      !foreground ||
      foreground.launchId !== launchId ||
      foreground.registrationTokenHash !==
        registrationTokenHash(registrationToken)
    ) {
      return false;
    }
    const project = registry.projects[foreground.projectId];
    if (project?.activeLaunch?.launchId === launchId) {
      project.activeLaunch = null;
      delete project.sessions[foreground.sessionId];
    }
    registry.foreground = null;
    return true;
  });
}

export function registerBackgroundLaunch({
  registryPath,
  identity,
  launchId,
  sessionId,
  runId,
  profile,
  packRoots = [],
  resources = null,
  pid = process.pid,
  registrationToken,
  now = () => new Date().toISOString()
}) {
  return withRegistryLock(registryPath, (registry) => {
    const openedAt = now();
    const priorProject = registry.projects[identity.projectId] ?? {};
    const sessions = priorProject.sessions ?? {};
    sessions[sessionId] = {
      resources,
      packRoots: [...packRoots],
      launchId,
      runId,
      profile,
      pid,
      background: true,
      registrationTokenHash: registrationTokenHash(registrationToken),
      openedAt
    };
    const runs = new Set(priorProject.runs ?? []);
    runs.add(runId);
    registry.projects[identity.projectId] = {
      ...priorProject,
      projectId: identity.projectId,
      canonicalPath: identity.canonicalPath,
      workspaceHash: identity.workspaceHash,
      profile,
      activeLaunch: priorProject.activeLaunch ?? null,
      sessions,
      helpers: priorProject.helpers ?? {},
      runs: [...runs],
      lastOpenedAt: openedAt
    };
    return { registered: true, session: sessions[sessionId] };
  });
}

export function unregisterBackgroundLaunch({
  registryPath,
  projectId,
  sessionId,
  registrationToken
}) {
  return withRegistryLock(registryPath, (registry) => {
    const project = registry.projects[projectId];
    const session = project?.sessions?.[sessionId];
    if (
      !session ||
      !session.background ||
      session.registrationTokenHash !== registrationTokenHash(registrationToken)
    ) {
      return false;
    }
    delete project.sessions[sessionId];
    return true;
  });
}

export function lookupRegistration(registryPath, registrationToken) {
  const wanted = registrationTokenHash(registrationToken);
  const registry = readHostRegistry(registryPath);
  const launch = registry.foreground;
  if (launch?.registrationTokenHash === wanted && processIsAlive(launch.pid)) {
    return {
      projectId: launch.projectId,
      workspaceHash: launch.workspaceHash,
      canonicalPath: launch.canonicalPath,
      launchId: launch.launchId,
      sessionId: launch.sessionId,
      runId: launch.runId,
      profile: launch.profile,
      packRoots: launch.packRoots ?? []
    };
  }
  for (const project of Object.values(registry.projects)) {
    for (const [sessionId, session] of Object.entries(project.sessions ?? {})) {
      if (
        session.background &&
        session.registrationTokenHash === wanted &&
        processIsAlive(session.pid)
      ) {
        return {
          projectId: project.projectId,
          workspaceHash: project.workspaceHash,
          canonicalPath: project.canonicalPath,
          launchId: session.launchId,
          sessionId,
          runId: session.runId,
          profile: session.profile,
          packRoots: session.packRoots ?? []
        };
      }
    }
  }
  return null;
}

export function recordProjectHelper({
  registryPath,
  projectId,
  launchId,
  helper,
  pid,
  port,
  workspaceHash,
  now = () => new Date().toISOString()
}) {
  return withRegistryLock(registryPath, (registry) => {
    const project = registry.projects[projectId];
    if (!project || project.activeLaunch?.launchId !== launchId) return false;
    project.helpers[helper] = {
      pid,
      port,
      launchId,
      projectId,
      workspaceHash,
      updatedAt: now()
    };
    return true;
  });
}
