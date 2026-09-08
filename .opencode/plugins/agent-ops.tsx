/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule
} from "@opencode-ai/plugin/tui";
import {
  STATE_PRESENTATION,
  currentAgent,
  deriveSessionState,
  inferLayout,
  inferTaskType,
  isAutoApprovable,
  isSafePermission,
  layoutChecklist,
  qualitySnapshot
} from "./agent-ops-lib.mjs";
import {
  agentStripLine,
  resolveMountName,
  startupMountHint
} from "./lab-ui-lib.mjs";
import { readFileSync } from "node:fs";
import { createSignal } from "solid-js";
import {
  createDebouncedTask,
  createSessionViewCache,
  eventSessionID,
  subscribeSessionCache
} from "./session-view-cache.mjs";

type Layout = "auto" | "build" | "research";
type AgentState = keyof typeof STATE_PRESENTATION;
type PetReaction =
  | "thinking"
  | "editing"
  | "testing"
  | "waiting"
  | "success"
  | "error";

let lastPetState = "";

const STICKY_AUTO_PATH =
  "/home/opencode/.config/opencode/lab-user/preferences.json";
const MAX_AUTO_REPLY_ATTEMPTS = 3;
type ApprovalMode = "ask" | "safe-auto" | "broad-auto";
type StickyPreferences = { approvalMode: ApprovalMode };

