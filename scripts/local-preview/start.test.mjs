import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildStartCommand,
  chooseDevScript,
  detectPackageManager,
  hostUrlForPort,
  processAlive,
  startManagedProcess,
  statePaths,
  stopManagedProcess,
  waitForPort
} from "./start-lib.mjs";

function tempWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), "lab-preview-"));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

test("detects package manager from lockfiles", () => {
  const pnpm = tempWorkspace({
    "package.json": '{"scripts":{"dev":"next dev"}}',
    "pnpm-lock.yaml": "lockfileVersion: 9\n"
  });
  const npm = tempWorkspace({
    "package.json": '{"scripts":{"dev":"next dev"}}',
    "package-lock.json": "{}\n"
  });
  try {
    assert.equal(detectPackageManager(pnpm), "pnpm");
    assert.equal(detectPackageManager(npm), "npm");
    assert.equal(chooseDevScript({ dev: "x", start: "y" }), "dev");
    assert.equal(chooseDevScript({ start: "y" }), "start");
  } finally {
    rmSync(pnpm, { recursive: true, force: true });
    rmSync(npm, { recursive: true, force: true });
  }
});

test("buildStartCommand binds hostname and port for npm/pnpm", () => {
  const root = tempWorkspace({
    "package.json": JSON.stringify({ scripts: { dev: "next dev" } })
  });
  try {
    const npm = buildStartCommand({ workspace: root, port: 3000 });
    assert.equal(npm.file, "npm");
    assert.deepEqual(npm.args, [
      "run",
      "dev",
      "--",
      "--hostname",
      "0.0.0.0",
      "--port",
      "3000"
    ]);

    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const pnpm = buildStartCommand({ workspace: root, port: 3000 });
    assert.equal(pnpm.file, "pnpm");
    assert.equal(pnpm.args[0], "run");
    assert.equal(pnpm.args[1], "dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStartCommand accepts an explicit --cmd override", () => {
  const root = tempWorkspace({ "README.md": "x\n" });
  try {
    const start = buildStartCommand({
      workspace: root,
      command: "python -m http.server 3000 --bind 0.0.0.0"
    });
    assert.equal(start.file, "/bin/sh");
    assert.match(start.display, /http.server/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitForPort succeeds when probe eventually returns true", async () => {
  let calls = 0;
  const ok = await waitForPort(3000, {
    timeoutMs: 1000,
    intervalMs: 10,
    probe: async () => {
      calls += 1;
      return calls >= 3;
    },
    now: (() => {
      let t = 0;
      return () => {
        t += 20;
        return t;
      };
    })(),
    sleep: async () => {}
  });
  assert.equal(ok, true);
  assert.ok(calls >= 3);
});

test("waitForPort times out when probe never succeeds", async () => {
  const ok = await waitForPort(3000, {
    timeoutMs: 50,
    intervalMs: 10,
    probe: async () => false,
    now: (() => {
      let t = 0;
      return () => {
        t += 30;
        return t;
      };
    })(),
    sleep: async () => {}
  });
  assert.equal(ok, false);
});

test("startManagedProcess writes pid/meta and stop clears them", () => {
  const workspace = tempWorkspace({
    "package.json": JSON.stringify({ scripts: { dev: "next dev" } })
  });
  const stateDir = mkdtempSync(join(tmpdir(), "lab-preview-state-"));
  const spawned = [];
  try {
    const result = startManagedProcess(
      { workspace, stateDir, port: 3000 },
      {
        spawnImpl: (file, args, options) => {
          spawned.push({ file, args, options });
          return {
            pid: 4242,
            unref() {}
          };
        },
        openSyncImpl: () => 99,
        closeSyncImpl: () => {}
      }
    );
    assert.equal(result.pid, 4242);
    assert.equal(result.alreadyRunning, false);
    assert.equal(spawned[0].file, "npm");
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.env.HOST, "0.0.0.0");
    assert.equal(spawned[0].options.env.PORT, "3000");

    const paths = statePaths(stateDir);
    assert.equal(readFileSync(paths.pidFile, "utf8").trim(), "4242");
    const meta = JSON.parse(readFileSync(paths.metaFile, "utf8"));
    assert.equal(meta.pid, 4242);
    assert.match(meta.command, /npm run dev/);

    const kills = [];
    const stopped = stopManagedProcess(stateDir, {
      kill: (pid, signal) => {
        kills.push({ pid, signal });
      },
      alive: () => true
    });
    assert.equal(stopped.stopped, true);
    assert.deepEqual(kills[0], { pid: -4242, signal: "SIGTERM" });
    assert.equal(processAlive(null), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hostUrlForPort maps container ports to Mac preview URLs", () => {
  assert.equal(hostUrlForPort(3000), "http://127.0.0.1:3100");
  assert.equal(hostUrlForPort(3001), "http://127.0.0.1:3101");
  assert.equal(hostUrlForPort(4000), null);
});
