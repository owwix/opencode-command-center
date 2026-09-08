#!/usr/bin/env node

/**
 * Public `occtl` lifecycle entrypoint.
 *
 * This host-owned command selects lifecycle, update, and strict operations,
 * bootstraps the pinned Node runtime independently of the ambient shell, and
 * delegates normal launches to opencode.mjs. It strictly parses lifecycle
 * arguments and requires explicit approval for project-contract writes; it
 * does not forward lifecycle-only flags into OpenCode. Reference:
 * docs/cli-reference.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  loadProjectContract,
  writeProjectContract
} from "./lab/project-contract.mjs";
import { configuredPackRoots, loadPackSet } from "./lab/pack-loader.mjs";
import {
  formatLifecycleStatus,
  formatRecentProjects,
  lifecycleSnapshot,
  prepareNewWorkspace,
  resolveRecentProject,
  stopForegroundWorkspace
} from "./lab/project-lifecycle.mjs";
import { adoptLegacyHostFile, labHostPaths } from "./lab/host-state.mjs";
import {
  dispatchActiveRelease,
  performUpdate,
  rollbackRelease,
  versionInfo
} from "./lab/update-manager.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = resolve(packageRoot, "scripts/opencode.mjs");
const setup = resolve(packageRoot, "scripts/opencode-setup.mjs");
const prune = resolve(packageRoot, "scripts/lab/prune.mjs");
const doctor = resolve(packageRoot, "scripts/agent-doctor.mjs");
const verify = resolve(packageRoot, "scripts/lab/verify.mjs");
const strictDoctor = resolve(packageRoot, "scripts/lab/strict-doctor.mjs");
const strictRun = resolve(packageRoot, "scripts/lab/strict-run.mjs");
const strictExport = resolve(packageRoot, "scripts/lab/strict-export.mjs");
const hostPaths = labHostPaths();
const registryPath = hostPaths.registryPath;
adoptLegacyHostFile(
  resolve(packageRoot, ".quality/host-registry.json"),
  registryPath
);
const envFile = resolve(packageRoot, "opencode.env");
const args = process.argv.slice(2);
const dispatchedStatus = dispatchActiveRelease({
  packageRoot,
  args,
  paths: hostPaths
});
if (dispatchedStatus !== null) process.exit(dispatchedStatus);

const requiredNodeVersion = readFileSync(resolve(packageRoot, ".nvmrc"), "utf8")
  .trim()
  .replace(/^v/u, "");
if (process.versions.node !== requiredNodeVersion) {
  const pinnedNode = resolve(
    homedir(),
    ".nvm",
    "versions",
    "node",
    `v${requiredNodeVersion}`,
    "bin",
    "node"
  );
  if (!existsSync(pinnedNode)) {
    console.error(
      `OpenCode Command Center requires Node ${requiredNodeVersion}. Install it with nvm before launching.`
    );
    process.exit(1);
  }
  const result = spawnSync(pinnedNode, [process.argv[1], ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });
  process.exit(result.status ?? 1);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`OpenCode Command Center launcher

Usage:
  occtl open [path]                           Choose or open a workspace
  occtl new [path]                            Create an empty workspace, then open it
  occtl recent                                List known projects by last-opened time
  occtl status                                Show foreground and background activity
  occtl stop                                  Stop the verified foreground launcher
  occtl resume [project]                      Reopen a recent project by index/name/path
  occtl init [path] [--pack id] [--yes]       Preview, approve, and write project.json
  occtl doctor [path]                         Diagnose Command Center and project preflight
  occtl verify [path]                         Run the project adapter verification plan
  occtl prune [--apply]                       Report legacy volumes; delete with --apply
  occtl version                               Show source, compatibility, and active release
  occtl update [--ref REF]                    Stage, verify, back up, and activate an update
  occtl rollback                              Return to the previous staged release
  occtl strict doctor [--json]                Check strict microVM prerequisites
  occtl strict run [path]                     Start a clone-isolated strict session
  occtl strict export <run>                   Export a signed strict result bundle
  occtl strict adopt <run> --approve          Explicitly adopt a verified strict patch
  occtl open [path] --strict                  Alias for strict clone execution

Canonical package alias:
  opencode-command-center                   Alias for \`occtl open\`

Compatibility aliases:
  lab                                       Alias for \`occtl open\`
  opencode-lab                              Alias for \`occtl open\`
  opencode-lab --workspace <folder>         Alias for \`occtl open <folder>\`
  opencode-lab task <type> <request>        Run a managed task
  opencode-lab --setup                      Check or create local configuration

Tool profiles (launcher-only; never passed to OpenCode):
  --with-research  Start Hound (auto for managed runs that request research)
  --with-design    Start OpenDesign (auto for managed runs that request design)
  --full-tools     Start both optional tool stacks
  --rebuild        Rebuild images for the selected profile before launch

Approval modes (host-owned; project code cannot modify them):
  --approval-mode ask        Ask for every non-allowlisted action
  --approval-mode safe-auto  Auto-approve only low-risk file tools (default)
  --approval-mode broad-auto Auto-approve broad non-shell work, but never
                              credentials, publishing, network, or hard denies
  --auto                     Alias for persistent broad-auto
  --no-auto                  Alias for persistent ask

The default interactive launch uses the fast coding profile: optional tool
containers and MCP clients stay disabled. Missing selected images are still
built automatically once. Tab-switching agents does not activate a tool stack;
quit and relaunch with \`occtl open --with-research\` or
\`occtl open --with-design\` first.

Aliases: opencode-command-center, lab, opencode-lab

Run from any directory. Credentials stay in this harness opencode.env and are
never copied into the selected workspace.

Named \`occtl\` so it does not collide with the standalone OpenCode CLI binary.
Legacy Lab identifiers remain supported during v0.x.`);
  process.exit(0);
}

function runNode(script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env
  });
  return result.status ?? 1;
}

function runLauncher(launcherArgs = []) {
  return runNode(launcher, launcherArgs);
}

function pathAndForwarded(commandArgs) {
  const candidate = commandArgs[1];
  if (candidate && !candidate.startsWith("-")) {
    return { path: candidate, forwarded: commandArgs.slice(2) };
  }
  return { path: null, forwarded: commandArgs.slice(1) };
}

function withoutStrict(values) {
  const strict = values.filter((value) => value === "--strict").length;
  if (strict > 1) throw new Error("--strict may be provided only once.");
  return {
    strict: strict === 1,
    values: values.filter((value) => value !== "--strict")
  };
}

function topLevelStrictWorkspace(values) {
  const remaining = values.filter((value) => value !== "--strict");
  if (remaining.length === 0) return process.cwd();
  if (remaining.length === 2 && remaining[0] === "--workspace") {
    return remaining[1];
  }
  throw new Error("Usage: lab --strict [--workspace path]");
}

function chooseNewWorkspaceOnMac() {
  if (process.platform !== "darwin" || !process.stdin.isTTY) return null;
  try {
    const selected = execFileSync(
      "osascript",
      [
        "-e",
        'set parentFolder to choose folder with prompt "Choose where to create the project"',
        "-e",
        'set projectDialog to display dialog "Project folder name" default answer ""',
        "-e",
        "set projectName to text returned of projectDialog",
        "-e",
        'if projectName is "" then error number -128',
        "-e",
        "POSIX path of parentFolder & projectName"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return selected || null;
  } catch (error) {
    if (error && typeof error === "object" && error.status === 1) return null;
    throw error;
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function configuredPackIds() {
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8")
  );
  const version = manifest.labPackApiVersion ?? manifest.version;
  return loadPackSet({
    roots: configuredPackRoots({ envFile }),
    labVersion: version
  }).packs.map(({ id }) => id);
}

async function approveProjectContract(path) {
  if (args.includes("--yes")) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = (
      await prompt.question(`Write ${path}? Type yes to approve: `)
    )
      .trim()
      .toLowerCase();
    return answer === "yes";
  } finally {
    prompt.close();
  }
}

function initOptions(values) {
  const enabledPacks = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--yes") continue;
    if (value !== "--pack") {
      throw new Error(`Unsupported occtl init option: ${value}`);
    }
    const pack = values[index + 1];
    if (!pack || pack.startsWith("-")) {
      throw new Error("--pack requires a configured pack ID.");
    }
    enabledPacks.push(pack);
    index += 1;
  }
  const available = new Set(configuredPackIds());
  const unknown = enabledPacks.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unavailable pack ID: ${unknown.join(", ")}`);
  }
  return { enabledPacks: [...new Set(enabledPacks)] };
}

function updateRef(values) {
  if (values.length === 0) return "main";
  if (values.length !== 2 || values[0] !== "--ref")
    throw new Error("Usage: occtl update [--ref REF]");
  return values[1];
}

async function lifecycleCommand() {
  const command = args[0];
  if (command === "strict" && args[1] === "doctor") {
    const forwarded = args.slice(2);
    if (forwarded.some((value) => value !== "--json")) {
      throw new Error("Usage: occtl strict doctor [--json]");
    }
    return runNode(strictDoctor, forwarded);
  }
  if (command === "strict" && args[1] === "run") {
    const selected = pathAndForwarded(args.slice(1));
    if (selected.forwarded.length > 0) {
      throw new Error("Usage: occtl strict run [path]");
    }
    return runNode(strictRun, [selected.path ?? process.cwd()]);
  }
  if (command === "strict" && ["export", "adopt"].includes(args[1])) {
    return runNode(strictExport, args.slice(1));
  }
  if (command === "open") {
    const selected = pathAndForwarded(args);
    const mode = withoutStrict(selected.forwarded);
    if (mode.strict) {
      if (mode.values.length > 0) {
        throw new Error(
          "Strict mode does not accept normal launcher profile flags."
        );
      }
      return runNode(strictRun, [selected.path ?? process.cwd()]);
    }
    return runLauncher(
      selected.path
        ? ["--workspace", selected.path, ...mode.values]
        : mode.values
    );
  }
  if (command === "new") {
    const selected = pathAndForwarded(args);
    const requested = selected.path ?? chooseNewWorkspaceOnMac();
    if (!requested) {
      if (process.platform !== "darwin" || !process.stdin.isTTY) {
        throw new Error("occtl new requires a project folder path.");
      }
      console.log("No project location selected. OpenCode was not started.");
      return 0;
    }
    const workspace = prepareNewWorkspace(requested);
    console.log(
      `${workspace.created ? "Created" : "Opening empty"} workspace: ${workspace.path}`
    );
    return runLauncher(["--workspace", workspace.path, ...selected.forwarded]);
  }
  if (command === "recent") {
    const snapshot = lifecycleSnapshot(registryPath);
    if (args.includes("--json")) printJson(snapshot.projects);
    else console.log(formatRecentProjects(snapshot));
    return 0;
  }
  if (command === "status") {
    const snapshot = lifecycleSnapshot(registryPath);
    if (args.includes("--json")) printJson(snapshot);
    else console.log(formatLifecycleStatus(snapshot));
    return 0;
  }
  if (command === "stop") {
    const result = stopForegroundWorkspace({
      registryPath,
      expectedLauncher: launcher
    });
    if (args.includes("--json")) printJson(result);
    else if (result.stopped) {
      console.log(
        `Stopped OpenCode Command Center for ${result.canonicalPath}.`
      );
    } else {
      console.log(
        "No foreground OpenCode Command Center workspace is running."
      );
    }
    return 0;
  }
  if (command === "resume") {
    const selected = pathAndForwarded(args);
    const snapshot = lifecycleSnapshot(registryPath);
    const project = resolveRecentProject(snapshot, selected.path);
    if (snapshot.foreground?.projectId === project.projectId) {
      console.log(
        `Workspace is already active: ${snapshot.foreground.canonicalPath} (PID ${snapshot.foreground.pid})`
      );
      return 0;
    }
    return runLauncher([
      "--workspace",
      project.canonicalPath,
      ...selected.forwarded
    ]);
  }
  if (command === "init") {
    const selected = pathAndForwarded(args);
    const options = initOptions(selected.forwarded);
    const workspace = selected.path ?? process.cwd();
    const loaded = loadProjectContract(workspace, {
      enabledPacks: options.enabledPacks
    });
    console.log(`Project contract preview (${loaded.source}):`);
    console.log(JSON.stringify(loaded.contract, null, 2));
    if (loaded.source === "declared") {
      console.log(`Project contract already exists: ${loaded.path}`);
      return 0;
    }
    if (!(await approveProjectContract(loaded.path))) {
      console.log(
        "Preview only; no file was written. Re-run interactively or pass --yes to approve."
      );
      return 0;
    }
    const result = writeProjectContract(workspace, loaded.contract, {
      approved: true
    });
    console.log(`Wrote approved project contract: ${result.path}`);
    return 0;
  }
  if (command === "doctor") {
    const selected = pathAndForwarded(args);
    return runNode(doctor, [
      "--workspace",
      selected.path ?? process.cwd(),
      ...selected.forwarded
    ]);
  }
  if (command === "verify") {
    const selected = pathAndForwarded(args);
    if (selected.forwarded.length > 0) {
      throw new Error("Usage: occtl verify [path]");
    }
    return runNode(verify, [selected.path ?? process.cwd()]);
  }
  if (command === "prune") return runNode(prune, args.slice(1));
  if (command === "version") {
    printJson(versionInfo({ packageRoot, paths: hostPaths }));
    return 0;
  }
  if (command === "update") {
    const result = performUpdate({
      packageRoot,
      ref: updateRef(args.slice(1)),
      paths: hostPaths
    });
    console.log(
      `Activated OpenCode Command Center ${result.commit.slice(0, 12)}. The next occtl command uses ${result.path}.`
    );
    return 0;
  }
  if (command === "rollback") {
    if (args.length !== 1) throw new Error("Usage: occtl rollback");
    const result = rollbackRelease({ packageRoot, paths: hostPaths });
    console.log(
      `Rolled back OpenCode Command Center to ${result.commit.slice(0, 12)}. State backup: ${result.backup}`
    );
    return 0;
  }
  return null;
}

try {
  if (args.includes("--setup")) {
    process.exitCode = runNode(setup);
  } else if (args[0] === "--strict") {
    process.exitCode = runNode(strictRun, [topLevelStrictWorkspace(args)]);
  } else {
    const status = await lifecycleCommand();
    process.exitCode = status === null ? runLauncher(args) : status;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
