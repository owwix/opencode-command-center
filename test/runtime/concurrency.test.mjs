import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseFinalAssistantResult } from "../../scripts/quality/run-control.mjs";
import { createLaunchSpec } from "../../scripts/lab/launcher/launch-spec.mjs";

const enabled = process.env.LAB_RUNTIME_TESTS === "1";
const image = process.env.LAB_RUNTIME_IMAGE ?? "opencode-lab-opencode:local";
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

test(
  "interactive TUI survives managed-run cancellation and fixture-provider crash",
  { skip: !enabled, timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "lab-concurrent-runtime-"));
    const id = randomUUID().replaceAll("-", "");
    const network = `lab-concurrent-${id}`;
    const provider = `lab-provider-${id}`;
    const foreground = `lab-tui-${id}`;
    const first = createLaunchSpec(["run"], {});
    const second = createLaunchSpec(["run"], {});
    const names = [
      provider,
      foreground,
      first.composeProject,
      second.composeProject
    ];
    t.after(() => {
      for (const name of names) {
        try {
          docker(["rm", "-f", name]);
        } catch {}
      }
      try {
        docker(["network", "rm", network]);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    });
    docker(["network", "create", "--internal", network]);
    docker([
      "run",
      "-d",
      "--name",
      provider,
      "--network",
      network,
      "--network-alias",
      "fixture",
      "--mount",
      `type=bind,src=${resolve("test/runtime/model-server.mjs")},dst=/fixture.mjs,readonly`,
      "--entrypoint",
      "node",
      image,
      "/fixture.mjs"
    ]);
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        model: "fixture/test",
        small_model: "fixture/test",
        permission: "allow",
        plugin: [],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "http://fixture:8799/v1",
              apiKey: "fixture-only"
            },
            models: {
              test: { name: "Fixture", limit: { context: 32768, output: 4096 } }
            }
          }
        }
      })
    );
    const shared = [
      "--network",
      network,
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--read-only",
      "--user",
      "0:0",
      "--tmpfs",
      "/tmp:exec",
      "--tmpfs",
      "/home/opencode",
      "--mount",
      `type=bind,src=${config},dst=/config.json,readonly`,
      "-e",
      "OPENCODE_CONFIG=/config.json",
      "-e",
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      "-e",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
      "--entrypoint",
      "opencode"
    ];
    docker(["run", "-dit", "--name", foreground, ...shared, image]);
    const launch = (spec, prompt) => {
      const workspace = join(root, spec.attemptId);
      mkdirSync(workspace);
      const child = spawn("docker", [
        "run",
        "--name",
        spec.composeProject,
        ...shared,
        "-w",
        "/workspace",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        image,
        "run",
        "--format",
        "json",
        "--model",
        "fixture/test",
        prompt
      ]);
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      const done = new Promise((done) => {
        child.once("error", (error) =>
          done({ code: -1, output: String(error) })
        );
        child.once("exit", (code) => done({ code, output }));
      });
      return { done, workspace };
    };
    const cancelled = launch(first, "SLOW_FIXTURE implement result.txt");
    const survivor = launch(second, "IMPLEMENT_FIXTURE implement result.txt");
    for (let tries = 0; tries < 100; tries++) {
      try {
        if (
          docker([
            "inspect",
            "--format",
            "{{.State.Running}}",
            first.composeProject
          ]) === "true"
        )
          break;
      } catch {}
      await delay(100);
    }
    docker(["stop", "--time", "1", first.composeProject]);
    assert.notEqual((await cancelled.done).code, 0);
    const completed = await survivor.done;
    assert.equal(completed.code, 0, completed.output);
    assert.equal(
      parseFinalAssistantResult(completed.output, "implementation").status,
      "complete"
    );
    assert.equal(
      readFileSync(join(survivor.workspace, "result.txt"), "utf8"),
      "verified fixture output\n"
    );
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", foreground]),
      "true"
    );
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", provider]),
      "true"
    );
    // A hard crash of an unrelated test-owned process must not take down the TUI.
    docker(["kill", provider]);
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", foreground]),
      "true"
    );
  }
);
