# Agent quality in OpenCode Command Center

OpenCode Command Center is a local, Docker-isolated harness for coding work. It provides
predictable execution boundaries and evidence; it does not promise that an
agent is correct without verification.

Repository verification also includes `npm run quality:modules`, which keeps
production modules at or below 700 physical lines. When a change reaches that
boundary, split by responsibility while preserving the CLI/protocol contract;
do not increase the budget to avoid the refactor.

## Start the right session

Run `lab` from anywhere to choose a workspace, or pass one directly:

```bash
occtl open "$HOME/Projects/example"
```

The default launch is the fast coding profile. It starts the gateway and
OpenCode only. Hound research and OpenDesign are deliberately optional:

```bash
lab --with-research
lab --with-design
lab --full-tools
```

Tab selects the next coding lane; it cannot start a research or design service
in the current session. Quit and relaunch with `lab --with-research` or
`lab --with-design` first.

The host registry allows one foreground interactive workspace. A second launch
must explicitly resume the active project or stop its verified Command Center launcher.
Background managed runs receive separate launch registrations and Compose
projects, so they do not replace foreground ownership. Quality maps the
container path `/workspace` only from the current short-lived registration
token; there is no global current-workspace pointer.

The launcher runs the project contract preflight before Docker. A clean Git
baseline plus at least one supported verification command enables managed
runs; missing Git or verification remains an explicit interactive-only warning,
while unsupported declared runtimes fail before launch.

`lab --setup` and `npm run doctor` print the same launch snapshot: the stable
`opencode-lab-*` volumes, default profile, runtime-config writability, pinned
OpenCode/OpenDesign sources, and whether the local OpenCode image needs
`lab --rebuild`. Doctor only inspects; it never builds.

## Lanes and agents

Use one coding lane per ordinary prompt:

- `fast` uses GLM-4.7 Flash for small, bounded, low-risk edits.
- `lab` uses GPT-OSS 120B for routine implementation.
- `deep` uses Kimi K2.7 Code for complex or high-risk changes.

The model is fixed for the current prompt or managed task. There is no hidden
mid-task routing. The sidebar and `/cache-stats` show cost accumulated by the
fast, lab, and deep lanes.

Use `/workflow` for the command map and `/agents-help` for agent selection.
Those commands are Command Center-wide. Product-specific commands are shown only when a
versioned external pack contributes them.

## Managed work

`/ship`, `/research`, `/review`, `/eval`, and `/parallel` submit bounded work
through the quality controller. Managed runs use separate Git worktrees and
persist records under the host-owned Command Center state root (on macOS,
`~/Library/Application Support/OpenCode Lab/state/runs`). Verify the resulting
worktree before adopting changes; parallel runs do not merge themselves.

Foreground, detached, parallel, and fleet work share one durable run service.
Each run has a versioned service record, bounded attempt history, worker lease
and heartbeat, parent/member links, exact Git recovery ref, and idempotent
external-action receipts. Startup reconciliation converts expired workers into
a retryable queued state until their attempt budget is exhausted. Legacy
background and fleet JSON records migrate non-destructively the first time the
service sees them.

Failed work is preserved. Command Center retains its isolated worktree and
`refs/opencode-lab/runs/<run-id>` recovery ref, and cleanup refuses dirty or
unpublished changes. Adopt the verified commit or prepare its PR before asking
Command Center to remove the worktree. Archiving changes visibility, not ownership of
unpublished source.

Use `/runs` (or `Ctrl+Shift+R`) as the operator surface. It lists only runs
owned by the launch registration's project and exposes project/task,
phase/state, implementation and reviewer models, elapsed time, observed cost,
pending approvals, verification, review, worktree, artifacts, preview, and PR.
Select a run to view its evidence or choose a state-valid action: resume,
bounded retry, approve, reject, cancel, archive, cleanup, adopt, or prepare PR.
Every modifying selection asks for confirmation. Adoption and PR creation use
the controller's verified-SHA checks and durable idempotency receipts; reopening
the TUI recognizes a live worker heartbeat instead of starting a duplicate.

Every run also owns one `artifacts.json` index under the host state root. The
index links verification evidence, review logs, an exact implementation patch,
research deliverables, images, browser captures, previews, and PR receipts to
the run's project ID and implementation SHA. `/runs` shows the index and unread
notification count, while `/quality/runs/<id>/artifacts` and
`/quality/notifications` expose the same project-scoped data through the
read-only quality capability.

Approval-required, blocked, failed, passed, artifact-ready, and PR-ready
notifications use durable deduplication keys, so reopening the TUI or restarting
the helper does not emit the same event again. `QUALITY_ARTIFACT_RETENTION_DAYS`
configures retention. `npm run quality:retention -- --run <id> --days <n>` can
remove only an expired Command Center-owned `artifact-cache` copy; it never removes source
worktree artifacts or evidence metadata and refuses all deletion while a run has
unpublished changes.

The control center never reads `.quality` files from the mounted project. It
uses the scoped `quality:read` and `quality:operate` gateway actions, which are
present only in a foreground launch lease. The host Quality service validates
the launch registration and filters every run against its canonical project
path before returning status or accepting an operation.

The controller preserves authority boundaries: research gathers evidence,
review is read-only, and publishing/deployment remain explicit operator actions.
Credentials remain in the gateway or ignored local environment file rather than
in the OpenCode workspace. OpenCode has no unrestricted egress: models,
research, design, browser control, previews, publishing, and allowlisted HTTPS
artifacts cross authenticated fixed-purpose relays. Every artifact redirect is
re-resolved and pinned to a public IP before download.

## Verification standard

For every changed outcome, establish three things:

1. The intended source change is present in the selected worktree.
2. Relevant deterministic checks passed, or a concrete blocker is recorded.
3. Any claim about a visual, external system, or release has inspectable
   evidence rather than an unsupported agent assertion.

Run the project’s narrowest useful checks first, then its normal CI-equivalent
check before release. Use `npm run doctor` when launch state is suspect; use
`npm run quality:test` when changing the harness itself.

## Disk and recovery

Runtime state uses project-scoped named
`opencode-lab-project_<id>-*` volumes so it survives a restart without sharing
configuration, caches, sessions, or optional-service state with another
project. Host-side registry, logs, transient runtime configuration, and approval
preferences also live outside mounted repositories. Command Center uses `.git/info/exclude`
only for unavoidable compatibility paths and never edits a project's
`.gitignore`.
Inspect legacy volumes safely with:

```bash
occtl prune
```

It reports only recognized legacy `opencode-lab-*` volume names and ignores unrelated Docker
volumes. Nothing is deleted unless the exact follow-up command is supplied:

```bash
occtl prune --apply
```

The command does not stop containers or delete workspaces. If Docker rejects a
volume because it is in use, stop or inspect that specific old service first.
