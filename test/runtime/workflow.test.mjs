import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseFinalAssistantResult } from "../../scripts/quality/run-control.mjs";
import { createControllerRuntime } from "../../scripts/quality/controller-runtime.mjs";
import { createPreparationOperations } from "../../scripts/quality/controller-prepare.mjs";
import { createImplementationOperations } from "../../scripts/quality/controller-implementation.mjs";
import { createLifecycleOperations } from "../../scripts/quality/controller-lifecycle.mjs";
import { createArtifactOperations } from "../../scripts/quality/controller-artifacts.mjs";
import { controllerPorts } from "../../scripts/quality/controller-ports.mjs";
import { preparePullRequest } from "../../scripts/github/publish-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const enabled = process.env.LAB_RUNTIME_TESTS === "1";
const image = process.env.LAB_RUNTIME_IMAGE ?? "opencode-lab-opencode:local";
function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 120000
  }).trim();
}
function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (error += data));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`OpenCode fixture timeout: ${error}\n${output}`));
    }, 90000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveRun(output)
        : reject(new Error(`OpenCode exited ${code}: ${error}\n${output}`));
    });
  });
}

for (const adapter of ["node", "python", "monorepo"]) {
  test(
    `real pinned OpenCode ${adapter} implementation, verification, review and PR`,
    { skip: !enabled, timeout: 240000 },
    async (t) => {
      const startedAt = Date.now();
      const temporary = mkdtempSync(join(tmpdir(), "lab-real-workflow-"));
      const id = randomUUID().replaceAll("-", "");
      const network = `lab-fixture-${id}`;
      const provider = `lab-model-${id}`;
      const containers = [];
      t.after(() => {
        for (const name of [...containers, provider]) {
          try {
            docker(["rm", "-f", name]);
          } catch {}
        }
        try {
          docker(["network", "rm", network]);
        } catch {}
        rmSync(temporary, { recursive: true, force: true });
      });
      assert.equal(
        docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "opencode",
          image,
          "--version"
        ]),
        JSON.parse(readFileSync(join(root, "versions.lock"))).components
          .opencode.version
      );
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
        "--memory",
        "128m",
        "--read-only",
        "--mount",
        `type=bind,src=${join(root, "test/runtime/model-server.mjs")},dst=/fixture.mjs,readonly`,
        "--entrypoint",
        "node",
        image,
        "/fixture.mjs"
      ]);
      let workspace = join(temporary, "workspace");
      mkdirSync(workspace);
      const source = workspace;
      const git = (...args) =>
        execFileSync("git", ["-C", workspace, ...args], {
          encoding: "utf8"
        }).trim();
      git("init", "-q");
      git("config", "user.name", "Runtime fixture");
      git("config", "user.email", "fixture@example.test");
      writeFileSync(
        join(workspace, "verify.mjs"),
        'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; assert.equal(readFileSync("result.txt", "utf8"), "verified fixture output\\n");\n'
      );
      if (adapter === "python")
        writeFileSync(
          join(workspace, "verify.py"),
          'from pathlib import Path\nassert Path("result.txt").read_text() == "verified fixture output\\n"\n'
        );
      if (adapter === "monorepo") {
        mkdirSync(join(workspace, "packages/app"), { recursive: true });
        writeFileSync(
          join(workspace, "packages/app/verify.mjs"),
          readFileSync(join(workspace, "verify.mjs"))
        );
      }
      const verifyArgs =
        adapter === "python"
          ? ["python3", "verify.py"]
          : [
              process.execPath,
              adapter === "monorepo" ? "packages/app/verify.mjs" : "verify.mjs"
            ];
      git("add", ".");
      git("commit", "-qm", "Initial fixture");
      git("remote", "add", "origin", "https://github.com/fixture/offline.git");
      const configPath = join(temporary, "opencode.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          model: "fixture/test",
          small_model: "fixture/test",
          permission: "allow",
          plugin: [],
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Unpaid deterministic fixture",
              options: {
                baseURL: "http://fixture:8799/v1",
                apiKey: "fixture-not-a-secret"
              },
              models: {
                test: {
                  name: "Fixture",
                  limit: { context: 32768, output: 4096 }
                }
              }
            }
          }
        })
      );
      const invoke = async (review) => {
        const name = `lab-agent-${id}-${review ? "review" : "implementation"}`;
        containers.push(name);
        return run([
          "run",
          "--rm",
          "--name",
          name,
          "--network",
          network,
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--user",
          "0:0",
          "--read-only",
          "--tmpfs",
          "/tmp:exec",
          "--tmpfs",
          "/home/opencode",
          "--mount",
          `type=bind,src=${workspace},dst=/workspace${review ? ",readonly" : ""}`,
          "--mount",
          `type=bind,src=${configPath},dst=/config.json,readonly`,
          "-w",
          "/workspace",
          "-e",
          "OPENCODE_CONFIG=/config.json",
          "-e",
          "OPENCODE_DISABLE_AUTOUPDATE=1",
          "-e",
          "OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
          "--entrypoint",
          "opencode",
          image,
          "run",
          "--format",
          "json",
          "--model",
          "fixture/test",
          review
            ? "REVIEW_FIXTURE read result.txt then return the review JSON."
            : "IMPLEMENT_FIXTURE write result.txt then return the result JSON."
        ]);
      };
      const priorState = process.env.QUALITY_STATE_ROOT;
      process.env.QUALITY_STATE_ROOT = join(temporary, "state");
      const runtime = createControllerRuntime();
      if (priorState === undefined) delete process.env.QUALITY_STATE_ROOT;
      else process.env.QUALITY_STATE_ROOT = priorState;
      const { prepare } = createPreparationOperations(
        controllerPorts("prepare", runtime)
      );
      const implementation = createImplementationOperations(
        controllerPorts("implementation", runtime)
      );
      implementation.runOpenCode = async (
        record,
        { reviewer = false } = {}
      ) => {
        workspace = record.workspace;
        const output = await invoke(reviewer);
        return {
          passed: true,
          structured: parseFinalAssistantResult(
            output,
            reviewer ? "review" : "implementation"
          ),
          telemetry: {},
          output,
          exitStatus: 0
        };
      };
      implementation.runDagger = async (record) => {
        execFileSync(verifyArgs[0], verifyArgs.slice(1), {
          cwd: record.workspace
        });
        return {
          passed: true,
          commands: [verifyArgs.join(" ")],
          exitCode: 0,
          adapter: `local-${adapter}-fixture`
        };
      };
      let receipt = null;
      let creates = 0;
      const publisher = (request) =>
        preparePullRequest({
          ...request,
          runner: (command, args, options) => {
            if (command === "git" && args[0] === "push")
              return "fixture push accepted";
            if (command === "gh" && args[1] === "list")
              return JSON.stringify(receipt ? [receipt] : []);
            if (command === "gh" && args[1] === "create") {
              creates++;
              receipt = {
                url: "https://github.com/fixture/offline/pull/1",
                headRefName: request.expectedBranch,
                baseRefName: "main",
                headRefOid: request.expectedHeadSha
              };
              return receipt.url;
            }
            return execFileSync(command, args, {
              cwd: options.cwd,
              encoding: "utf8"
            }).trim();
          }
        });
      const artifacts = createArtifactOperations(
        controllerPorts("artifacts", runtime, implementation),
        { publish: publisher }
      );
      const lifecycle = createLifecycleOperations(
        controllerPorts("lifecycle", runtime, implementation, artifacts, {
          prepare
        })
      );
      const completed = await lifecycle.execute({
        workspace: source,
        worktree_root: join(temporary, "worktrees"),
        task: "Write a result text file",
        agent: "lab",
        model: "cloudflare-ai/@cf/openai/gpt-oss-120b",
        verify: ["node verify.mjs"],
        artifact: []
      });
      assert.equal(
        completed.state,
        "passed",
        JSON.stringify(completed.review ?? completed.implementationResult)
      );
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(completed.verification.sha, completed.review.sha);
      artifacts.preparePr({ run: completed.id, base: "main" });
      const restartedArtifacts = createArtifactOperations(
        controllerPorts("artifacts", runtime, implementation),
        { publish: publisher }
      );
      restartedArtifacts.preparePr({ run: completed.id, base: "main" });
      assert.equal(creates, 1);
      assert.equal(receipt.headRefOid, completed.verification.sha);
      assert.equal(
        git("show", `${receipt.headRefOid}:result.txt`),
        "verified fixture output"
      );
      t.diagnostic(
        JSON.stringify({
          scope: "deterministic-runtime-workflow",
          adapter,
          elapsedMs: Date.now() - startedAt,
          completed: true,
          prCreates: creates,
          restartDuplicates: 0,
          imageId: docker(["image", "inspect", "--format", "{{.Id}}", image]),
          providerCost: "not applicable: local fixture",
          memoryLimitMiB: 512
        })
      );
    }
  );
}
