import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createCapabilityLease } from "../../docker/agent-gateway/capability-lease.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8"
  }).trim();
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("relay did not become healthy");
}

test("publish relay enforces authentication and protected branches", async () => {
  const root = mkdtempSync(join(tmpdir(), "github-relay-"));
  const port = 18900 + (process.pid % 500);
  const token = "t".repeat(64);
  const signingKey = "test-capability-signing-key-at-least-32-bytes"; // gitleaks:allow
  const capabilityContext = {
    workspaceHash: "workspace_hash_1234567890",
    projectId: "project_1234567890",
    sessionId: "session_1234567890",
    runId: "run_1234567890"
  };
  const capabilityLease = createCapabilityLease({
    key: signingKey,
    ...capabilityContext,
    routes: ["github-publish"],
    actions: [
      "github-publish:push",
      "github-publish:status",
      "github-publish:issues"
    ]
  });
  const url = `http://127.0.0.1:${port}`;
  const relay = spawn(
    process.execPath,
    [resolve("scripts/github/publish-relay.mjs")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_PUBLISH_RELAY_PORT: String(port),
        GITHUB_PUBLISH_RELAY_TOKEN: token,
        GITHUB_PUBLISH_WORKSPACE: root,
        AGENT_GATEWAY_SIGNING_KEY: signingKey,
        OPENCODE_WORKSPACE_HASH: capabilityContext.workspaceHash,
        OPENCODE_PROJECT_ID: capabilityContext.projectId,
        OPENCODE_LAUNCH_SESSION_ID: capabilityContext.sessionId,
        OPENCODE_RUN_ID: capabilityContext.runId
      },
      stdio: "ignore"
    }
  );
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    writeFileSync(join(root, "README.md"), "test\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "test: seed");
    git(
      root,
      "remote",
      "add",
      "origin",
      "https://example.com/not-github/repo.git"
    );
    assert.equal(git(root, "branch", "--show-current"), "main");
    await waitForHealth(url);

    const unauthorized = await fetch(`${url}/v1/status`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    git(
      root,
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://github.com/owwix/demo.git"
    );
    const statusResponse = await fetch(`${url}/v1/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-opencode-capability-lease": capabilityLease,
        "content-type": "application/json"
      },
      body: "{}"
    });
    assert.equal(statusResponse.status, 200);
    assert.deepEqual((await statusResponse.json()).branch, "main");

    const deniedIssueResponse = await fetch(`${url}/v1/issue`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-opencode-capability-lease": capabilityLease,
        "content-type": "application/json"
      },
      body: JSON.stringify({ number: 1 })
    });
    assert.equal(deniedIssueResponse.status, 403);
    assert.match((await deniedIssueResponse.json()).error, /capability lease/i);

    const pushResponse = await fetch(`${url}/v1/push`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-opencode-capability-lease": capabilityLease,
        "content-type": "application/json"
      },
      body: "{}"
    });
    assert.equal(pushResponse.status, 400);
    assert.match((await pushResponse.json()).error, /protected branch/i);
  } finally {
    relay.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
