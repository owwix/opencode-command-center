/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule
} from "@opencode-ai/plugin/tui";

type Evidence = { kind: string; target: string };
type RunView = {
  id: string;
  kind: string;
  project: { id: string; name: string; source: string };
  task: string;
  phase: string;
  state: string;
  model: string | null;
  reviewer: { models: string[] };
  elapsed: { milliseconds: number };
  cost: { available: boolean; amount: number | null; reason: string | null };
  approvals: { count: number; pending: Array<{ id: string; phase: string }> };
  verification: {
    passed: boolean | null;
    sha: string | null;
    evidence: Evidence[];
  };
  review: { passed: boolean | null; sha: string | null; evidence: Evidence[] };
  worktree: {
    path: string | null;
    branch: string | null;
    headSha: string | null;
    clean: boolean | null;
    evidence: Evidence[];
  };
  artifacts: {
    count: number;
    items: Evidence[];
    index: string | null;
    categories: Record<string, number>;
  };
  notifications: {
    unread: number;
    records: Array<{
      id: string;
      type: string;
      title: string;
      message: string;
    }>;
  };
  preview: { url: string | null; evidence: string | null };
  pullRequest: { url: string | null; evidence: string | null } | null;
  attempts: { used: number; maximum: number };
  actions: string[];
  evidence: { service: string; controller: string | null };
};

const ACTION_LABELS: Record<string, string> = {
  resume: "Resume",
  retry: "Retry",
  approve: "Approve pending action",
  reject: "Reject pending action",
  cancel: "Cancel",
  archive: "Archive",
  cleanup: "Clean up worktree",
  adopt: "Adopt verified commit",
  "prepare-pr": "Prepare pull request"
};

function gatewayHeaders() {
  const token = process.env.AGENT_GATEWAY_TOKEN;
  if (!token) throw new Error("This launch has no scoped gateway capability.");
  return { authorization: `Bearer ${token}` };
}

