import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function withClipboardFriendlyTui(current) {
  const plugins = Array.isArray(current.plugin) ? [...current.plugin] : [];
  for (const plugin of [
    "./plugins/agent-ops.tsx",
    "./plugins/cache-stats.tsx",
    "./plugins/workflow-menu.tsx",
    "./plugins/run-center.tsx",
    "./plugins/lifecycle-hooks.tsx"
  ]) {
    if (!plugins.includes(plugin)) plugins.push(plugin);
  }
  return {
    ...current,
    // Keep mouse on so Ctrl+P, permission dialogs, and lists are clickable.
    // Copy/paste still works via the keybinds below (Cmd/Ctrl+V, leader+y).
    mouse: true,
    plugin: plugins,
    keybinds: {
      ...(current.keybinds && typeof current.keybinds === "object"
        ? current.keybinds
        : {}),
      messages_copy: ["<leader>y", "ctrl+shift+c"],
      input_paste: [
        { key: "ctrl+v", preventDefault: false },
        { key: "super+v", preventDefault: false }
      ]
    }
  };
}

/** Merge Lab defaults locally inside the existing state-init container. */
export function mergeClipboardFriendlyTuiFile(path) {
  const next = withClipboardFriendlyTui(JSON.parse(readFileSync(path, "utf8")));
  const temporary = `${path}.opencode-lab-tmp`;
  let writeError;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600
    });
    renameSync(temporary, path);
  } catch (error) {
    writeError = error;
  }
  let cleanupError;
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") cleanupError = error;
  }
  if (writeError) throw writeError;
  if (cleanupError) throw cleanupError;
  return next;
}

const invokedAsScript =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: opencode-tui-merge.mjs <tui.json>");
  mergeClipboardFriendlyTuiFile(path);
}
