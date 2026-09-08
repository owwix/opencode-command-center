/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule
} from "@opencode-ai/plugin/tui";
import {
  agentStripLine,
  loadedPacks,
  resolveMountName,
  startupMountHint
} from "./lab-ui-lib.mjs";

function mountContext(api: TuiPluginApi) {
  return {
    directory: api.state.path.directory,
    workspaceName: process.env.OPENCODE_WORKSPACE_NAME
  };
}

function WorkflowMenu(props: { api: TuiPluginApi }) {
  const theme = props.api.theme.current;
  const ctx = mountContext(props.api);
  const mount = resolveMountName(ctx);
  const packs = loadedPacks();

  return (
    <box width={72} padding={2} gap={1}>
      <text fg={theme.accent}>
        <b>Command Center workflow menu</b>
      </text>
      <text fg={theme.textMuted}>{startupMountHint(ctx)}</text>
      <text fg={theme.textMuted}>
        Choose a workflow from the command palette or type its slash command.
      </text>
      <text fg={theme.info}>
        Tab coding lanes: fast (small) · lab (standard) · deep (complex/risky)
      </text>
      <text fg={theme.textMuted}>
        Ordinary prompts use the selected lane; there is no automatic mid-turn
        switch.
      </text>
      <text fg={theme.warning}>
        Tab cannot start research or design. Quit, then run lab --with-research
        or lab --with-design.
      </text>
      <box gap={0}>
        <text fg={theme.info}>
          <b>Build</b>
        </text>
        <text fg={theme.text}>
          /preview Local preview (Mac 3100/3101 for HTTP apps)
        </text>
        <text fg={theme.text}>
          /run-local Start the mounted project the Command Center way
        </text>
        <text fg={theme.text}>
          /ship Implement, test, and verify one outcome
        </text>
        <text fg={theme.text}>
          /parallel Launch 2-4 isolated managed outcomes
        </text>
        <text fg={theme.text}>
          /review Read-only security and quality review
        </text>
        <text fg={theme.text}>/eval Focused claim or agent evaluation</text>
        <text fg={theme.text}>/plan Read-only approach before edits</text>
      </box>
      <box gap={0}>
        <text fg={theme.info}>
          <b>Evidence</b>
        </text>
        <text fg={theme.text}>/research Source-linked decision research</text>
        <text fg={theme.text}>/recap Compact session handoff</text>
        <text fg={theme.text}>/cache-stats Usage and cache efficiency</text>
      </box>
      {packs.length > 0 && (
        <box gap={0}>
          <text fg={theme.info}>
            <b>Loaded packs</b>
          </text>
          {packs.flatMap((pack) =>
            pack.commands.map((command) => (
              <text key={`${pack.id}:${command}`} fg={theme.text}>
                /{command} · {pack.label}
              </text>
            ))
          )}
        </box>
      )}
      <box gap={0}>
        <text fg={theme.info}>
          <b>Help</b>
        </text>
        <text fg={theme.text}>/agents-help When to use which Tab agent</text>
        <text fg={theme.textMuted}>
          Mount: {mount} · {agentStripLine(ctx)}
        </text>
      </box>
      <text fg={theme.textMuted}>
        Esc closes · Ctrl+P opens every command · Ctrl+Shift+W this menu
      </text>
    </box>
  );
}

function AgentsHelp(props: { api: TuiPluginApi }) {
  const theme = props.api.theme.current;
  const ctx = mountContext(props.api);
  const packs = loadedPacks();

  return (
    <box width={78} padding={2} gap={1}>
      <text fg={theme.accent}>
        <b>When to use which agent</b>
      </text>
      <text fg={theme.textMuted}>{startupMountHint(ctx)}</text>
      <text fg={theme.text}>
        Choose a coding lane with Tab before the next ordinary prompt.
      </text>
      <text fg={theme.textMuted}>
        Lanes stay explicit; they do not switch models automatically mid-turn.
      </text>
      <box gap={0}>
        <text fg={theme.info}>
          <b>Coding lanes (any mount)</b>
        </text>
        <text fg={theme.text}>
          <b>fast</b> — GLM-4.7 Flash: small, bounded, low-risk changes
        </text>
        <text fg={theme.text}>
          <b>lab</b> — GPT-OSS 120B: everyday implementation
        </text>
        <text fg={theme.text}>
          <b>deep</b> — Kimi K2.7 Code: complex or high-risk implementation
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.info}>
          <b>Workflow agents (any mount)</b>
        </text>
        <text fg={theme.text}>plan — propose approach, no edits</text>
        <text fg={theme.text}>reviewer — read-only critique</text>
        <text fg={theme.text}>dispatcher — managed quality runs only</text>
        <text fg={theme.text}>research — evidence / hard public pages</text>
      </box>
      {packs.length > 0 && (
        <box gap={0}>
          <text fg={theme.info}>
            <b>Loaded pack agents</b>
          </text>
          {packs.map((pack) => (
            <text key={pack.id} fg={theme.text}>
              {pack.label}: {pack.agents.join(" / ") || "commands only"}
            </text>
          ))}
        </box>
      )}
      <text fg={theme.textMuted}>
        Typical: plan → fast/lab/deep → reviewer · /ship uses the managed router
      </text>
      <text fg={theme.textMuted}>Docs: docs/lab/when-to-use-agents.md</text>
      <text fg={theme.textMuted}>Esc closes</text>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "lab.workflow-menu",
        title: "Command Center: workflow menu",
        category: "Command Center",
        namespace: "palette",
        slashName: "workflow",
        run: () => {
          api.ui.dialog.setSize("medium");
          api.ui.dialog.replace(() => <WorkflowMenu api={api} />);
        }
      },
      {
        name: "lab.agents-help",
        title: "Command Center: when to use which agent",
        category: "Command Center",
        namespace: "palette",
        slashName: "agents-help",
        run: () => {
          api.ui.dialog.setSize("medium");
          api.ui.dialog.replace(() => <AgentsHelp api={api} />);
        }
      }
    ],
    bindings: [
      {
        key: "ctrl+shift+w",
        cmd: "lab.workflow-menu",
        desc: "Open Command Center workflow menu"
      },
      {
        key: "ctrl+shift+a",
        cmd: "lab.agents-help",
        desc: "When to use which agent"
      }
    ]
  });
};

const plugin: TuiPluginModule = { id: "lab.workflow-menu", tui };
export default plugin;
