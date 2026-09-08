import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  handleQualityMcp,
  parseJsonOutput,
  resolveAllowedWorkspace,
  startParallelRuns,
  validateParallelRequest
} from "./handler.mjs";
import {
  projectIdentity,
  registerForegroundLaunch
} from "../lab/workspace-registry.mjs";
import { readDurableRun } from "../quality/run-service.mjs";

async function withAllowedGitWorkspace(run) {
  const directory = mkdtempSync(`${tmpdir()}/quality-mcp-allowed-`);
  mkdirSync(resolve(directory, ".git"));
  const previousRoots = process.env.QUALITY_WORKSPACE_ROOTS;
  const previousRegistry = process.env.OPENCODE_LAB_REGISTRY_PATH;
  const registryPath = resolve(directory, "host-registry.json");
  const registrationToken = "quality-test-registration-token-123456";
  process.env.QUALITY_WORKSPACE_ROOTS = directory;
  process.env.OPENCODE_LAB_REGISTRY_PATH = registryPath;
  registerForegroundLaunch({
    registryPath,
    identity: projectIdentity(directory),
    launchId: "launch_quality_test_123456",
    sessionId: "session_quality_test_123456",
    runId: "run_quality_test_123456",
    profile: "fast",
    pid: process.pid,
    registrationToken
  });
  try {
    return await run(directory, registrationToken);
  } finally {
    if (previousRoots === undefined) delete process.env.QUALITY_WORKSPACE_ROOTS;
    else process.env.QUALITY_WORKSPACE_ROOTS = previousRoots;
    if (previousRegistry === undefined)
      delete process.env.OPENCODE_LAB_REGISTRY_PATH;
    else process.env.OPENCODE_LAB_REGISTRY_PATH = previousRegistry;
    rmSync(directory, { recursive: true });
  }
}

test("quality service accepts an allowlisted Git workspace", async () => {
  await withAllowedGitWorkspace((directory) => {
    assert.equal(resolveAllowedWorkspace(directory), realpathSync(directory));
  });
});

test("quality service maps the TUI container workspace back to its host path", async () => {
  await withAllowedGitWorkspace((directory, registrationToken) => {
    assert.equal(
      resolveAllowedWorkspace("/workspace", { registrationToken }),
      realpathSync(directory)
    );
  });
});

test("registration scopes workspace even when shared service started for a different root", async () => {
  await withAllowedGitWorkspace((directory, registrationToken) => {
    const unrelated = resolve(directory, "unrelated-root");
    mkdirSync(unrelated);
    process.env.QUALITY_WORKSPACE_ROOTS = unrelated;
    assert.equal(
      resolveAllowedWorkspace("/workspace", { registrationToken }),
      realpathSync(directory)
    );
    assert.throws(
      () => resolveAllowedWorkspace(unrelated, { registrationToken }),
      /outside/
    );
    assert.throws(
      () =>
        resolveAllowedWorkspace(directory, {
          registrationToken: "invalid-registration"
        }),
      /invalid/
    );
  });
});

test("quality health reports the registered project and rejects an invalid MCP registration", async () => {
  await withAllowedGitWorkspace(async (directory, registrationToken) => {
    const identity = projectIdentity(directory);
    const health = await handleQualityMcp(
      new Request("http://127.0.0.1:8793/health", {
        headers: { "x-lab-registration-token": registrationToken }
      }),
      "quality-token"
    );
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "quality",
      projectId: identity.projectId,
      workspaceHash: identity.workspaceHash
    });

    const rejected = await handleQualityMcp(
      new Request("http://127.0.0.1:8793/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer quality-token",
          "content-type": "application/json",
          "x-lab-registration-token": "wrong-registration-token-1234567890"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
      }),
      "quality-token"
    );
    assert.equal(rejected.status, 401);
  });
});

test("quality service rejects workspaces outside its allowlist", () => {
  const directory = mkdtempSync(`${tmpdir()}/quality-mcp-`);
  try {
    assert.throws(
      () => resolveAllowedWorkspace(directory),
      /outside the quality-service allowlist/u
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("controller output parser accepts object and list responses", () => {
  assert.deepEqual(parseJsonOutput('diagnostic\n{"ok":true}\n'), {
    ok: true
  });
  assert.deepEqual(parseJsonOutput('[\n  {"id":"run-1"}\n]\n'), [
    { id: "run-1" }
  ]);
});

test("parallel requests require 2-4 concrete supported runs", () => {
  assert.throws(
    () =>
      validateParallelRequest({
        workspace: "/workspace",
        runs: [{ kind: "research", task: "Research the buyer problem" }]
      }),
    /between 2 and 4/u
  );
  assert.throws(
    () =>
      validateParallelRequest({
        workspace: "/workspace",
        runs: [
          { kind: "research", task: "Research the buyer problem" },
          { kind: "unknown", task: "Do something" }
        ]
      }),
    /unsupported kind/u
  );
});

test("parallel launcher starts isolated definitions and suppresses immediate duplicates", () => {
  const root = mkdtempSync(`${tmpdir()}/parallel-state-a-`);
  const calls = [];
  const input = {
    workspace: "/tmp/parallel-batch-test-a",
    runs: [
      { kind: "research", task: "Validate the buyer problem" },
      { kind: "ship", task: "Build the bounded implementation" },
      { kind: "research", task: "Challenge the implementation assumptions" }
    ]
  };
  const starter = (run) => {
    calls.push(run);
    return {
      id: `run-${calls.length}`,
      kind: run.kind,
      worktree: `/tmp/worktree-${calls.length}`,
      statusCommand: `status-${calls.length}`
    };
  };
  try {
    const first = startParallelRuns(input, {
      starter,
      now: () => 1000,
      root
    });
    const replay = startParallelRuns(input, {
      starter,
      now: () => 2000,
      root
    });
    assert.equal(first.state, "started");
    assert.equal(first.runs.length, 3);
    assert.equal(
      readDurableRun({ root, runId: first.batchId }).state,
      "running"
    );
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((run) => run.idempotency_key)).size, 3);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel launcher reports a partial failure without hiding started runs", () => {
  const root = mkdtempSync(`${tmpdir()}/parallel-state-b-`);
  let calls = 0;
  try {
    const result = startParallelRuns(
      {
        workspace: "/tmp/parallel-batch-test-b",
        runs: [
          { kind: "ship", task: "Implement the bounded change" },
          { kind: "research", task: "Review the external evidence" }
        ]
      },
      {
        now: () => 500_000,
        root,
        starter(run) {
          calls += 1;
          if (run.kind === "research") throw new Error("prepare failed");
          return { id: "run-ok", statusCommand: "status-ok" };
        }
      }
    );
    assert.equal(calls, 2);
    assert.equal(result.state, "partially-started");
    assert.equal(result.runs.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /prepare failed/u);
    assert.equal(
      readDurableRun({ root, runId: result.batchId }).state,
      "failed"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
