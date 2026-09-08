import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveExecutionAdapter } from "./execution-adapters.mjs";

export const LAB_LOCAL_EXCLUDES = Object.freeze([
  "/.quality/",
  "/.opencode-user/"
]);

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    output: String(result.stdout ?? "").trim(),
    error: String(result.stderr ?? result.error?.message ?? "").trim()
  };
}

function check(id, status, summary, detail) {
  return { id, status, summary, ...(detail ? { detail } : {}) };
}

function repositoryDetails(workspace, execute) {
  const root = execute("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspace
  });
  if (!root.ok) return { git: false, clean: false, root: null };
  const status = execute("git", ["status", "--porcelain=v1"], {
    cwd: workspace
  });
  return {
    git: true,
    clean: status.ok && status.output.length === 0,
    root: resolve(root.output)
  };
}

function excludePath(workspace, execute) {
  const result = execute("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: workspace
  });
  const common = execute("git", ["rev-parse", "--git-common-dir"], {
    cwd: workspace
  });
  if (!result.ok || !result.output || !common.ok || !common.output) return null;
  const path = resolve(workspace, result.output);
  const expected = resolve(workspace, common.output, "info", "exclude");
  if (path !== expected) {
    throw new Error("Git returned an unexpected local exclude path.");
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link Git exclude file: ${path}`);
  }
  return path;
}

export function ensureLocalGitExcludes(
  workspace,
  { execute = run, patterns = LAB_LOCAL_EXCLUDES, append = appendFileSync } = {}
) {
  const path = excludePath(workspace, execute);
  if (!path)
    return { available: false, configured: false, changed: false, path: null };
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (missing.length === 0) {
    return { available: true, configured: true, changed: false, path };
  }
  mkdirSync(dirname(path), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  append(
    path,
    `${separator}# OpenCode Command Center host-owned runtime compatibility\n${missing.join("\n")}\n`,
    { mode: 0o600 }
  );
  return { available: true, configured: true, changed: true, path };
}

function inspectLocalGitExcludes(workspace, execute) {
  const path = excludePath(workspace, execute);
  if (!path || !existsSync(path)) {
    return {
      available: Boolean(path),
      configured: false,
      changed: false,
      path
    };
  }
  const present = new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return {
    available: true,
    configured: LAB_LOCAL_EXCLUDES.every((pattern) => present.has(pattern)),
    changed: false,
    path
  };
}

function portListener(port, execute) {
  const result = execute(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
    {}
  );
  if (!result.ok || !result.output) return null;
  const pid = result.output.match(/^p(\d+)$/mu)?.[1] ?? "unknown";
  const command = result.output.match(/^c(.+)$/mu)?.[1] ?? "unknown";
  return { port, pid, command };
}

function declaredExecutables(contract) {
  return [contract.install, contract.verify, contract.development]
    .flat()
    .map((command) => command.argv[0]);
}

function projectCommandIssues(workspace, contract) {
  let scripts = {};
  const packagePath = resolve(workspace, "package.json");
  if (existsSync(packagePath)) {
    const details = lstatSync(packagePath);
    if (
      !details.isSymbolicLink() &&
      details.isFile() &&
      details.size <= 1024 * 1024
    ) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
        if (manifest?.scripts && typeof manifest.scripts === "object") {
          scripts = manifest.scripts;
        }
      } catch {
        return ["package.json is not valid JSON."];
      }
    }
  }
  const issues = [];
  for (const command of [
    ...contract.install,
    ...contract.verify,
    ...contract.development
  ]) {
    const cwd = resolve(workspace, command.cwd ?? ".");
    if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) {
      issues.push(`${command.name} uses a missing working directory.`);
    }
    const [executable, subcommand, script] = command.argv;
    const npmStyle = ["npm", "pnpm", "bun"].includes(executable);
    const scriptName = npmStyle && subcommand === "run" ? script : null;
    if (scriptName && typeof scripts[scriptName] !== "string") {
      issues.push(
        `${command.name} references missing package script ${scriptName}.`
      );
    }
    if (
      executable === "npm" &&
      subcommand === "ci" &&
      !existsSync(resolve(workspace, "package-lock.json"))
    ) {
      issues.push(`${command.name} uses npm ci without package-lock.json.`);
    }
    if (
      executable === "pnpm" &&
      command.argv.includes("--frozen-lockfile") &&
      !existsSync(resolve(workspace, "pnpm-lock.yaml"))
    ) {
      issues.push(`${command.name} requires a missing pnpm-lock.yaml.`);
    }
  }
  return issues;
}

