import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dependencyFingerprint,
  dependencyMountArgs,
  prepareNodeDependencies
} from "./node-dependencies.mjs";
import { projectIdentity } from "./workspace-registry.mjs";

test("dependency mounts are scoped, read-only and reject changed locks", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-deps-test-"));
  const previous = process.env.OPENCODE_LAB_STATE_ROOT;
  process.env.OPENCODE_LAB_STATE_ROOT = join(root, "state");
  try {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "package-lock.json"), "{}");
    const identity = projectIdentity(root);
    const directory = join(root, "state", "projects", identity.projectId);
    mkdirSync(directory, { recursive: true });
    const record = {
      workspace: root,
      fingerprint: dependencyFingerprint(root),
      volume: `opencode-lab-deps-${"a".repeat(32)}`
    };
    writeFileSync(
      join(directory, "node-dependencies.json"),
      JSON.stringify(record)
    );
    assert.deepEqual(
      dependencyMountArgs(identity.projectId, identity.workspaceHash),
      ["--volume", `${record.volume}:/workspace/node_modules:ro`]
    );
    assert.throws(
      () => dependencyMountArgs(identity.projectId, "wrong-workspace"),
      /identity mismatch/
    );
    writeFileSync(join(root, "package-lock.json"), '{"changed":true}');
    assert.throws(
      () => dependencyMountArgs(identity.projectId, identity.workspaceHash),
      /lock changed/
    );
    assert.deepEqual(dependencyMountArgs("../escape", "wrong"), []);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_LAB_STATE_ROOT;
    else process.env.OPENCODE_LAB_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer rejects private, unpinned and linked dependencies before Docker", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-deps-policy-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    for (const pkg of [
      { resolved: "http://registry.npmjs.org/pkg", integrity: "sha512-test" },
      { resolved: "https://127.0.0.1/pkg", integrity: "sha512-test" },
      { resolved: "https://registry.npmjs.org/pkg" },
      { link: true }
    ]) {
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify({ packages: { "node_modules/pkg": pkg } })
      );
      assert.throws(
        () => prepareNodeDependencies(root),
        /registry|integrity-pinned/
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
