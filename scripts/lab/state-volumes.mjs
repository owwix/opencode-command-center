import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  unlinkSync
} from "node:fs";
import { join, resolve } from "node:path";

const PERSISTENT =
  /^opencode-lab-(?:project_[a-f0-9]+|run_[a-f0-9]+)-(?:opencode-state|opencode-user-config|open-design-state|hound-state|notion-publisher-state)$/u;
const RESTORED = /^opencode-lab-restore-[a-f0-9]{32}$/u;
const SUFFIXES = [
  "opencode-state",
  "opencode-user-config",
  "open-design-state",
  "hound-state",
  "notion-publisher-state",
  "opencode-package-cache",
  "opencode-tmp"
];

function call(runner, args, options = {}) {
  const result = runner("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    ...options
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `State-volume operation failed (${args[0]}): ${result.error?.message ?? result.stderr ?? "Docker returned an error"}`
    );
  return String(result.stdout ?? "").trim();
}

export function volumeEnvironment(namespace, mapping = {}) {
  if (!/^(?:project|run)_[a-f0-9]+$/u.test(namespace))
    throw new Error("Invalid volume namespace.");
  return Object.fromEntries(
    SUFFIXES.map((suffix) => {
      const logical = `opencode-lab-${namespace}-${suffix}`;
      const physical = mapping[logical] ?? logical;
      if (physical !== logical && !RESTORED.test(physical))
        throw new Error("Invalid restored volume identity.");
      return [
        `OPENCODE_VOLUME_${suffix.replaceAll("-", "_").toUpperCase()}`,
        physical
      ];
    })
  );
}

export function fileDigest(path) {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function snapshotVolumes({
  directory,
  image,
  mapping = {},
  release = null,
  schemas = {},
  runner = spawnSync
}) {
  if (!/@sha256:[a-f0-9]{64}$/u.test(image))
    throw new Error("State backup requires a digest-pinned image.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const available = call(runner, ["volume", "ls", "-q"])
    .split(/\r?\n/u)
    .filter(Boolean);
  const reverse = new Map(
    Object.entries(mapping).map(([logical, physical]) => [physical, logical])
  );
  const volumes = available
    .filter((name) => PERSISTENT.test(name) || reverse.has(name))
    .filter((name) => {
      const logical = reverse.get(name) ?? name;
      return PERSISTENT.test(logical) && (mapping[logical] ?? logical) === name;
    });
  // Refuse active readers/writers rather than snapshotting a live SQLite WAL or
  // interrupting the user's session. The host maintenance lock blocks launches.
  for (const name of volumes) {
    if (call(runner, ["ps", "-q", "--filter", `volume=${name}`]))
      throw new Error(
        `Stop the workspace using ${name} before updating or rolling back.`
      );
  }
  const records = [];
  for (const name of volumes) {
    const archive = `${records.length}.tar`;
    const fd = openSync(join(directory, archive), "wx", 0o600);
    try {
      call(
        runner,
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "0:0",
          "--mount",
          `type=volume,src=${name},dst=/state,readonly`,
          "--entrypoint",
          "tar",
          image,
          "-cf",
          "-",
          "-C",
          "/state",
          "."
        ],
        { stdio: ["ignore", fd, "pipe"] }
      );
    } finally {
      closeSync(fd);
    }
    const logical = reverse.get(name) ?? name;
    records.push({
      logical,
      source: name,
      projectId: logical.match(
        /^opencode-lab-((?:project|run)_[a-f0-9]+)-/u
      )?.[1],
      archive,
      sha256: fileDigest(join(directory, archive))
    });
  }
  const manifest = {
    schemaVersion: 2,
    release,
    schemas,
    image,
    createdAt: new Date().toISOString(),
    volumes: records
  };
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 }
  );
  return manifest;
}

export function restoreVolumes({ directory, runner = spawnSync }) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8")
  );
  if (
    manifest.schemaVersion !== 2 ||
    !Array.isArray(manifest.volumes) ||
    !/@sha256:[a-f0-9]{64}$/u.test(manifest.image)
  )
    throw new Error("Invalid volume backup manifest.");
  const names = new Set();
  // Validate every archive before creating anything. No old volume is deleted.
  for (const record of manifest.volumes) {
    if (
      !PERSISTENT.test(record.logical) ||
      names.has(record.logical) ||
      !/^\d+\.tar$/u.test(record.archive) ||
      fileDigest(join(directory, record.archive)) !== record.sha256
    )
      throw new Error("Volume backup identity or checksum mismatch.");
    names.add(record.logical);
  }
  const mapping = {};
  for (const record of manifest.volumes) {
    const name = `opencode-lab-restore-${randomUUID().replaceAll("-", "")}`;
    call(runner, [
      "volume",
      "create",
      "--label",
      `opencode-lab.logical=${record.logical}`,
      "--label",
      "opencode-lab.recovery=true",
      name
    ]);
    call(runner, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "0:0",
      "--mount",
      `type=volume,src=${name},dst=/state`,
      "--mount",
      `type=bind,src=${resolve(directory, record.archive)},dst=/backup.tar,readonly`,
      "--entrypoint",
      "tar",
      manifest.image,
      "-xf",
      "/backup.tar",
      "-C",
      "/state"
    ]);
    mapping[record.logical] = name;
  }
  return mapping;
}

export function probeSessionCopies({ mapping, image, runner = spawnSync }) {
  for (const [logical, physical] of Object.entries(mapping)) {
    if (!logical.endsWith("-opencode-state")) continue;
    const owner = call(runner, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=volume,src=${physical},dst=/state,readonly`,
      "--entrypoint",
      "stat",
      image,
      "-c",
      "%u:%g",
      "/state"
    ]);
    if (!/^\d+:\d+$/u.test(owner))
      throw new Error("Could not determine session volume ownership.");
    call(runner, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      owner,
      "--tmpfs",
      "/tmp:exec",
      "--tmpfs",
      "/home/opencode:mode=1777",
      "-e",
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      "-e",
      "XDG_DATA_HOME=/data",
      "--mount",
      `type=volume,src=${physical},dst=/data/opencode`,
      "--entrypoint",
      "opencode",
      image,
      "session",
      "list",
      "--format",
      "json"
    ]);
  }
}

export function assertNoMaintenance(updatesRoot) {
  const path = join(updatesRoot, "maintenance.lock");
  if (!existsSync(path)) return;
  const owner = readFileSync(path, "utf8");
  const pid = Number(owner);
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH" && readFileSync(path, "utf8") === owner) {
        unlinkSync(path);
        return;
      }
      if (error.code !== "ESRCH") throw error;
    }
  }
  throw new Error(
    "Lab update/rollback is in progress. Wait for maintenance to finish before launching."
  );
}
