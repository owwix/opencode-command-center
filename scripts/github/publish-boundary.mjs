import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "release"]);

export function redactPublishOutput(value) {
  return String(value)
    .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/giu, "$1[redacted]@")
    .replace(/(gh[pousr]_[A-Za-z0-9_-]+)/gu, "[github-token-redacted]");
}

export function defaultPublishRunner(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const failure =
      /** @type {Error & { stdout?: unknown, stderr?: unknown }} */ (error);
    const stdout = failure.stdout?.toString?.() ?? "";
    const stderr = failure.stderr?.toString?.() ?? "";
    throw new Error(
      redactPublishOutput(
        stderr || stdout || failure.message || `${command} failed`
      )
    );
  }
}

function git(workspace, runner, args, options = {}) {
  return runner("git", args, { cwd: workspace, ...options });
}

function branch(workspace, runner) {
  const value = git(workspace, runner, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!value || value === "HEAD") {
    throw new Error("Detached HEAD cannot be published.");
  }
  return value;
}

function assertPublishBranch(value) {
  if (PROTECTED_BRANCHES.has(value)) {
    throw new Error(`Refusing to publish protected branch '${value}'.`);
  }
}

function githubRemote(workspace, runner) {
  const remote = git(workspace, runner, [
    "remote",
    "get-url",
    "--push",
    "origin"
  ]);
  let path = "";
  if (remote.startsWith("git@github.com:")) {
    path = remote.slice("git@github.com:".length);
  } else {
    let parsed;
    try {
      parsed = new URL(remote);
    } catch {
      throw new Error("origin push remote is not a valid GitHub URL.");
    }
    if (parsed.hostname.toLowerCase() !== "github.com") {
      throw new Error("Refusing to publish to a non-GitHub origin.");
    }
    path = parsed.pathname.slice(1);
  }
  if (!path || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+(?:\.git)?$/u.test(path)) {
    throw new Error("origin is not a supported GitHub repository URL.");
  }
  return {
    display: `github.com/${path.replace(/\.git$/u, "")}`,
    raw: remote
  };
}

function githubRepository(workspace, runner) {
  const remote = githubRemote(workspace, runner);
  return remote.display.replace(/^github\.com\//u, "");
}

function positiveIssueNumber(value, label = "issue") {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`A positive ${label} number is required.`);
  }
  return number;
}

