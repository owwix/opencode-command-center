import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshotVolumes,
  restoreVolumes,
  volumeEnvironment
} from "./state-volumes.mjs";

const image = `node@sha256:${"a".repeat(64)}`;
test("backups verify checksums, exclude caches and restore only fresh volume names", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lab-volume-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = "opencode-lab-project_abcd-opencode-state";
  const calls = [];
  const runner = (_command, args, options) => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls")
      return {
        status: 0,
        stdout: `${name}\nopencode-lab-project_abcd-opencode-tmp\nunrelated-data`
      };
    if (args.includes("-cf"))
      writeFileSync(options.stdio[1], "fixture-tar-content");
    return { status: 0, stdout: "" };
  };
  const manifest = snapshotVolumes({
    directory,
    image,
    runner,
    schemas: { session: 1 }
  });
  assert.equal(manifest.volumes.length, 1);
  const first = restoreVolumes({ directory, runner });
  const second = restoreVolumes({ directory, runner });
  assert.notEqual(first[name], second[name]);
  assert.match(first[name], /^opencode-lab-restore-/);
  assert.equal(
    volumeEnvironment("project_abcd", first).OPENCODE_VOLUME_OPENCODE_STATE,
    first[name]
  );
  assert.ok(calls.every((args) => !args.includes("rm")));
  writeFileSync(join(directory, "0.tar"), "tampered");
  assert.throws(() => restoreVolumes({ directory, runner }), /checksum/);
  assert.throws(
    () => volumeEnvironment("project_abcd", { [name]: "production-database" }),
    /identity/
  );
  assert.equal(
    JSON.parse(readFileSync(join(directory, "manifest.json"))).schemaVersion,
    2
  );
});

test("snapshot refuses an active writer before starting tar", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lab-volume-busy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const runner = (_command, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout:
        args[0] === "volume"
          ? "opencode-lab-project_abcd-opencode-state"
          : "active-container-id"
    };
  };
  assert.throws(
    () => snapshotVolumes({ directory, image, runner }),
    /Stop the workspace/
  );
  assert.ok(calls.every((args) => args[0] !== "run"));
});
