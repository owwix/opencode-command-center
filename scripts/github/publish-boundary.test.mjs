import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commentOnGitHubThread,
  createGitHubIssue,
  listGitHubIssues,
  listGitHubPullRequests,
  preparePullRequest,
  viewGitHubIssue,
  viewGitHubPullRequest
} from "./publish-boundary.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8"
  }).trim();
}

test("fake GitHub receives the verified commit and PR preparation is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-boundary-"));
  try {
    git(root, "init", "-q", "-b", "agent/verified-output");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "README.md"), "verified implementation\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "feat: verified output");
    git(root, "remote", "add", "origin", "https://github.com/owwix/demo.git");
    const reviewedHead = git(root, "rev-parse", "HEAD");
    let existing = null;
    let createCalls = 0;
    let pushedHead = null;
    let publishedContent = null;

    const runner = (command, args, options = {}) => {
      if (command === "git" && args[0] === "push") {
        pushedHead = git(options.cwd, "rev-parse", "HEAD");
        return `ok ${pushedHead}`;
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify(existing ? [existing] : []);
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        createCalls += 1;
        publishedContent = git(options.cwd, "show", `${pushedHead}:README.md`);
        existing = {
          url: "https://github.com/owwix/demo/pull/7",
          headRefName: "agent/verified-output",
          baseRefName: "main",
          headRefOid: pushedHead
        };
        return existing.url;
      }
      return execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
    };

    const request = {
      workspace: root,
      title: "feat: publish verified output",
      body: "Verified by the managed controller.",
      expectedBranch: "agent/verified-output",
      expectedHeadSha: reviewedHead,
      runner
    };
    const first = preparePullRequest(request);
    const second = preparePullRequest(request);

    assert.equal(first.created, true);
    assert.equal(first.headSha, reviewedHead);
    assert.equal(second.reused, true);
    assert.equal(second.url, first.url);
    assert.equal(createCalls, 1);
    assert.equal(pushedHead, reviewedHead);
    assert.equal(publishedContent, "verified implementation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private GitHub helpers stay scoped to the current origin", () => {
  const root = mkdtempSync(join(tmpdir(), "github-tools-"));
  try {
    git(root, "init", "-q", "-b", "agent/github-tools");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "README.md"), "fixture\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "test: fixture");
    git(root, "remote", "add", "origin", "https://github.com/owwix/demo.git");
    const calls = [];
    const runner = (command, args, options = {}) => {
      calls.push([command, args]);
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([{ number: 7, title: "Review me" }]);
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({ number: 7, title: "Review me" });
      }
      if (command === "gh" && args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([{ number: 9, title: "Ship it" }]);
      }
      if (command === "gh" && args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ number: 9, title: "Ship it" });
      }
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/owwix/demo/issues/10";
      }
      if (command === "gh" && args[1] === "comment") {
        return "https://github.com/owwix/demo/issues/9#issuecomment-1";
      }
      return execFileSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
    };

    assert.equal(
      listGitHubPullRequests({ workspace: root, runner }).pullRequests[0]
        .number,
      7
    );
    assert.equal(
      viewGitHubPullRequest({ workspace: root, number: 7, runner }).pullRequest
        .number,
      7
    );
    assert.equal(
      listGitHubIssues({ workspace: root, runner }).issues[0].number,
      9
    );
    assert.equal(
      viewGitHubIssue({ workspace: root, number: 9, runner }).issue.number,
      9
    );
    assert.match(
      createGitHubIssue({ workspace: root, title: "Ship it", runner }).url,
      /issues\/10$/u
    );
    assert.match(
      commentOnGitHubThread({
        workspace: root,
        kind: "issue",
        number: 9,
        body: "LGTM",
        runner
      }).url,
      /issuecomment/u
    );

    for (const [command, args] of calls.filter(
      ([command]) => command === "gh"
    )) {
      assert.equal(command, "gh");
      assert.equal(args[args.indexOf("--repo") + 1], "owwix/demo");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
