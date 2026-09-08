import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createLaunchSpec } from "./launcher/launch-spec.mjs";
import { createDockerRuntime } from "./launcher/docker-runtime.mjs";

test("interactive and concurrent controller attempts have disjoint resources", () => {
  const interactive = createLaunchSpec([], {});
  const environment = {
    LAB_RUN_ID: "run_controller123",
    OPENCODE_NON_INTERACTIVE: "1"
  };
  const implementation = createLaunchSpec(
    ["run", "--agent", "lab"],
    environment
  );
  const review = createLaunchSpec(["run", "--agent", "reviewer"], {
    ...environment,
    LAB_PHASE: "review:1"
  });
  assert.equal(interactive.foreground, true);
  assert.equal(implementation.foreground, false);
  assert.equal(review.kind, "managed-review");
  assert.equal(implementation.runId, environment.LAB_RUN_ID);
  assert.equal(review.runId, implementation.runId);
  assert.notEqual(review.attemptId, implementation.attemptId);
  assert.equal(
    new Set(
      [interactive, implementation, review].map((spec) => spec.composeProject)
    ).size,
    3
  );
  assert.notEqual(implementation.stateNamespace, review.stateNamespace);
  const runtime = createDockerRuntime({
    launchSpec: implementation,
    envFile: "ignored.env"
  });
  assert.deepEqual(runtime.dockerComposeArguments(["ps"]).slice(0, 3), [
    "compose",
    "-p",
    implementation.composeProject
  ]);
});

test("task remains managed and maintenance never claims foreground", () => {
  assert.equal(createLaunchSpec(["task"], {}).managed, true);
  assert.equal(createLaunchSpec(["mcp", "auth"], {}).kind, "maintenance");
  assert.equal(createLaunchSpec(["notion:start"], {}).foreground, false);
});

test("ambiguous headless and malformed run identity fail closed", () => {
  assert.throws(
    () => createLaunchSpec([], { OPENCODE_NON_INTERACTIVE: "1" }),
    /explicit run/
  );
  assert.throws(
    () => createLaunchSpec(["run"], { LAB_RUN_ID: "../../bad" }),
    /identity/
  );
});

test("cleanup targets only the exact managed attempt and keeps its volumes", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const foreground = createLaunchSpec([], {});
  const managed = createLaunchSpec(["run"], {});
  for (const launchSpec of [foreground, managed]) {
    await createDockerRuntime(
      { launchSpec, envFile: "ignored.env" },
      { spawnProcess }
    ).stopManagedServices({});
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), [
    "compose",
    "-p",
    managed.composeProject
  ]);
  assert.deepEqual(calls[0].args.slice(-3), ["down", "--timeout", "5"]);
  assert.ok(!calls[0].args.includes("--volumes"));
  await assert.rejects(
    createDockerRuntime(
      { launchSpec: { managed: true, composeProject: "opencode-lab" } },
      { spawnProcess }
    ).stopManagedServices({}),
    /exact attempt-owned/
  );
  assert.equal(calls.length, 1);
});
