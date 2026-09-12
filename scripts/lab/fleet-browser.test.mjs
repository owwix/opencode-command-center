import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  handleAction,
  startBrowserSessionRelay
} from "./browser-session-relay.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("browser session denies non-loopback navigate", async () => {
  await assert.rejects(
    () => handleAction({ action: "navigate", url: "https://example.com/" }),
    /localhost|127\.0\.0\.1/u
  );
});

test("browser session health endpoint", async () => {
  const server = startBrowserSessionRelay({
    host: "127.0.0.1",
    port: 0,
    token: "session-relay-token",
    projectId: "project_session_test",
    workspaceHash: "workspace_session_test"
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "lab-browser-session",
      connectedChrome: 1,
      projectId: "project_session_test",
      workspaceHash: "workspace_session_test",
      sessions: 0
    });
    const unauthorized = await fetch(`http://127.0.0.1:${port}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "snapshot" })
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("tool-lifecycle plugin blocks credential path reads", async () => {
  const pluginPath = join(here, "../../.opencode/plugins/tool-lifecycle.mjs");
  const { LabToolLifecycle } = await import(pluginPath);
  const hooks = await LabToolLifecycle();
  await assert.rejects(
    () =>
      hooks["tool.execute.before"](
        { tool: "read", sessionID: "s", callID: "c" },
        { args: { filePath: ".env.local" } }
      ),
    /credential path/iu
  );
});

test("fleet status works with empty fleet dir", () => {
  const fleet = fileURLToPath(new URL("./fleet.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [fleet, "status"], {
    encoding: "utf8",
    cwd: join(here, "../.."),
    env: {
      ...process.env,
      QUALITY_STATE_ROOT: mkdtempSync(join(tmpdir(), "lab-fleet-status-"))
    }
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.fleets));
});

test("seatbelt profile file exists", () => {
  const profile = readFileSync(join(here, "seatbelt-lab.sb"), "utf8");
  assert.match(profile, /deny default/u);
  assert.match(profile, /param "WORKSPACE"/u);
  assert.doesNotMatch(profile, /^#/mu, "Seatbelt comments must use semicolons");
  assert.doesNotMatch(
    profile,
    /remote ip "127\.0\.0\.1:/u,
    "Seatbelt accepts localhost, not a numeric host, in remote IP rules"
  );
});