export function collectProjectPreflight({
  workspace,
  contract,
  contractSource = "detected",
  applyExcludes = true,
  execute = run
}) {
  const canonical = resolve(workspace);
  const checks = [];
  const repository = repositoryDetails(canonical, execute);
  checks.push(
    repository.git
      ? check("git", "pass", `Git repository: ${repository.root}`)
      : check(
          "git",
          "warn",
          "Not a Git repository; interactive editing works, but managed runs are disabled.",
          "Run `git init` and create a clean baseline commit to enable managed runs."
        )
  );

  let excludes = {
    available: false,
    configured: false,
    changed: false,
    path: null
  };
  if (repository.git) {
    excludes = applyExcludes
      ? ensureLocalGitExcludes(canonical, { execute })
      : inspectLocalGitExcludes(canonical, execute);
    checks.push(
      check(
        "local-ignore",
        excludes.configured ? "pass" : excludes.available ? "warn" : "fail",
        excludes.configured
          ? `Local Lab artifacts are excluded through ${excludes.path}.`
          : excludes.available
            ? "Lab-only Git exclude patterns have not been installed yet."
            : "Git local excludes are unavailable.",
        excludes.changed
          ? "Added Lab-only patterns without changing .gitignore."
          : !excludes.configured && excludes.available
            ? "Opening the project will add them to .git/info/exclude without changing .gitignore."
            : undefined
      )
    );
  }

  const executables = [...new Set(declaredExecutables(contract))];
  const adapter = resolveExecutionAdapter({ workspace: canonical, contract });
  const supportedExecutables = new Set(adapter.supportedExecutables);
  const unsupported = executables.filter(
    (executable) => !supportedExecutables.has(executable)
  );

  const commandIssues = projectCommandIssues(canonical, contract);
  checks.push(
    commandIssues.length === 0
      ? check("commands", "pass", "Declared project commands are resolvable.")
      : check(
          "commands",
          "fail",
          `${commandIssues.length} declared project command issue${commandIssues.length === 1 ? "" : "s"}.`,
          commandIssues.join(" ")
        )
  );
  checks.push(
    unsupported.length === 0
      ? check(
          "runtime",
          "pass",
          executables.length
            ? `${adapter.kind} adapter supports declared executables: ${executables.join(", ")}.`
            : "No project runtime is declared; opening an empty workspace is supported."
        )
      : check(
          "runtime",
          "fail",
          `Unsupported executable${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`,
          `Use commands supported by the ${adapter.kind} adapter or add a compatible execution adapter before launch.`
        )
  );

  checks.push(
    contract.verify.length > 0
      ? check(
          "verification",
          "pass",
          `${contract.verify.length} verification command${contract.verify.length === 1 ? "" : "s"} declared.`
        )
      : check(
          "verification",
          "warn",
          "No verification command is declared; managed runs are disabled.",
          "Add a test, check, lint, typecheck, or build command to .opencode-lab/project.json."
        )
  );

  const listeners = contract.previewPorts
    .map(({ host }) => portListener(host, execute))
    .filter(Boolean);
  checks.push(
    listeners.length === 0
      ? check("preview-ports", "pass", "Declared preview ports are available.")
      : check(
          "preview-ports",
          "warn",
          `Preview port${listeners.length === 1 ? " is" : "s are"} already in use.`,
          listeners
            .map(({ port, command, pid }) => `${port}: ${command} (PID ${pid})`)
            .join("; ")
        )
  );

  const hardFailures = checks.filter((entry) => entry.status === "fail");
  const workspaceOwnsRepository = repository.root === canonical;
  const managedEligible =
    repository.git &&
    workspaceOwnsRepository &&
    repository.clean &&
    contract.verify.length > 0 &&
    unsupported.length === 0 &&
    commandIssues.length === 0;
  checks.push(
    managedEligible
      ? check("managed-run", "pass", "Workspace is eligible for managed runs.")
      : check(
          "managed-run",
          "warn",
          "Workspace is not yet eligible for managed runs.",
          repository.git && !workspaceOwnsRepository
            ? `Open the Git root (${repository.root}) instead of a nested folder.`
            : !repository.clean && repository.git
              ? "Commit or stash current changes before starting a managed run."
              : "Resolve the Git, runtime, and verification checks above."
        )
  );
  return {
    healthy: hardFailures.length === 0,
    managedEligible,
    workspace: canonical,
    contractSource,
    repository,
    excludes,
    checks
  };
}

export function preflightLines(report) {
  return [
    `Project preflight (${report.contractSource})`,
    ...report.checks.map((entry) => {
      const icon =
        entry.status === "pass"
          ? "PASS"
          : entry.status === "warn"
            ? "WARN"
            : "FAIL";
      return `${icon} ${entry.summary}${entry.detail ? ` ${entry.detail}` : ""}`;
    })
  ];
}
