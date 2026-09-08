import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertDurableCleanupSafe,
  beginDurableAttempt,
  createDurableRun,
  finishDurableAttempt,
  hasUnpublishedChanges,
  linkDurableMembers,
  migrateLegacyRunState,
  migrateDurableRun,
  readDurableRun,
  reconcileDurableRuns,
  recordExternalAction,
  syncControllerRun
} from "./run-service.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "durable-run-service-"));
  return { root };
}

test("a crash after authoritative save repairs stale projections without losing PR receipts", () => {
  const { root } = fixture();
  try {
    const id = "run_revision_repair";
    const directory = join(root, "runs", id);
    mkdirSync(directory, { recursive: true });
    const before = {
      id,
      state: "prepared",
      revision: 1,
      task: "fixture",
      source: root
    };
    writeFileSync(join(directory, "run.json"), JSON.stringify(before));
    syncControllerRun({ root, run: before });
    const after = {
      ...before,
      revision: 2,
      state: "passed",
      publishing: {
        pr: {
          headSha: "abc123",
          base: "main",
          branch: "fixture",
          url: "https://example.test/pr/1"
        }
      }
    };
    writeFileSync(join(directory, "run.json"), JSON.stringify(after));
    const repaired = readDurableRun({ root, runId: id });
    assert.equal(repaired.state, "passed");
    assert.equal(repaired.controllerRevision, 2);
    assert.equal(
      repaired.externalActions.preparePr.receipt.url,
      "https://example.test/pr/1"
    );
    syncControllerRun({ root, run: before });
    assert.equal(readDurableRun({ root, runId: id }).controllerRevision, 2);
    assert.throws(() => migrateDurableRun({ id, schemaVersion: 999 }), /newer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("schema migration is idempotent and legacy controller runs are adopted", () => {
  const { root } = fixture();
  try {
    const legacy = {
      id: "run_legacy",
      state: "prepared",
      attempts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const migrated = migrateDurableRun(legacy);
    assert.deepEqual(migrateDurableRun(migrated), migrated);
    const directory = join(root, "runs", "run_legacy");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "run.json"),
      `${JSON.stringify({
        id: "run_legacy",
        state: "failed",
        task: "legacy fixture",
        source: root,
        workspace: root,
        branch: "agent/legacy",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        changedFiles: [],
        clean: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z"
      })}\n`
    );
    const adopted = readDurableRun({ root, runId: "run_legacy" });
    assert.equal(adopted.kind, "individual");
    assert.equal(adopted.controllerRunId, "run_legacy");
    assert.ok(existsSync(join(directory, "service.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy background and fleet records migrate once into the unified store", () => {
  const { root } = fixture();
  try {
    mkdirSync(join(root, "background"), { recursive: true });
    mkdirSync(join(root, "fleet"), { recursive: true });
    writeFileSync(
      join(root, "background", "legacy.json"),
      `${JSON.stringify({
        id: "legacy",
        prompt: "background fixture",
        workspace: root,
        exitCode: 1,
        finishedAt: "2026-01-01T00:00:00.000Z"
      })}\n`
    );
    writeFileSync(
      join(root, "fleet", "fleet_legacy.json"),
      `${JSON.stringify({
        id: "fleet_legacy",
        workspace: root,
        jobs: [{ runId: "run_a", state: "passed", exitCode: 0 }],
        finishedAt: "2026-01-01T00:00:00.000Z"
      })}\n`
    );
    const first = migrateLegacyRunState({ root });
    const background = readDurableRun({
      root,
      runId: "background_legacy"
    });
    const fleet = readDurableRun({ root, runId: "fleet_legacy" });
    const timestamps = [background.updatedAt, fleet.updatedAt];
    const second = migrateLegacyRunState({ root });
    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(background.kind, "background");
    assert.equal(background.state, "failed");
    assert.equal(fleet.state, "passed");
    assert.deepEqual(fleet.memberIds, ["run_a"]);
    assert.deepEqual(
      [
        readDurableRun({ root, runId: "background_legacy" }).updatedAt,
        readDurableRun({ root, runId: "fleet_legacy" }).updatedAt
      ],
      timestamps
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration rejects symlinked state records", () => {
  const { root } = fixture();
  try {
    const background = join(root, "background");
    mkdirSync(background, { recursive: true });
    const target = join(root, "outside.json");
    writeFileSync(target, '{"id":"outside"}\n');
    symlinkSync(target, join(background, "linked.json"));
    assert.throws(
      () => migrateLegacyRunState({ root }),
      /Unsafe legacy durable-run record/u
    );
    assert.equal(readDurableRun({ root, runId: "background_outside" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation records interrupted attempts and bounds retries", () => {
  const { root } = fixture();
  try {
    createDurableRun({
      root,
      id: "run_retry",
      kind: "background",
      state: "running",
      maxAttempts: 2
    });
    beginDurableAttempt({
      root,
      runId: "run_retry",
      leaseId: "lease-one",
      workerPid: 101,
      leaseExpiresAt: "2026-01-01T00:00:00.000Z"
    });
    let [record] = reconcileDurableRuns({
      root,
      now: new Date("2026-01-02T00:00:00.000Z").getTime(),
      isAlive: () => false
    });
    assert.equal(record.state, "queued");
    assert.equal(record.attempts[0].status, "interrupted");

    beginDurableAttempt({
      root,
      runId: "run_retry",
      leaseId: "lease-two",
      workerPid: 102,
      leaseExpiresAt: "2026-01-02T00:00:00.000Z"
    });
    [record] = reconcileDurableRuns({
      root,
      now: new Date("2026-01-03T00:00:00.000Z").getTime(),
      isAlive: () => false
    });
    assert.equal(record.state, "failed");
    assert.equal(record.attempts.length, 2);
    assert.throws(
      () =>
        beginDurableAttempt({
          root,
          runId: "run_retry",
          leaseId: "lease-three"
        }),
      /exhausted/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation also recovers stale controller-backed runs", () => {
  const { root } = fixture();
  try {
    const runId = "run_controller_stale";
    const directory = join(root, "runs", runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "run.json"),
      `${JSON.stringify({
        id: runId,
        state: "implementing",
        task: "stale controller",
        source: root,
        workspace: root,
        branch: "agent/stale",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        changedFiles: [],
        clean: true,
        maxAttempts: 2,
        worker: {
          leaseId: "stale-lease",
          pid: 404,
          status: "running",
          heartbeatAt: "2026-01-01T00:00:00.000Z",
          leaseExpiresAt: "2026-01-01T00:01:00.000Z"
        }
      })}\n`
    );
    readDurableRun({ root, runId });
    beginDurableAttempt({
      root,
      runId,
      leaseId: "stale-lease",
      workerPid: 404,
      leaseExpiresAt: "2026-01-01T00:01:00.000Z"
    });
    const reconcileOptions = {
      root,
      now: new Date("2026-01-02T00:00:00.000Z").getTime(),
      isAlive: () => false
    };
    const [record] = reconcileDurableRuns(reconcileOptions);
    assert.equal(record.state, "queued");
    assert.equal(record.attempts[0].status, "interrupted");
    const [replayed] = reconcileDurableRuns(reconcileOptions);
    assert.equal(replayed.state, "queued");
    assert.equal(replayed.attempts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation recovers a background launch that never heartbeats", () => {
  const { root } = fixture();
  try {
    createDurableRun({
      root,
      id: "run_no_heartbeat",
      kind: "background",
      state: "prepared",
      maxAttempts: 2,
      payload: {
        background: {
          pid: 505,
          launchedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    });
    const [record] = reconcileDurableRuns({
      root,
      now: new Date("2026-01-01T00:01:00.000Z").getTime(),
      isAlive: () => false
    });
    assert.equal(record.state, "queued");
    assert.equal(record.attempts[0].operation, "background-launch");
    assert.equal(record.attempts[0].status, "interrupted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external receipts are restart-idempotent and reject a changed key", () => {
  const { root } = fixture();
  try {
    createDurableRun({ root, id: "run_receipt", state: "passed" });
    recordExternalAction({
      root,
      runId: "run_receipt",
      action: "preparePr",
      key: "main:agent/run:abc",
      receipt: { url: "https://example.test/pr/1", headSha: "abc" }
    });
    const replay = recordExternalAction({
      root,
      runId: "run_receipt",
      action: "preparePr",
      key: "main:agent/run:abc",
      receipt: { url: "https://example.test/pr/2", headSha: "abc" }
    });
    assert.equal(
      replay.externalActions.preparePr.receipt.url,
      "https://example.test/pr/1"
    );
    assert.throws(
      () =>
        recordExternalAction({
          root,
          runId: "run_receipt",
          action: "preparePr",
          key: "main:agent/run:def",
          receipt: {}
        }),
      /another key/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git recovery refs preserve verified heads and cleanup refuses unpublished work", () => {
  const { root } = fixture();
  const source = join(root, "source");
  try {
    mkdirSync(source, { recursive: true });
    git(source, ["init", "-q"]);
    writeFileSync(join(source, "README.md"), "base\n");
    git(source, ["add", "README.md"]);
    git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "base"
    ]);
    const baseSha = git(source, ["rev-parse", "HEAD"]);
    writeFileSync(join(source, "README.md"), "changed\n");
    git(source, ["add", "README.md"]);
    git(source, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "change"
    ]);
    const headSha = git(source, ["rev-parse", "HEAD"]);
    const record = syncControllerRun({
      root,
      run: {
        id: "run_git",
        state: "failed",
        task: "preserve change",
        source,
        workspace: source,
        branch: "agent/change",
        baseSha,
        headSha,
        changedFiles: ["README.md"],
        clean: true,
        worker: null,
        createdAt: now(),
        updatedAt: now()
      }
    });
    assert.equal(
      git(source, ["rev-parse", "refs/opencode-lab/runs/run_git"]),
      headSha
    );
    assert.equal(hasUnpublishedChanges(record), true);
    assert.throws(() => assertDurableCleanupSafe(record), /unpublished/u);
    recordExternalAction({
      root,
      runId: "run_git",
      action: "preparePr",
      key: `main:agent/change:${headSha}`,
      receipt: { headSha, url: "https://example.test/pr/2" }
    });
    assert.equal(
      assertDurableCleanupSafe(readDurableRun({ root, runId: "run_git" })),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel and fleet parents keep durable member references", () => {
  const { root } = fixture();
  try {
    createDurableRun({
      root,
      id: "fleet_fixture",
      kind: "fleet",
      state: "queued"
    });
    const record = linkDurableMembers({
      root,
      runId: "fleet_fixture",
      memberIds: ["run_a", "run_b", "run_a"],
      payload: { concurrency: 2 }
    });
    assert.deepEqual(record.memberIds, ["run_a", "run_b"]);
    assert.equal(record.payload.concurrency, 2);
    finishDurableAttempt({
      root,
      runId: "fleet_fixture",
      leaseId: "missing",
      status: "completed"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable run ids cannot escape the state root", () => {
  const { root } = fixture();
  try {
    assert.throws(
      () => createDurableRun({ root, id: "../../escape", state: "queued" }),
      /Unsafe durable run id/u
    );
    assert.equal(existsSync(join(root, "..", "escape")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function now() {
  return new Date().toISOString();
}