async function gatewayJson(path: string, options: RequestInit = {}) {
  const response = await fetch(`http://agent-gateway:8787${path}`, {
    ...options,
    headers: {
      ...gatewayHeaders(),
      ...(options.body ? { "content-type": "application/json" } : {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error ?? `Run service returned ${response.status}.`
    );
  }
  return payload;
}

function elapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function claim(
  value: boolean | null,
  sha: string | null,
  evidence: Evidence[]
) {
  if (value === null) return "not recorded";
  const status = value ? "passed" : "failed";
  const revision = sha ? ` @ ${sha.slice(0, 7)}` : "";
  return `${status}${revision} → ${evidence[0]?.target ?? "missing evidence"}`;
}

function short(value: string | null | undefined, maximum = 76) {
  if (!value) return "not available";
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`;
}

function RunDetails(props: { api: TuiPluginApi; run: RunView }) {
  const theme = props.api.theme.current;
  const run = props.run;
  return (
    <box width={92} padding={2} gap={1}>
      <text fg={theme.accent}>
        <b>
          {run.project.name} · {run.id}
        </b>
      </text>
      <text fg={theme.text}>{run.task}</text>
      <text fg={theme.info}>
        {run.state.toUpperCase()} · {run.phase} · {run.kind}
      </text>
      <text fg={theme.textMuted}>
        Model: {run.model ?? "not selected"} · Reviewer:{" "}
        {run.reviewer.models.join(", ") || "not selected"}
      </text>
      <text fg={theme.textMuted}>
        Elapsed: {elapsed(run.elapsed.milliseconds)} · Cost:{" "}
        {run.cost.available ? `$${run.cost.amount?.toFixed(4)}` : "unavailable"}{" "}
        · Attempts: {run.attempts.used}/{run.attempts.maximum}
      </text>
      <text fg={run.approvals.count ? theme.warning : theme.textMuted}>
        Approval:{" "}
        {run.approvals.count
          ? `${run.approvals.count} pending`
          : "none pending"}
      </text>
      <text fg={run.notifications.unread ? theme.warning : theme.textMuted}>
        Notifications: {run.notifications.unread} unread
      </text>
      <box gap={0}>
        <text fg={theme.text}>
          <b>Quality evidence</b>
        </text>
        <text fg={theme.textMuted}>
          Verification:{" "}
          {short(
            claim(
              run.verification.passed,
              run.verification.sha,
              run.verification.evidence
            )
          )}
        </text>
        <text fg={theme.textMuted}>
          Review:{" "}
          {short(claim(run.review.passed, run.review.sha, run.review.evidence))}
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.text}>
          <b>Outputs</b>
        </text>
        <text fg={theme.textMuted}>
          Worktree: {short(run.worktree.path)} ·{" "}
          {run.worktree.branch ?? "no branch"}
        </text>
        <text fg={theme.textMuted}>
          Artifacts: {run.artifacts.count} ·{" "}
          {short(run.artifacts.items[0]?.target)}
        </text>
        <text fg={theme.textMuted}>
          Artifact index: {short(run.artifacts.index)}
        </text>
        <text fg={theme.textMuted}>Preview: {short(run.preview.url)}</text>
        <text fg={theme.textMuted}>PR: {short(run.pullRequest?.url)}</text>
      </box>
      <text fg={theme.textMuted}>
        Controller evidence: {short(run.evidence.controller)}
      </text>
      <text fg={theme.textMuted}>Esc closes · /runs returns to operations</text>
    </box>
  );
}

async function operate(
  api: TuiPluginApi,
  run: RunView,
  action: string,
  approvalId: string | null = null
) {
  try {
    const result = await gatewayJson(
      `/quality/runs/${encodeURIComponent(run.id)}/actions/${action}`,
      {
        method: "POST",
        body: JSON.stringify(approvalId ? { approval_id: approvalId } : {})
      }
    );
    api.ui.dialog.clear();
    api.ui.toast({
      title: ACTION_LABELS[action] ?? action,
      message: result?.url ?? result?.state ?? `Run ${run.id} updated.`,
      variant:
        action === "reject" || action === "cancel" ? "warning" : "success",
      duration: 6000
    });
  } catch (error) {
    api.ui.toast({
      title: "Run action failed",
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
      duration: 7000
    });
  }
}

function confirmAction(
  api: TuiPluginApi,
  run: RunView,
  action: string,
  approvalId: string | null = null
) {
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<boolean>({
      title: `${ACTION_LABELS[action] ?? action} ${run.id}?`,
      current: false,
      options: [
        {
          title: "Cancel",
          value: false,
          description: "Return without changing the run"
        },
        {
          title: ACTION_LABELS[action] ?? action,
          value: true,
          description: `Apply the ${action} action to this run`
        }
      ],
      onSelect(option) {
        if (!option.value) return openRunMenu(api, run);
        void operate(api, run, action, approvalId);
      }
    })
  );
}

function openRunMenu(api: TuiPluginApi, run: RunView) {
  const actionOptions = run.actions.flatMap((action) => {
    if (!["approve", "reject"].includes(action)) {
      return [{ action, approvalId: null }];
    }
    return run.approvals.pending.map((approval) => ({
      action,
      approvalId: approval.id
    }));
  });
  const options = [
    {
      title: "View evidence and outputs",
      value: "view",
      description: `${run.state} · ${run.phase} · ${elapsed(run.elapsed.milliseconds)}`
    },
    ...actionOptions.map(({ action, approvalId }) => ({
      title: `${ACTION_LABELS[action] ?? action}${approvalId ? ` · ${approvalId}` : ""}`,
      value: approvalId ? `${action}|${approvalId}` : action,
      description: approvalId
        ? `Pending ${run.approvals.pending.find((item) => item.id === approvalId)?.phase ?? "approval"}`
        : `Operate ${run.id}`
    }))
  ];
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: `${run.project.name} · ${run.id}`,
      current: "view",
      options,
      onSelect(option) {
        if (option.value === "view") {
          api.ui.dialog.replace(() => <RunDetails api={api} run={run} />);
          return;
        }
        const [action, approvalId = null] = option.value.split("|");
        confirmAction(api, run, action, approvalId);
      }
    })
  );
}

async function openRunCenter(api: TuiPluginApi) {
  try {
    const payload = await gatewayJson("/quality/runs");
    const runs = (payload?.runs ?? []) as RunView[];
    if (!runs.length) {
      api.ui.toast({
        title: "Managed runs",
        message:
          "No runs exist for this project yet. Start one with /ship or /parallel.",
        variant: "info",
        duration: 6000
      });
      return;
    }
    api.ui.dialog.setSize("large");
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect<RunView>({
        title: "Managed runs",
        current: runs[0],
        options: runs.map((run) => ({
          title: `${run.state.toUpperCase()} · ${run.id}`,
          value: run,
          description: `${run.project.name} · ${run.phase} · ${run.task}`
        })),
        onSelect(option) {
          openRunMenu(api, option.value);
        }
      })
    );
  } catch (error) {
    api.ui.toast({
      title: "Managed runs unavailable",
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
      duration: 7000
    });
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "lab.run-center",
        title: "Command Center: managed run control center",
        category: "Command Center",
        namespace: "palette",
        slashName: "runs",
        run: () => void openRunCenter(api)
      }
    ],
    bindings: [
      {
        key: "ctrl+shift+r",
        cmd: "lab.run-center",
        desc: "Open managed runs"
      }
    ]
  });
};

const plugin: TuiPluginModule = { id: "lab.run-center", tui };
export default plugin;
