import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileManagedContainers } from "./managed-resource-recovery.mjs";

test("orphan recovery validates ownership and never deletes persistent data", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-orphan-test-"));
  const registryPath = join(root, "registry.json");
  const name = `opencode-lab-run-${"a".repeat(24)}`;
  const calls = [];
  const session = {
    background: true,
    pid: 2147483647,
    launchId: "dead-launch",
    resources: { composeProject: name }
  };
  const seed = () =>
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        foreground: null,
        projects: { fixture: { sessions: { dead: session } } }
      })
    );
  try {
    seed();
    assert.deepEqual(
      reconcileManagedContainers({
        registryPath,
        alive: () => true,
        run: () => {
          throw new Error("live owner must not be touched");
        }
      }),
      []
    );
    assert.throws(
      () =>
        reconcileManagedContainers({
          registryPath,
          alive: () => false,
          run: (args) =>
            args[0] === "ps" ? "abcdef123456" : "unrelated-project"
        }),
      /ownership changed/
    );
    const result = reconcileManagedContainers({
      registryPath,
      alive: () => false,
      run: (args) => {
        calls.push(args);
        return args[0] === "ps"
          ? "abcdef123456"
          : args[0] === "inspect"
            ? name
            : "";
      }
    });
    assert.equal(result.length, 1);
    assert.deepEqual(calls.at(-1), ["rm", "-f", "abcdef123456"]);
    assert.ok(
      calls.every((args) => !args.includes("volume") && !args.includes("prune"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