function readStickyPreferences(): StickyPreferences {
  try {
    const raw = readFileSync(STICKY_AUTO_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const approvalMode = ["ask", "safe-auto", "broad-auto"].includes(
      parsed?.approvalMode
    )
      ? parsed.approvalMode
      : parsed?.autoApprove === true
        ? "broad-auto"
        : parsed?.autoApprove === false
          ? "ask"
          : "safe-auto";
    return { approvalMode };
  } catch {
    return { approvalMode: "safe-auto" };
  }
}

async function autoReplyPendingPermissions(
  api: TuiPluginApi,
  preferences: StickyPreferences,
  attempts: Map<string, number>
): Promise<boolean> {
  if (preferences.approvalMode === "ask") return false;
  const id = sessionID(api);
  if (!id) return false;
  const pending = api.state.session.permission(id) as any[];
  let shouldRetry = false;
  for (const request of pending) {
    if (!isAutoApprovable(request, preferences.approvalMode)) continue;
    const count = attempts.get(request.id) ?? 0;
    if (count >= MAX_AUTO_REPLY_ATTEMPTS) continue;
    attempts.set(request.id, count + 1);
    try {
      await api.client.permission.reply(
        {
          requestID: request.id,
          directory: api.state.path.directory,
          reply: "once"
        },
        { throwOnError: true }
      );
      attempts.delete(request.id);
    } catch {
      // Retry a bounded number of times; the manual permission UI remains available.
      shouldRetry = true;
    }
  }
  return shouldRetry;
}

function selectedLayout(api: TuiPluginApi): Layout {
  const value = api.kv.get<Layout>("lab.agent-ops.layout", "auto");
  return ["auto", "build", "research"].includes(value) ? value : "auto";
}

function compactModel(
  api: TuiPluginApi,
  cache: any,
  sessionID: string
): string {
  const session = api.state.session.get(sessionID);
  const latest = cache.get(api, sessionID).latestAssistant;
  const providerID = latest?.providerID ?? session?.model?.providerID;
  const modelID = latest?.modelID ?? session?.model?.id;
  const model = api.state.provider.find((item) => item.id === providerID)
    ?.models?.[modelID];
  return model?.name ?? String(modelID ?? "No model").replace(/^.*\//u, "");
}

function sessionCost(api: TuiPluginApi, cache: any, sessionID: string): number {
  const session = api.state.session.get(sessionID);
  if (typeof session?.cost === "number") return session.cost;
  return cache.get(api, sessionID).totals.cost;
}

function stateColor(api: TuiPluginApi, state: AgentState) {
  const theme = api.theme.current;
  switch (STATE_PRESENTATION[state]?.color) {
    case "info":
      return theme.info;
    case "warning":
      return theme.warning;
    case "accent":
      return theme.accent;
    case "error":
      return theme.error;
    default:
      return theme.success;
  }
}

function snapshot(api: TuiPluginApi, cache: any, sessionID: string) {
  return cache.quality(api, sessionID, qualitySnapshot);
}

function Header(props: { api: TuiPluginApi; cache: any; sessionID: string }) {
  props.cache.revision();
  const session = props.api.state.session.get(props.sessionID);
  const messages = props.cache.recentMessages(props.api, props.sessionID);
  const agent = currentAgent(session, messages);
  const pending = props.api.state.session.permission(props.sessionID);
  const state = deriveSessionState({
    status: props.api.state.session.status(props.sessionID),
    pendingPermissions: pending,
    agent,
    messages
  }) as AgentState;
  const presentation = STATE_PRESENTATION[state];
  const task = inferTaskType(agent);
  const mountCtx = {
    directory: props.api.state.path.directory,
    workspaceName: process.env.OPENCODE_WORKSPACE_NAME
  };

  return (
    <box gap={0} paddingBottom={1}>
      <text fg={stateColor(props.api, state)}>
        <b>● {presentation.label}</b> · {task} · {String(agent)}
      </text>
      <text fg={props.api.theme.current.textMuted}>
        {resolveMountName(mountCtx)} · {agentStripLine(mountCtx)}
      </text>
      <text fg={props.api.theme.current.textMuted}>
        {compactModel(props.api, props.cache, props.sessionID)} · $
        {sessionCost(props.api, props.cache, props.sessionID).toFixed(3)} ·{" "}
        {pending.length}
        {" approval"}
        {pending.length === 1 ? "" : "s"}
      </text>
    </box>
  );
}

function QualitySidebar(props: {
  api: TuiPluginApi;
  cache: any;
  sessionID: string;
}) {
  props.cache.revision();
  const session = props.api.state.session.get(props.sessionID);
  const messages = props.cache.recentMessages(props.api, props.sessionID);
  const agent = currentAgent(session, messages);
  const layout = inferLayout(agent, selectedLayout(props.api));
  const result = snapshot(props.api, props.cache, props.sessionID);
  const diff = props.api.state.session.diff(props.sessionID);
  const pending = props.api.state.session.permission(props.sessionID);
  const scoreColor =
    result.score >= 80
      ? props.api.theme.current.success
      : result.score >= 50
        ? props.api.theme.current.warning
        : props.api.theme.current.textMuted;

  return (
    <box gap={0} paddingTop={1}>
      <text fg={props.api.theme.current.text}>
        <b>{layout.toUpperCase()} WORKSPACE</b>
      </text>
      <text fg={scoreColor}>Quality readiness {result.score}/100</text>
      <text fg={props.api.theme.current.textMuted}>
        Verify: {result.verification}
      </text>
      <text fg={props.api.theme.current.textMuted}>
        Review: {result.review}
      </text>
      <text fg={props.api.theme.current.textMuted}>
        {diff.length} changed file{diff.length === 1 ? "" : "s"} ·{" "}
        {result.toolErrors}
        {" tool error"}
        {result.toolErrors === 1 ? "" : "s"}
      </text>
      {pending.length > 0 ? (
        <text fg={props.api.theme.current.warning}>
          Alt+A approve safe once · Alt+R reject
        </text>
      ) : (
        <text fg={props.api.theme.current.textMuted}>
          /quality for evidence · /agents-help for Tab agents · /layout to focus
        </text>
      )}
    </box>
  );
}

function QualityDialog(props: {
  api: TuiPluginApi;
  cache: any;
  sessionID: string;
}) {
  props.cache.revision();
  const session = props.api.state.session.get(props.sessionID);
  const messages = props.cache.recentMessages(props.api, props.sessionID);
  const agent = currentAgent(session, messages);
  const layout = inferLayout(agent, selectedLayout(props.api));
  const result = snapshot(props.api, props.cache, props.sessionID);
  const checklist = layoutChecklist(layout);
  const theme = props.api.theme.current;

  return (
    <box width={68} padding={2} gap={1}>
      <text fg={theme.accent}>
        <b>Command Center quality desk</b>
      </text>
      <text fg={theme.text}>
        Evidence readiness <b>{result.score}/100</b>
      </text>
      <text fg={theme.text}>Verification: {result.verification}</text>
      <text fg={theme.text}>Independent review: {result.review}</text>
      {result.managedState ? (
        <text fg={theme.info}>Managed run: {result.managedState}</text>
      ) : (
        <text fg={theme.textMuted}>No managed-run status captured yet.</text>
      )}
      <box gap={0}>
        <text fg={theme.info}>
          <b>{layout[0].toUpperCase() + layout.slice(1)} evidence</b>
        </text>
        {checklist.map((item) => (
          <text fg={theme.textMuted}>□ {item}</text>
        ))}
      </box>
      <text fg={theme.textMuted}>
        This is an evidence-readiness score, not release approval. Esc closes.
      </text>
    </box>
  );
}

function sessionID(api: TuiPluginApi): string | undefined {
  if (api.route.current.name !== "session") return undefined;
  const value = api.route.current.params?.sessionID;
  return typeof value === "string" ? value : undefined;
}

function petEnabled(api: TuiPluginApi) {
  return api.kv.get<boolean>("lab.openpets.enabled", true) !== false;
}

function reactionForState(state: AgentState): PetReaction {
  switch (state) {
    case "researching":
      return "thinking";
    case "editing":
      return "editing";
    case "reviewing":
      return "testing";
    case "blocked":
      return "waiting";
    case "complete":
      return "success";
  }
}

function reportPetState(api: TuiPluginApi, cache: any) {
  if (!petEnabled(api)) return;
  const id = sessionID(api);
  if (!id) return;
  const session = api.state.session.get(id);
  const messages = cache.recentMessages(api, id);
  const state = deriveSessionState({
    status: api.state.session.status(id),
    pendingPermissions: api.state.session.permission(id),
    agent: currentAgent(session, messages),
    messages
  }) as AgentState;
  const petStateKey = `${id}:${state}`;
  if (petStateKey === lastPetState) return;
  lastPetState = petStateKey;
  const token = process.env.AGENT_GATEWAY_TOKEN;
  if (!token) return;
  void fetch("http://agent-gateway:8787/openpets/react", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ reaction: reactionForState(state) })
  }).catch(() => {
    // The pet is entirely optional and must never affect an agent run.
  });
}

