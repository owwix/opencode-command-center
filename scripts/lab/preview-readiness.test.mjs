import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectNextDevPreviewOrigins,
  isNextJsProject,
  nextDevPreviewHint
} from "./preview-readiness.mjs";

test("isNextJsProject detects next dependency", () => {
  const workspace = mkdtempSync(join(tmpdir(), "lab-next-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } })
  );
  assert.equal(isNextJsProject(workspace), true);
});

test("inspectNextDevPreviewOrigins passes when Lab origin is allowed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "lab-next-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } })
  );
  writeFileSync(
    join(workspace, "next.config.ts"),
    `export default { allowedDevOrigins: ["127.0.0.1:3100", "127.0.0.1"] };`
  );
  const report = inspectNextDevPreviewOrigins(workspace);
  assert.equal(report.ok, true);
  assert.equal(nextDevPreviewHint(workspace), null);
});

test("inspectNextDevPreviewOrigins warns when allowedDevOrigins is missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "lab-next-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } })
  );
  writeFileSync(join(workspace, "next.config.ts"), "export default {};");
  const report = inspectNextDevPreviewOrigins(workspace);
  assert.equal(report.ok, false);
  assert.match(report.detail, /allowedDevOrigins/u);
  assert.match(nextDevPreviewHint(workspace), /allowedDevOrigins/u);
});
