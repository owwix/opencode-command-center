import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withMaintenance } from "./maintenance.mjs";
import { assertNoMaintenance } from "./state-volumes.mjs";

test("maintenance excludes live sessions, blocks launches and releases on failure", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "lab-maintenance-test-"));
  const updatesRoot = join(stateRoot, "updates");
  const paths = { stateRoot, updatesRoot };
  try {
    writeFileSync(
      join(stateRoot, "host-registry.json"),
      JSON.stringify({ foreground: { pid: process.pid } })
    );
    assert.throws(
      () => withMaintenance(paths, () => assert.fail("active session")),
      /Stop the active/
    );
    assert.equal(existsSync(join(updatesRoot, "maintenance.lock")), false);
    writeFileSync(join(stateRoot, "host-registry.json"), "{}");
    assert.throws(
      () =>
        withMaintenance(paths, () => {
          assert.throws(
            () => assertNoMaintenance(updatesRoot),
            /maintenance|update|rollback/i
          );
          throw new Error("probe failed");
        }),
      /probe failed/
    );
    assertNoMaintenance(updatesRoot);
    mkdirSync(updatesRoot, { recursive: true });
    writeFileSync(join(updatesRoot, "maintenance.lock"), "2147483647");
    assert.equal(
      withMaintenance(paths, () => "recovered"),
      "recovered"
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
