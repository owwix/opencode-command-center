import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/** Give a managed container its own read-only Git metadata, never the shared
 * worktree administrative directory (which can mutate sibling branches). */
export function prepareManagedGitView(workspace, stateRoot) {
  mkdirSync(stateRoot, { recursive: true });
  const parent = mkdtempSync(join(stateRoot, "git-view-"));
  chmodSync(parent, 0o755);
  const directory = join(parent, "repository.git");
  execFileSync(
    "git",
    [
      "clone",
      "--bare",
      "--no-hardlinks",
      "--single-branch",
      "--no-tags",
      workspace,
      directory
    ],
    { stdio: "pipe", timeout: 120000 }
  );
  const git = (...args) =>
    execFileSync("git", [`--git-dir=${directory}`, ...args], { stdio: "pipe" });
  git("config", "--remove-section", "remote.origin");
  git("config", "core.bare", "false");
  git("read-tree", "HEAD");
  git("config", "core.worktree", "/workspace");
  return directory;
}
