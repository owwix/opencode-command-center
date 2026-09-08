import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareManagedGitView } from "./launcher/git-view.mjs";

test("managed worktree Git metadata is independent and omits the host origin", (t) => {
  const root = mkdtempSync(join(tmpdir(), "managed-git-view-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: "pipe"
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "a.txt"), "original");
  git("add", ".");
  git("commit", "-qm", "initial");
  const worktree = join(root, "worktree");
  git("worktree", "add", "-b", "managed", worktree);
  const directory = prepareManagedGitView(worktree, join(root, "state"));
  assert.equal(
    execFileSync("git", [`--git-dir=${directory}`, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    git("rev-parse", "HEAD")
  );
  assert.doesNotMatch(
    readFileSync(join(directory, "config"), "utf8"),
    /remote|url =/
  );
  writeFileSync(join(worktree, "a.txt"), "modified");
  const diff = execFileSync(
    "git",
    [
      `--git-dir=${directory}`,
      `--work-tree=${worktree}`,
      "diff",
      "--name-only"
    ],
    { encoding: "utf8" }
  );
  assert.equal(diff.trim(), "a.txt");
  assert.equal(git("status", "--porcelain"), "");
});
