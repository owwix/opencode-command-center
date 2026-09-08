import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withHelperStartLock } from "./launcher/helper-start-lock.mjs";

test("concurrent helper launches serialize and release after failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lab-helper-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "start.lock");
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withHelperStartLock(path, async () => {
        peak = Math.max(peak, ++active);
        await delay(10);
        active--;
      })
    )
  );
  assert.equal(peak, 1);
  await assert.rejects(
    withHelperStartLock(path, async () => {
      throw new Error("fixture failure");
    }),
    /fixture/
  );
  await assert.rejects(access(path), { code: "ENOENT" });
  await writeFile(path, `${process.pid}:live-owner`);
  await assert.rejects(
    withHelperStartLock(path, () => {}, 1),
    /locked/
  );
});
