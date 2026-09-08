import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function workspaceArgument(argv) {
  const index = argv.indexOf("--workspace");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error("--workspace requires a folder path.");
  }
  return value;
}

export function withoutWorkspaceArgument(argv) {
  const index = argv.indexOf("--workspace");
  if (index === -1) return argv;
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

function chooseWorkspaceOnMac() {
  try {
    const selected = execFileSync(
      "osascript",
      [
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project folder to open in OpenCode")'
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return selected || null;
  } catch (error) {
    // AppleScript reports a user cancel with status 1. Treat that as a normal
    // no-op instead of falling through to a surprising default workspace.
    if (error && typeof error === "object" && error.status === 1) return null;
    throw error;
  }
}

export function selectWorkspace(argv) {
  const explicit = workspaceArgument(argv) || process.env.OPENCODE_WORKSPACE;
  if (explicit) return resolve(explicit);
  if (process.platform === "darwin" && process.stdin.isTTY) {
    return chooseWorkspaceOnMac();
  }
  // Non-interactive callers such as CI retain the original behavior. An
  // interactive macOS launch always presents the Finder folder picker.
  return resolve(".");
}
