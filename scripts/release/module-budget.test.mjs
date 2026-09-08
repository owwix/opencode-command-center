import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countPhysicalLines, evaluateModuleBudget } from "./module-budget.mjs";

const policy = {
  maxLines: 3,
  roots: ["scripts"],
  extensions: [".mjs"],
  excludedSuffixes: [".test.mjs"],
  excludedDirectories: ["vendor"]
};

test("physical line counting handles final newlines", () => {
  assert.equal(countPhysicalLines("one\ntwo\n"), 2);
  assert.equal(countPhysicalLines("one\ntwo"), 2);
  assert.equal(countPhysicalLines(""), 0);
});

test("module budget reports production violations and excludes tests", () => {
  const root = mkdtempSync(join(tmpdir(), "module-budget-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "small.mjs"), "1\n2\n3\n");
    writeFileSync(join(root, "scripts", "large.mjs"), "1\n2\n3\n4\n");
    writeFileSync(join(root, "scripts", "large.test.mjs"), "1\n2\n3\n4\n5\n");
    const result = evaluateModuleBudget({ root, policy });
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations, [
      { path: "scripts/large.mjs", lines: 4 }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
