import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLeaseSession } from "./launcher/lease-session.mjs";
import { verifyCapabilityLease } from "../../docker/agent-gateway/capability-lease.mjs";

test("eight hours of accelerated renewals preserve authority and recover after sleep", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lab-renewal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const key = "test-only-renewal-key-not-a-secret-12345";
  const claims = {
    workspaceHash: "workspace123",
    projectId: "project123",
    sessionId: "session123",
    runId: "run_test123",
    routes: ["chat"],
    actions: ["chat:invoke"]
  };
  const session = createLeaseSession({
    root,
    claims,
    key,
    now: () => now,
    automatic: false
  });
  const read = () =>
    JSON.parse(readFileSync(join(session.directory, "lease.json"), "utf8"))
      .lease;
  const original = read();
  claims.routes.push("github-publish");
  for (let minute = 0; minute < 480; minute++) {
    now += 60000;
    session.tick();
    const verified = verifyCapabilityLease(read(), { key, ...claims, now });
    assert.deepEqual(verified.routes, ["chat"]);
    assert.equal(verified.exp - verified.iat, 1800);
    assert.equal(verified.runId, claims.runId);
  }
  assert.notEqual(read(), original);
  assert.throws(
    () => verifyCapabilityLease(original, { key, ...claims, now }),
    /expired/i
  );
  assert.throws(
    () =>
      verifyCapabilityLease(read(), {
        key,
        ...claims,
        projectId: "another-project",
        now
      }),
    /project/i
  );
  now += 3600000;
  assert.throws(
    () => verifyCapabilityLease(read(), { key, ...claims, now }),
    /expired/i
  );
  session.tick();
  verifyCapabilityLease(read(), { key, ...claims, now });
  session.stop();
  now += 1800000;
  assert.equal(session.tick(), false);
});
