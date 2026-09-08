import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  readCompatibilityManifest,
  runCompatibilityChecks
} from "./compatibility.mjs";
import { labHostPaths } from "./host-state.mjs";
import {
  snapshotVolumes,
  restoreVolumes,
  probeSessionCopies
} from "./state-volumes.mjs";
import { withMaintenance } from "./maintenance.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_REF = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;
const IMAGE_ENV = Object.freeze({
  opencode: "OPENCODE_LAB_OPENCODE_IMAGE",
  gateway: "OPENCODE_LAB_GATEWAY_IMAGE",
  preview: "OPENCODE_LAB_PREVIEW_IMAGE",
  notion: "OPENCODE_LAB_NOTION_IMAGE",
  hound: "OPENCODE_LAB_HOUND_IMAGE",
  houndFirewall: "OPENCODE_LAB_HOUND_FIREWALL_IMAGE",
  houndRelay: "OPENCODE_LAB_HOUND_RELAY_IMAGE"
});

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  renameSync(temporary, path);
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw new Error(`Unsafe Lab update state: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function execute(runner, command, args, options = {}) {
  const result = runner(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio
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

function gitHead(root, runner = spawnSync) {
  return execute(runner, "git", ["-C", root, "rev-parse", "HEAD"]);
}

export function defaultReleaseImages() {
  return {
    [IMAGE_ENV.opencode]: "opencode-lab-opencode:local",
    [IMAGE_ENV.gateway]: "opencode-lab-agent-gateway:local",
    [IMAGE_ENV.preview]: "opencode-lab-opencode-preview:local",
    [IMAGE_ENV.notion]: "opencode-lab-notion-publisher:local",
    [IMAGE_ENV.hound]: "opencode-lab-hound:13.1.2",
    [IMAGE_ENV.houndFirewall]: "opencode-lab-hound-firewall:local",
    [IMAGE_ENV.houndRelay]: "opencode-lab-hound-relay:local"
  };
}

export function candidateImagePlan(root, commit) {
  if (!COMMIT.test(commit)) throw new Error("Candidate commit must be exact.");
  const suffix = commit.slice(0, 12);
  const tag = (name) => `opencode-lab-${name}:candidate-${suffix}`;
  const images = {
    [IMAGE_ENV.opencode]: tag("opencode"),
    [IMAGE_ENV.gateway]: tag("agent-gateway"),
    [IMAGE_ENV.preview]: tag("opencode-preview"),
    [IMAGE_ENV.notion]: tag("notion-publisher"),
    [IMAGE_ENV.hound]: tag("hound"),
    [IMAGE_ENV.houndFirewall]: tag("hound-firewall"),
    [IMAGE_ENV.houndRelay]: tag("hound-relay")
  };
  return {
    images,
    builds: [
      {
        name: "opencode",
        args: [
          "build",
          "-f",
          "Dockerfile.opencode",
          "-t",
          images[IMAGE_ENV.opencode],
          "."
        ]
      },
      {
        name: "agent-gateway",
        args: ["build", "-t", images[IMAGE_ENV.gateway], "docker/agent-gateway"]
      },
      {
        name: "opencode-preview",
        args: [
          "build",
          "-t",
          images[IMAGE_ENV.preview],
          "docker/opencode-preview"
        ]
      },
      {
        name: "notion-publisher",
        args: [
          "build",
          "-f",
          "docker/notion-publisher/Dockerfile",
          "-t",
          images[IMAGE_ENV.notion],
          "."
        ]
      },
      {
        name: "hound",
        args: ["build", "-t", images[IMAGE_ENV.hound], "docker/hound"]
      },
      {
        name: "hound-firewall",
        args: [
          "build",
          "-t",
          images[IMAGE_ENV.houndFirewall],
          "docker/hound-firewall"
        ]
      },
      {
        name: "hound-relay",
        args: [
          "build",
          "-t",
          images[IMAGE_ENV.houndRelay],
          "docker/hound-relay"
        ]
      }
    ].map((build) => ({ ...build, cwd: resolve(root) }))
  };
}

function copyStateTree(source, destination, excluded = []) {
  if (!existsSync(source)) return false;
  const exclusions = excluded.map((path) => resolve(path));
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    filter(path) {
      const resolved = resolve(path);
      if (
        exclusions.some(
          (excludedPath) =>
            resolved === excludedPath ||
            resolved.startsWith(`${excludedPath}${sep}`)
        )
      )
        return false;
      return !lstatSync(path).isSymbolicLink();
    }
  });
  return true;
}

export function backupLabState({
  paths = labHostPaths(),
  label = new Date().toISOString().replaceAll(":", "-")
} = {}) {
  const safeLabel = String(label)
    .replaceAll(/[^A-Za-z0-9._-]/gu, "-")
    .slice(0, 100);
  const destination = join(paths.backupsRoot, safeLabel);
  if (existsSync(destination))
    throw new Error(`Backup already exists: ${destination}`);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyStateTree(paths.stateRoot, join(destination, "state"), [
    paths.releasesRoot,
    paths.updatesRoot
  ]);
  copyStateTree(paths.configRoot, join(destination, "config"));
  atomicJson(join(destination, "backup.json"), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    stateRoot: paths.stateRoot,
    configRoot: paths.configRoot
  });
  return destination;
}

export function readActiveRelease(paths = labHostPaths()) {
  return readJson(join(paths.updatesRoot, "active.json"));
}

function readHistory(paths) {
  return readJson(join(paths.updatesRoot, "history.json"), {
    schemaVersion: 1,
    records: []
  });
}

export function activateRelease({
  paths = labHostPaths(),
  release,
  previous = null
}) {
  if (!COMMIT.test(release?.commit ?? ""))
    throw new Error("Release commit is invalid.");
  const releasePath = resolve(release.path);
  if (!existsSync(join(releasePath, "scripts", "opencode-entry.mjs")))
    throw new Error("Release does not contain the Lab launcher.");
  const record = {
    schemaVersion: 1,
    commit: release.commit,
    path: releasePath,
    images: release.images ?? defaultReleaseImages(),
    compatibility: release.compatibility ?? null,
    stateVolumes: release.stateVolumes ?? {},
    stateSchemas: release.stateSchemas ?? null,
    backup: release.backup ?? null,
    activatedAt: new Date().toISOString(),
    previous: previous
      ? {
          schemaVersion: 1,
          commit: previous.commit,
          path: previous.path,
          images: previous.images ?? defaultReleaseImages(),
          compatibility: previous.compatibility ?? null,
          stateVolumes: previous.stateVolumes ?? {},
          stateSchemas: previous.stateSchemas ?? null,
          backup: previous.backup ?? null,
          activatedAt: previous.activatedAt ?? null
        }
      : null
  };
  const history = readHistory(paths);
  history.records.push(record);
  history.records = history.records.slice(-100);
  atomicJson(join(paths.updatesRoot, "history.json"), history);
  atomicJson(join(paths.updatesRoot, "active.json"), record);
  return record;
}

export function applyActiveImageEnvironment(active, env = process.env) {
  for (const [name, value] of Object.entries(active?.images ?? {})) {
    if (Object.values(IMAGE_ENV).includes(name) && typeof value === "string")
      env[name] = value;
  }
  return env;
}

export function dispatchActiveRelease({
  packageRoot,
  args,
  paths = labHostPaths(),
  runner = spawnSync,
  env = process.env
}) {
  const active = readActiveRelease(paths);
  applyActiveImageEnvironment(active, env);
  if (!active || resolve(active.path) === resolve(packageRoot)) return null;
  const launcher = join(resolve(active.path), "scripts", "opencode-entry.mjs");
  if (!existsSync(launcher))
    throw new Error("Active Lab release is unavailable; run occtl rollback.");
  const result = runner(process.execPath, [launcher, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...env, OPENCODE_LAB_RELEASE_DISPATCHED: "1" }
  });
  return result.status ?? 1;
}

function stageCandidateImages({ root, commit, manifest, runner }) {
  const remoteImages = [
    manifest.runtimes.node.image,
    manifest.components.opencode.image,
    manifest.components.openDesign.image,
    manifest.images.stateInit
  ];
  for (const image of remoteImages) execute(runner, "docker", ["pull", image]);
  const plan = candidateImagePlan(root, commit);
  for (const build of plan.builds)
    execute(runner, "docker", build.args, {
      cwd: build.cwd,
      timeout: 20 * 60 * 1000
    });
  const versionOutput = execute(
    runner,
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "opencode",
      plan.images[IMAGE_ENV.opencode],
      "--version"
    ],
    { timeout: 2 * 60 * 1000 }
  );
  if (!versionOutput.includes(manifest.components.opencode.version))
    throw new Error("Candidate OpenCode image reported an unexpected version.");
  const configOutput = execute(
    runner,
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "opencode",
      "-e",
      "OPENCODE_CONFIG=/compat/opencode.json",
      "-v",
      `${join(root, "test", "compatibility", "opencode-v1")}:/compat:ro`,
      plan.images[IMAGE_ENV.opencode],
      "debug",
      "config"
    ],
    { timeout: 2 * 60 * 1000 }
  );
  if (!/cloudflare/iu.test(configOutput))
    throw new Error("Candidate OpenCode image rejected config adapter v1.");
  return plan.images;
}

function updateUnderMaintenance({
  packageRoot,
  ref = "main",
  paths = labHostPaths(),
  runner = spawnSync
}) {
  if (!SAFE_REF.test(ref)) throw new Error("Update ref is invalid.");
  const repository = resolve(packageRoot);
  execute(runner, "git", ["-C", repository, "fetch", "--tags", "origin", ref]);
  const commit = execute(runner, "git", [
    "-C",
    repository,
    "rev-parse",
    "FETCH_HEAD"
  ]);
  if (!COMMIT.test(commit))
    throw new Error("Update did not resolve an exact commit.");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "opencode-lab-update-"));
  const candidate = join(temporaryRoot, "candidate");
  const releasePath = join(paths.releasesRoot, commit);
  try {
    if (!existsSync(releasePath)) {
      execute(runner, "git", [
        "clone",
        "--no-checkout",
        "--local",
        repository,
        candidate
      ]);
      execute(runner, "git", ["-C", candidate, "fetch", repository, commit]);
      execute(runner, "git", ["-C", candidate, "checkout", "--detach", commit]);
    }
    const stagedRoot = existsSync(releasePath) ? releasePath : candidate;
    const compatibility = runCompatibilityChecks({ root: stagedRoot });
    if (!compatibility.passed)
      throw new Error("Candidate compatibility checks failed.");
    const manifest = readCompatibilityManifest(stagedRoot);
    const images = stageCandidateImages({
      root: stagedRoot,
      commit,
      manifest,
      runner
    });
    const backup = backupLabState({
      paths,
      label: `before-${commit.slice(0, 12)}-${Date.now()}`
    });
    const active = readActiveRelease(paths);
    const volumeDirectory = join(backup, "volumes");
    snapshotVolumes({
      directory: volumeDirectory,
      image: manifest.runtimes.node.image,
      mapping: active?.stateVolumes ?? {},
      release: active?.commit ?? gitHead(repository, runner),
      schemas: active?.stateSchemas ?? {},
      runner
    });
    const stateVolumes = restoreVolumes({ directory: volumeDirectory, runner });
    probeSessionCopies({
      mapping: stateVolumes,
      image: images[IMAGE_ENV.opencode],
      runner
    });
    if (!existsSync(releasePath)) {
      mkdirSync(paths.releasesRoot, { recursive: true });
      renameSync(candidate, releasePath);
    }
    const current = readActiveRelease(paths) ?? {
      schemaVersion: 1,
      commit: gitHead(repository, runner),
      path: repository,
      images: defaultReleaseImages(),
      activatedAt: null,
      previous: null
    };
    return activateRelease({
      paths,
      release: {
        commit,
        path: releasePath,
        images,
        compatibility,
        backup,
        stateVolumes,
        stateSchemas: {
          ...manifest.schemas,
          opencode: manifest.components.opencode.version
        }
      },
      previous: current
    });
  } finally {
    if (
      existsSync(temporaryRoot) &&
      basename(temporaryRoot).startsWith("opencode-lab-update-")
    )
      rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function rollbackUnderMaintenance({
  packageRoot,
  paths = labHostPaths(),
  runner = spawnSync
}) {
  const active = readActiveRelease(paths);
  if (!active?.previous)
    throw new Error("No previous Lab release is available.");
  const previous = active.previous;
  if (
    !existsSync(join(resolve(previous.path), "scripts", "opencode-entry.mjs"))
  )
    throw new Error("Previous Lab release is unavailable.");
  const backup = backupLabState({
    paths,
    label: `before-rollback-${Date.now()}`
  });
  let stateVolumes = active.stateVolumes ?? {};
  if (active.stateSchemas) {
    const manifest = readCompatibilityManifest(resolve(packageRoot));
    snapshotVolumes({
      directory: join(backup, "volumes"),
      image: manifest.runtimes.node.image,
      mapping: stateVolumes,
      release: active.commit,
      schemas: active.stateSchemas,
      runner
    });
    if (
      JSON.stringify(active.stateSchemas) !==
      JSON.stringify(previous.stateSchemas)
    ) {
      if (
        !active.backup ||
        !existsSync(join(active.backup, "volumes", "manifest.json"))
      )
        throw new Error(
          "Rollback requires a verified pre-upgrade volume backup; the legacy host-only backup is insufficient."
        );
      stateVolumes = restoreVolumes({
        directory: join(active.backup, "volumes"),
        runner
      });
      probeSessionCopies({
        mapping: stateVolumes,
        image:
          previous.images?.[IMAGE_ENV.opencode] ??
          defaultReleaseImages()[IMAGE_ENV.opencode],
        runner
      });
    }
  }
  return activateRelease({
    paths,
    release: {
      ...previous,
      stateVolumes,
      commit: previous.commit ?? gitHead(resolve(packageRoot), runner),
      backup
    },
    previous: active
  });
}

export function performUpdate(options) {
  const paths = options.paths ?? labHostPaths();
  return withMaintenance(paths, () =>
    updateUnderMaintenance({ ...options, paths })
  );
}

export function rollbackRelease(options) {
  const paths = options.paths ?? labHostPaths();
  return withMaintenance(paths, () =>
    rollbackUnderMaintenance({ ...options, paths })
  );
}

export function versionInfo({
  packageRoot,
  paths = labHostPaths(),
  runner = spawnSync
}) {
  const root = resolve(packageRoot);
  return {
    package: JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .version,
    commit: gitHead(root, runner),
    compatibility: readCompatibilityManifest(root),
    active: readActiveRelease(paths)
  };
}