function togglePet(api: TuiPluginApi, cache: any) {
  const enabled = !petEnabled(api);
  api.kv.set("lab.openpets.enabled", enabled);
  lastPetState = "";
  api.ui.toast({
    message: enabled
      ? "Desktop pet reactions enabled."
      : "Desktop pet reactions paused.",
    variant: enabled ? "success" : "info"
  });
  if (enabled) reportPetState(api, cache);
}

async function answerPermission(api: TuiPluginApi, reply: "once" | "reject") {
  const id = sessionID(api);
  if (!id) {
    api.ui.toast({ message: "Open a session first.", variant: "warning" });
    return;
  }
  const request = api.state.session.permission(id)[0];
  if (!request) {
    api.ui.toast({ message: "No permission is waiting.", variant: "info" });
    return;
  }
  if (reply === "once" && !isSafePermission(request)) {
    api.ui.toast({
      title: "Use the full approval screen",
      message: `${request.permission} is outside the safe shortcut allowlist.`,
      variant: "warning",
      duration: 5000
    });
    return;
  }
  try {
    await api.client.permission.reply(
      {
        requestID: request.id,
        directory: api.state.path.directory,
        reply
      },
      { throwOnError: true }
    );
    api.ui.toast({
      message:
        reply === "once"
          ? `Approved ${request.permission} once.`
          : `Rejected ${request.permission}.`,
      variant: reply === "once" ? "success" : "warning"
    });
  } catch (error) {
    api.ui.toast({
      message: `Could not answer permission: ${error instanceof Error ? error.message : "unknown error"}`,
      variant: "error"
    });
  }
}

function openLayoutDialog(api: TuiPluginApi) {
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<Layout>({
      title: "Command Center workspace layout",
      current: selectedLayout(api),
      options: [
        {
          title: "Automatic",
          value: "auto",
          description: "Follow the active agent role"
        },
        {
          title: "Build",
          value: "build",
          description: "Diff, tests, review, and handoff"
        },
        {
          title: "Research",
          value: "research",
          description: "Sources, synthesis, uncertainty, and publishing"
        }
      ],
      onSelect(option) {
        api.kv.set("lab.agent-ops.layout", option.value);
        api.ui.dialog.clear();
        api.ui.toast({
          message: `Workspace layout set to ${option.title}.`,
          variant: "success"
        });
      }
    })
  );
}

