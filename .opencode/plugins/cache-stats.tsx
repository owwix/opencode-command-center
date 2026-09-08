/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule
} from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";
import {
  createSessionViewCache,
  subscribeSessionCache
} from "./session-view-cache.mjs";

type Totals = {
  requests: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costByLane: { fast: number; lab: number; deep: number };
};

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function workspaceName(): string {
  return process.env.OPENCODE_WORKSPACE_NAME?.trim() || "Workspace";
}

function Sidebar(props: { api: TuiPluginApi; cache: any; sessionID: string }) {
  props.cache.revision();
  const theme = props.api.theme.current;
  const view = props.cache.get(props.api, props.sessionID);
  const totals = view.totals as Totals;
  const message = view.latestAssistant;
  const tokens = message?.tokens;
  const used =
    number(tokens?.input) +
    number(tokens?.output) +
    number(tokens?.reasoning) +
    number(tokens?.cache?.read) +
    number(tokens?.cache?.write);
  const providerID = message?.providerID;
  const modelID = message?.modelID;
  const model = props.api.state.provider.find((item) => item.id === providerID)
    ?.models?.[modelID];
  const limit = number(model?.limit?.context);
  const percent =
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color =
    percent >= 85 ? theme.error : percent >= 65 ? theme.warning : theme.success;

  return (
    <box gap={0}>
      <text fg={theme.text}>
        <b>{workspaceName()}</b>
      </text>
      <text fg={color}>Context {percent}%</text>
      <text fg={theme.textMuted}>
        {format(
          totals.input + totals.output + totals.reasoning + totals.cacheWrite
        )}{" "}
        tokens · ${totals.cost.toFixed(3)}
      </text>
      <text fg={theme.textMuted}>/cache-stats for details</text>
    </box>
  );
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function View(props: { api: TuiPluginApi; totals: Totals }) {
  const theme = props.api.theme.current;
  const denominator = props.totals.input + props.totals.cacheRead;
  const hitRate =
    denominator > 0 ? (props.totals.cacheRead / denominator) * 100 : 0;
  const spent =
    props.totals.input +
    props.totals.output +
    props.totals.reasoning +
    props.totals.cacheWrite;

  return (
    <box width={54} padding={2} gap={1}>
      <text fg={theme.accent}>
        <b>{workspaceName()} usage</b>
      </text>
      <text fg={theme.textMuted}>Cache efficiency</text>
      <text
        fg={
          hitRate >= 70
            ? theme.success
            : hitRate >= 40
              ? theme.warning
              : theme.error
        }
      >
        <b>{hitRate.toFixed(1)}%</b>
      </text>
      <text fg={theme.text}>Requests {format(props.totals.requests)}</text>
      <text fg={theme.text}>Fresh tokens {format(spent)}</text>
      <text fg={theme.text}>
        Cached tokens {format(props.totals.cacheRead)}
      </text>
      <text fg={theme.text}>Session cost ${props.totals.cost.toFixed(4)}</text>
      <text fg={theme.text}>
        Lanes: fast ${props.totals.costByLane.fast.toFixed(4)} · lab $
        {props.totals.costByLane.lab.toFixed(4)} · deep $
        {props.totals.costByLane.deep.toFixed(4)}
      </text>
      <text fg={theme.textMuted}>esc to close</text>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const cache = createSessionViewCache();
  const [cacheRevision, setCacheRevision] = createSignal(0);
  (cache as any).revision = cacheRevision;
  const unsubscribeCache = subscribeSessionCache(api, cache, {
    onEvent(_event, change) {
      if (change.changed) setCacheRevision((revision) => revision + 1);
    }
  });
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_context, props) {
        return <Sidebar api={api} cache={cache} sessionID={props.session_id} />;
      }
    }
  });

  api.keymap.registerLayer({
    commands: [
      {
        name: "lab.cache-stats",
        title: "Command Center: usage and cache stats",
        category: "Command Center",
        namespace: "palette",
        slashName: "cache-stats",
        run: () => {
          const route = api.route.current;
          const sessionID =
            route.name === "session" ? route.params?.sessionID : undefined;
          if (!sessionID) {
            api.ui.toast({
              message: "Open a session first.",
              variant: "warning"
            });
            return;
          }
          const totals = cache.get(api, sessionID).totals as Totals;
          api.ui.dialog.setSize("medium");
          api.ui.dialog.replace(() => <View api={api} totals={totals} />);
        }
      }
    ]
  });
  api.lifecycle.onDispose(() => {
    unsubscribeCache();
    cache.clear();
  });
};

const plugin: TuiPluginModule = { id: "lab.cache-stats", tui };
export default plugin;
