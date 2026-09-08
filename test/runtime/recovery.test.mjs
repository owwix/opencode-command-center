import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  snapshotVolumes,
  restoreVolumes,
  probeSessionCopies
} from "../../scripts/lab/state-volumes.mjs";

const enabled = process.env.LAB_RUNTIME_TESTS === "1";
const lock = JSON.parse(
  readFileSync(new URL("../../versions.lock", import.meta.url))
);
const image = lock.runtimes.node.image;
const opencode = process.env.LAB_RUNTIME_IMAGE ?? "opencode-lab-opencode:local";
function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    ...options
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return String(result.stdout ?? "").trim();
}

test(
  "real session volume is copied and restored into a fresh generation without overwriting newer state",
  { skip: !enabled, timeout: 240000 },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), "lab-volume-runtime-"));
    const original = `opencode-lab-project_${randomUUID().replaceAll("-", "")}-opencode-state`;
    const owned = [original];
    t.after(() => {
      for (const volume of owned) docker(["volume", "rm", volume]);
      rmSync(directory, { recursive: true, force: true });
    });
    docker(["volume", "create", original]);
    // Use the pinned binary to initialize an actual session database, not a mock.
    const sessionArgs = (name) => [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--tmpfs",
      "/tmp:exec",
      "--tmpfs",
      "/home/opencode",
      "-e",
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      "-e",
      "XDG_DATA_HOME=/data",
      "--mount",
      `type=volume,src=${name},dst=/data/opencode`,
      "--entrypoint",
      "opencode",
      opencode,
      "session",
      "list",
      "--format",
      "json"
    ];
    const before = docker(sessionArgs(original));
    const change = (name, value) =>
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=volume,src=${name},dst=/state`,
        "--entrypoint",
        "node",
        image,
        "-e",
        `require('node:fs').writeFileSync('/state/tui-fixture.json', JSON.stringify(${JSON.stringify(value)}))`
      ]);
    change(original, { theme: "dracula", schema: 1 });
    const runner = (command, args, options) =>
      args[0] === "volume" && args[1] === "ls"
        ? { status: 0, stdout: original }
        : spawnSync(command, args, options);
    snapshotVolumes({ directory, image, schemas: { session: 1 }, runner });
    change(original, { theme: "newer-theme", schema: 999 });
    const restored = restoreVolumes({ directory, runner });
    owned.push(...Object.values(restored));
    assert.notEqual(restored[original], original);
    probeSessionCopies({ mapping: restored, image: opencode, runner });
    assert.equal(docker(sessionArgs(restored[original])), before);
    const read = (name) =>
      JSON.parse(
        docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${name},dst=/state,readonly`,
          "--entrypoint",
          "cat",
          image,
          "/state/tui-fixture.json"
        ])
      );
    assert.deepEqual(read(restored[original]), { theme: "dracula", schema: 1 });
    assert.deepEqual(read(original), { theme: "newer-theme", schema: 999 });
  }
);
