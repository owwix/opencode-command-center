/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight lifecycle audit: append session breadcrumbs to a workspace log
 * (hooks-style observability for Command Center operators).
 */
const tui: TuiPlugin = async (api) => {
  const root =
    process.env.OPENCODE_WORKSPACE_CONTAINER ||
    process.env.OPENCODE_WORKSPACE ||
    "/workspace";
  const logPath = join(root, ".lab-hooks", "tool-events.jsonl");

  function write(event: Record<string, unknown>) {
    try {
      mkdirSync(join(root, ".lab-hooks"), { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`
      );
    } catch {
      // Audit must never break the agent loop.
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "lab.hooks-status",
        title: "Command Center: show lifecycle hooks log path",
        category: "Command Center",
        namespace: "palette",
        slashName: "hooks",
        run: () => {
          api.ui.toast({
            message: `Lifecycle audit log: ${logPath}`,
            variant: "info"
          });
        }
      }
    ],
    bindings: []
  });

  write({ type: "plugin.start" });
  api.lifecycle.onDispose(() => {
    write({ type: "dispose" });
  });
};

const plugin: TuiPluginModule = { id: "lab.lifecycle-hooks", tui };
export default plugin;