const tui: TuiPlugin = async (api) => {
  const cache = createSessionViewCache();
  const [cacheRevision, setCacheRevision] = createSignal(0);
  (cache as any).revision = cacheRevision;
  const preferences = readStickyPreferences();
  const autoReplyAttempts = new Map<string, number>();
  let autoRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const petUpdate = createDebouncedTask(() => reportPetState(api, cache), 150);
  const autoReply = createDebouncedTask(async () => {
    const retry = await autoReplyPendingPermissions(
      api,
      preferences,
      autoReplyAttempts
    );
    if (!retry) return;
    if (autoRetryTimer) clearTimeout(autoRetryTimer);
    autoRetryTimer = setTimeout(() => autoReply.trigger(), 750);
  }, 50);
  const activeSessionEvent = (
    event: any,
    change: { changed: boolean } = { changed: true }
  ) => {
    if (!change.changed) return;
    const active = sessionID(api);
    const affected = eventSessionID(event);
    if (!affected || affected === active) {
      setCacheRevision((revision) => revision + 1);
      petUpdate.trigger();
    }
  };
  const unsubscribeCache = subscribeSessionCache(api, cache, {
    includeToolParts: true,
    onEvent: activeSessionEvent
  });
  const unsubscribeStatus = api.event.on("session.status", activeSessionEvent);
  const unsubscribePermission = api.event.on("permission.asked", (event) => {
    activeSessionEvent(event);
    autoReply.trigger();
  });
  const unsubscribePermissionReply = api.event.on(
    "permission.replied",
    (event) => {
      autoReplyAttempts.delete(event.properties.requestID);
      activeSessionEvent(event);
    }
  );

  api.slots.register({
    order: 40,
    slots: {
      sidebar_title(_context: unknown, props: { session_id: string }) {
        return <Header api={api} cache={cache} sessionID={props.session_id} />;
      },
      sidebar_content(_context: unknown, props: { session_id: string }) {
        return (
          <QualitySidebar
            api={api}
            cache={cache}
            sessionID={props.session_id}
          />
        );
      }
    }
  });

  api.keymap.registerLayer({
    commands: [
      {
        name: "lab.quality-desk",
        title: "Command Center: quality and verification desk",
        category: "Command Center",
        namespace: "palette",
        slashName: "quality",
        run: () => {
          const id = sessionID(api);
          if (!id) {
            api.ui.toast({
              message: "Open a session first.",
              variant: "warning"
            });
            return;
          }
          api.ui.dialog.setSize("medium");
          api.ui.dialog.replace(() => (
            <QualityDialog api={api} cache={cache} sessionID={id} />
          ));
        }
      },
      {
        name: "lab.workspace-layout",
        title: "Command Center: choose workspace layout",
        category: "Command Center",
        namespace: "palette",
        slashName: "layout",
        run: () => openLayoutDialog(api)
      },
      {
        name: "lab.permission-approve-safe",
        title: "Command Center: approve safe request once",
        category: "Command Center",
        namespace: "palette",
        run: () => answerPermission(api, "once")
      },
      {
        name: "lab.permission-reject",
        title: "Command Center: reject pending request",
        category: "Command Center",
        namespace: "palette",
        run: () => answerPermission(api, "reject")
      },
      {
        name: "lab.openpets-toggle",
        title: "Command Center: toggle desktop pet reactions",
        category: "Command Center",
        namespace: "palette",
        slashName: "pet",
        run: () => togglePet(api, cache)
      }
    ],
    bindings: [
      {
        key: "alt+a",
        cmd: "lab.permission-approve-safe",
        desc: "Approve a safe request once"
      },
      {
        key: "alt+r",
        cmd: "lab.permission-reject",
        desc: "Reject the pending request"
      },
      {
        key: "<leader>p",
        cmd: "lab.openpets-toggle",
        desc: "Toggle desktop pet"
      }
    ]
  });

  petUpdate.trigger();
  autoReply.trigger();

  const hintKey = "lab.mount_hint_shown";
  if (api.kv.get<boolean>(hintKey, false) !== true) {
    api.kv.set(hintKey, true);
    api.ui.toast({
      title: "OpenCode Command Center",
      message: startupMountHint({
        directory: api.state.path.directory,
        workspaceName: process.env.OPENCODE_WORKSPACE_NAME
      }),
      variant: "info",
      duration: 8000
    });
  }

  api.lifecycle.onDispose(() => {
    unsubscribePermissionReply();
    unsubscribePermission();
    unsubscribeStatus();
    unsubscribeCache();
    petUpdate.cancel();
    autoReply.cancel();
    if (autoRetryTimer) clearTimeout(autoRetryTimer);
    autoReplyAttempts.clear();
    cache.clear();
  });
};

const plugin: TuiPluginModule = { id: "lab.agent-ops", tui };
export default plugin;