function boundedText(value, label, { min = 1, max }) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label} must be ${min}-${max} characters.`);
  }
  return text;
}

export function publishStatus({ workspace, runner = defaultPublishRunner }) {
  const root = realpathSync(workspace);
  const branchName = branch(root, runner);
  const remote = githubRemote(root, runner);
  const porcelain = git(root, runner, ["status", "--porcelain=v1"]);
  const headSha = git(root, runner, ["rev-parse", "HEAD"]);
  let ahead = null;
  let behind = null;
  try {
    const counts = git(root, runner, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}"
    ]);
    [ahead, behind] = counts.split(/\s+/u).map(Number);
  } catch {
    // New branches do not have an upstream yet.
  }
  return {
    workspace: root,
    branch: branchName,
    headSha,
    remote: remote.display,
    dirty: Boolean(porcelain),
    ahead,
    behind
  };
}

/**
 * GitHub operations stay on the trusted host. They are deliberately scoped to
 * the origin of the selected workspace, so an agent never receives a general
 * GitHub credential or an arbitrary `gh api` escape hatch.
 */
export function listGitHubPullRequests({
  workspace,
  runner = defaultPublishRunner
}) {
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const output = runner(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,author,url,headRefName,baseRefName,updatedAt"
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 512 * 1024 }
  );
  return {
    repository: `github.com/${repository}`,
    pullRequests: JSON.parse(output || "[]")
  };
}

export function viewGitHubPullRequest({
  workspace,
  number,
  runner = defaultPublishRunner
}) {
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const pullRequest = positiveIssueNumber(number, "pull request");
  const output = runner(
    "gh",
    [
      "pr",
      "view",
      String(pullRequest),
      "--repo",
      repository,
      "--json",
      "number,title,body,state,url,author,headRefName,baseRefName,comments,reviewDecision"
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 }
  );
  return {
    repository: `github.com/${repository}`,
    pullRequest: JSON.parse(output)
  };
}

export function listGitHubIssues({ workspace, runner = defaultPublishRunner }) {
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const output = runner(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,author,url,labels,updatedAt"
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 512 * 1024 }
  );
  return {
    repository: `github.com/${repository}`,
    issues: JSON.parse(output || "[]")
  };
}

export function viewGitHubIssue({
  workspace,
  number,
  runner = defaultPublishRunner
}) {
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const issue = positiveIssueNumber(number);
  const output = runner(
    "gh",
    [
      "issue",
      "view",
      String(issue),
      "--repo",
      repository,
      "--json",
      "number,title,body,state,url,author,labels,comments"
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 }
  );
  return { repository: `github.com/${repository}`, issue: JSON.parse(output) };
}

export function createGitHubIssue({
  workspace,
  title,
  body = "",
  runner = defaultPublishRunner
}) {
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const normalizedTitle = boundedText(title, "Issue title", { max: 200 });
  const normalizedBody = boundedText(body, "Issue body", {
    min: 0,
    max: 20_000
  });
  const url = runner(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      normalizedTitle,
      "--body",
      normalizedBody
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 128 * 1024 }
  );
  return {
    repository: `github.com/${repository}`,
    created: true,
    url: redactPublishOutput(url)
  };
}

export function commentOnGitHubThread({
  workspace,
  kind,
  number,
  body,
  runner = defaultPublishRunner
}) {
  if (!new Set(["issue", "pr"]).has(kind)) {
    throw new Error("Comment kind must be 'issue' or 'pr'.");
  }
  const root = realpathSync(workspace);
  const repository = githubRepository(root, runner);
  const thread = positiveIssueNumber(
    number,
    kind === "pr" ? "pull request" : "issue"
  );
  const normalizedBody = boundedText(body, "Comment body", { max: 20_000 });
  const url = runner(
    "gh",
    [
      kind,
      "comment",
      String(thread),
      "--repo",
      repository,
      "--body",
      normalizedBody
    ],
    { cwd: root, timeout: 120_000, maxBuffer: 128 * 1024 }
  );
  return {
    repository: `github.com/${repository}`,
    commented: true,
    url: redactPublishOutput(url)
  };
}

function assertReady({ workspace, expectedBranch, expectedHeadSha, runner }) {
  const status = publishStatus({ workspace, runner });
  assertPublishBranch(status.branch);
  if (status.dirty) {
    throw new Error(
      "Refusing to publish while the workspace has uncommitted changes."
    );
  }
  if (expectedBranch && expectedBranch !== status.branch) {
    throw new Error(
      `Branch changed since review: expected '${expectedBranch}', found '${status.branch}'.`
    );
  }
  if (expectedHeadSha && expectedHeadSha !== status.headSha) {
    throw new Error(
      `HEAD changed since review: expected '${expectedHeadSha}', found '${status.headSha}'.`
    );
  }
  return status;
}

export function pushReviewedBranch({
  workspace,
  expectedBranch,
  expectedHeadSha,
  runner = defaultPublishRunner
}) {
  const status = assertReady({
    workspace,
    expectedBranch,
    expectedHeadSha,
    runner
  });
  const output = runner(
    "git",
    ["push", "--porcelain", "--set-upstream", "origin", "HEAD"],
    {
      cwd: status.workspace,
      timeout: 120_000,
      maxBuffer: 512 * 1024
    }
  );
  return { ...status, pushed: true, output: redactPublishOutput(output) };
}

function existingPullRequest(workspace, branchName, base, runner) {
  const output = runner(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branchName,
      "--base",
      base,
      "--state",
      "open",
      "--json",
      "url,headRefName,baseRefName,headRefOid",
      "--limit",
      "1"
    ],
    { cwd: workspace, timeout: 120_000, maxBuffer: 128 * 1024 }
  );
  let rows;
  try {
    rows = JSON.parse(output || "[]");
  } catch {
    throw new Error("GitHub CLI returned invalid pull-request JSON.");
  }
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

export function preparePullRequest({
  workspace,
  title,
  body = "",
  base = "main",
  expectedBranch,
  expectedHeadSha,
  runner = defaultPublishRunner
}) {
  const normalizedTitle = String(title ?? "").trim();
  const normalizedBody = String(body ?? "").trim();
  if (!normalizedTitle || normalizedTitle.length > 200) {
    throw new Error("A PR title up to 200 characters is required.");
  }
  if (normalizedBody.length > 20_000) throw new Error("PR body is too long.");
  if (base !== "main") throw new Error("PRs may only target main.");

  const pushed = pushReviewedBranch({
    workspace,
    expectedBranch,
    expectedHeadSha,
    runner
  });
  const existing = existingPullRequest(
    pushed.workspace,
    pushed.branch,
    base,
    runner
  );
  if (existing) {
    if (existing.headRefOid && existing.headRefOid !== pushed.headSha) {
      throw new Error(
        `Existing PR head ${existing.headRefOid} does not match reviewed SHA ${pushed.headSha}.`
      );
    }
    return {
      ...pushed,
      base,
      url: redactPublishOutput(existing.url),
      created: false,
      reused: true
    };
  }
  const url = runner(
    "gh",
    [
      "pr",
      "create",
      "--title",
      normalizedTitle,
      "--body",
      normalizedBody || normalizedTitle,
      "--base",
      base
    ],
    { cwd: pushed.workspace, timeout: 120_000, maxBuffer: 128 * 1024 }
  );
  return {
    ...pushed,
    base,
    url: redactPublishOutput(url),
    created: true,
    reused: false
  };
}
