import assert from "node:assert/strict";
import test from "node:test";
import { withClipboardFriendlyTui } from "./opencode-tui-merge.mjs";

test("clipboard-friendly TUI keeps mouse on and adds copy/paste binds", () => {
  const next = withClipboardFriendlyTui({
    theme: "dracula",
    mouse: false,
    keybinds: { command_list: "ctrl+p" },
    plugin: ["./plugins/agent-ops.tsx"]
  });
  assert.equal(next.theme, "dracula");
  assert.equal(next.mouse, true);
  assert.deepEqual(next.keybinds.command_list, "ctrl+p");
  assert.deepEqual(next.keybinds.messages_copy, ["<leader>y", "ctrl+shift+c"]);
  assert.equal(next.keybinds.input_paste[0].key, "ctrl+v");
  assert.equal(next.keybinds.input_paste[1].key, "super+v");
  assert.deepEqual(next.plugin, [
    "./plugins/agent-ops.tsx",
    "./plugins/cache-stats.tsx",
    "./plugins/workflow-menu.tsx",
    "./plugins/run-center.tsx",
    "./plugins/lifecycle-hooks.tsx"
  ]);
});
