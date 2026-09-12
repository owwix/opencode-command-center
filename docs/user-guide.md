# OpenCode Command Center — User Guide

This guide explains how to use **OpenCode Command Center** (also called **Lab** in
compatibility aliases) as an operator: what it is, how it differs from stock
OpenCode, and how to use its features day to day.

For a hands-on walkthrough, start with the [first-project tutorial](tutorial.md).
For every flag and environment variable, see the [CLI reference](cli-reference.md).

---

## Table of contents

1. [What Command Center is](#what-command-center-is)
2. [How it differs from stock OpenCode](#how-it-differs-from-stock-opencode)
3. [Requirements and first-time setup](#requirements-and-first-time-setup)
4. [Opening and managing projects](#opening-and-managing-projects)
5. [The interactive TUI](#the-interactive-tui)
6. [Coding lanes and workflow agents](#coding-lanes-and-workflow-agents)
7. [Slash commands](#slash-commands)
8. [Local preview on your Mac](#local-preview-on-your-mac)
9. [Tool profiles: research and design](#tool-profiles-research-and-design)
10. [Managed runs: ship, parallel, and /runs](#managed-runs-ship-parallel-and-runs)
11. [Checkpoints, rewind, and session hygiene](#checkpoints-rewind-and-session-hygiene)
12. [Project skills, agents, and packs](#project-skills-agents-and-packs)
13. [Safety, approvals, and trust boundaries](#safety-approvals-and-trust-boundaries)
14. [Browser, gallery, and visual review](#browser-gallery-and-visual-review)
15. [Where state lives](#where-state-lives)
16. [Troubleshooting](#troubleshooting)
17. [Further reading](#further-reading)

---

## What Command Center is

OpenCode Command Center is an **independent control plane** around
[OpenCode](https://opencode.ai). You point it at a Git project on your Mac; it
starts a **Docker-isolated** OpenCode session where an AI agent can read and edit
that project under explicit safety rules.

You interact through the familiar OpenCode **terminal UI (TUI)**. Command Center
adds:

- **Isolation** — agents run in containers without direct access to your API keys
  or the open internet
- **Fixed preview ports** — local apps inside the container appear on your Mac at
  `http://127.0.0.1:3100` and `3101`
- **Coding lanes** — choose speed vs depth before each prompt (`fast`, `lab`, `deep`)
- **Workflow commands** — `/plan`, `/ship`, `/review`, `/preview`, and more
- **Managed runs** — isolated implementation with verification, review, and evidence
- **Safety policy** — scoped git, recoverable deletes, audited tool use

Command Center is **not** affiliated with the upstream OpenCode project. It is a
separate harness that wraps OpenCode.

---

## How it differs from stock OpenCode

| Topic               | Stock OpenCode              | Command Center                                                      |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| **Install**         | OpenCode CLI on the host    | `occtl` / `lab` launcher + Docker                                   |
| **Credentials**     | Often in local env / config | Real keys stay in a **gateway**; the agent gets a short-lived lease |
| **Network**         | Direct provider access      | No general egress; **fixed-purpose relays** only                    |
| **Default agent**   | Project-defined             | **`lab`** (GPT-OSS 120B) unless you Tab to another lane             |
| **Local preview**   | You choose ports            | Container `:3000`/`:3001` → Mac **`3100`/`3101`**                   |
| **State**           | Local OpenCode dirs         | Host-owned under `~/Library/Application Support/OpenCode Lab/`      |
| **Heavy workflows** | Ad hoc                      | **`/ship`** managed runs with worktrees, verify, review             |
| **Deletion / git**  | Shell as configured         | **`safe-remove.mjs`**, **`safe-git.mjs`**, tool lifecycle plugin    |

Use **Command Center** (`lab` / `occtl open`) for product work on mounted repos.
Do not run stock host `opencode` against the same workflow unless you intentionally
want the un-harnessed experience.

---

## Requirements and first-time setup

### Requirements

- **macOS** (primary supported host)
- **Docker Desktop** running
- **Node.js 24** (`nvm use` reads `.nvmrc`)
- **Cloudflare Workers Paid** (for default Kimi / Workers AI models), or configure
  alternate providers in `opencode.env`

### One-time setup

```bash
git clone https://github.com/owwix/opencode-lab.git
cd opencode-lab
nvm use
npm ci
cp opencode.env.example opencode.env
```

Edit **`opencode.env`** (gitignored) and set at minimum:

```text
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_API_TOKEN=<scoped-workers-ai-token>
```

Optional: OpenAI, Vertex, GitHub, and other provider keys — see
`opencode.env.example`.

Install the global launcher and run setup:

```bash
npm link
lab --setup          # or: occtl --setup
occtl doctor         # host + Docker sanity check
```

`--setup` checks Node, Docker, creates/permissions `opencode.env`, validates
Cloudflare vars, and records a launch snapshot. It does **not** build Docker images
(doctor warns if images are stale; use `--rebuild` on open when needed).

### Optional: project contract

Projects can declare how to install, verify, and preview in
**`.opencode-lab/project.json`**. Preview and approve:

```bash
occtl init /path/to/your-project
occtl init /path/to/your-project --yes   # after reviewing output
```

See [Project contract](project-contract.md).

---

## Opening and managing projects

### Primary commands

| Command                            | What it does                                          |
| ---------------------------------- | ----------------------------------------------------- |
| `occtl open [path]`                | Open project in the TUI (workspace picker if no path) |
| `occtl new [path]`                 | Create empty directory, then open                     |
| `occtl recent`                     | List recent projects (`--json` for scripts)           |
| `occtl resume [index\|name\|path]` | Reopen a recent project                               |
| `occtl status`                     | Foreground launch + background runs                   |
| `occtl stop`                       | Stop the registered foreground launcher               |
| `occtl doctor [path]`              | Diagnose host, Docker, project preflight              |
| `occtl verify [path]`              | Run the project's verification plan                   |

**Compatibility aliases:** `lab`, `opencode-lab`, and `lab --workspace <path>` map
to the same launcher.

### Before Docker starts: preflight

Every `open` runs **project preflight**: Git root and cleanliness, runtime/package
manager, verification commands, preview-port listeners, and managed-run eligibility.
Unsupported or ambiguous setup stops with a **clear remediation** instead of failing
inside the container.

### One foreground workspace

Command Center keeps **one interactive foreground workspace**. Opening another
project while one is active shows the running path/PID and offers to resume or stop
first. **Background managed runs** (`/ship`, fleet jobs) continue independently.

### Tool profile flags (launch only)

```bash
occtl open --with-research    # Hound research stack
occtl open --with-design      # OpenDesign stack
occtl open --full-tools       # both
occtl open --rebuild          # force rebuild selected images
```

These flags are consumed by the launcher — not passed to OpenCode. You **cannot**
start Hound or OpenDesign mid-session by switching agents; **quit and relaunch** with
the right profile.

---

## The interactive TUI

The TUI is upstream OpenCode with Command Center defaults, plugins, and keybinds.

### Navigation essentials

| Action            | Keys                                     |
| ----------------- | ---------------------------------------- |
| Command palette   | `Ctrl+P`                                 |
| Workflow menu     | `Ctrl+Shift+W` or `/workflow`            |
| Agents help       | `Ctrl+Shift+A` or `/agents-help`         |
| Managed runs desk | `Ctrl+Shift+R` or `/runs`                |
| Sidebar           | `<leader>B` (leader = pause after chord) |
| New session       | `<leader>N`                              |
| Session list      | `<leader>L`                              |
| Rename session    | `Ctrl+R`                                 |
| Copy message      | `<leader>Y` or `Ctrl+Shift+C`            |
| Paste into input  | `Ctrl+V` / `Cmd+V`                       |
| Select agent lane | **Tab** (before your prompt)             |

**Mouse is enabled** so you can click the command palette, permission prompts, and
lists. Copy/paste still works best via keyboard on macOS Terminal.

### Plugins you get out of the box

| Plugin              | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| **workflow-menu**   | `/workflow`, keyboard shortcuts                 |
| **agent-ops**       | Quality desk layout, permission shortcuts       |
| **run-center**      | `/runs` control center                          |
| **cache-stats**     | Usage / cache telemetry                         |
| **lifecycle-hooks** | Tool audit log (`.lab-hooks/tool-events.jsonl`) |

### Approval prompts

When the agent wants to run a tool, you approve or deny in the TUI. Default mode is
**safe-auto**: low-risk file edits auto-approve; **shell, credentials, and publishing
never auto-approve**. Change mode at launch:

```bash
occtl open --approval-mode ask
occtl open --approval-mode safe-auto    # default
occtl open --approval-mode broad-auto
```

Approval preference is **host-owned** — projects cannot change it.

---

## Coding lanes and workflow agents

### Coding lanes (Tab before the prompt)

Choose the lane **before** each ordinary coding prompt. Models do **not** switch
mid-turn.

| Lane     | Model          | Best for                                  |
| -------- | -------------- | ----------------------------------------- |
| **fast** | GLM-4.7 Flash  | Small, bounded, low-risk edits            |
| **lab**  | GPT-OSS 120B   | Default everyday implementation           |
| **deep** | Kimi K2.7 Code | Complex, cross-cutting, or high-risk work |

### Workflow agents (slash commands / dedicated modes)

| Agent               | Role                                                      |
| ------------------- | --------------------------------------------------------- |
| **plan**            | Read-only planning (`/plan`)                              |
| **reviewer**        | Read-only critique (`/review`)                            |
| **research**        | Evidence gathering (`/research`; needs `--with-research`) |
| **dispatcher**      | Managed-run dispatch only (`/ship`, `/parallel`)          |
| **visual-reviewer** | Screenshot / UI review (`/visual-review`)                 |

### Typical flows

```text
/plan → (switch to fast/lab/deep) → implement → /review
/research → /plan → implement
/ship  →  inspect in /runs  →  adopt / publish when ready
```

Reserved harness names (`fast`, `lab`, `deep`, `plan`, …) cannot be overridden by
project agents. See [When to use agents](lab/when-to-use-agents.md) and
[Workspace agents](lab/workspace-agents.md).

---

## Slash commands

Type `/` in the TUI or use **Ctrl+P** and pick a command.

### Planning and implementation

| Command     | Description                                 |
| ----------- | ------------------------------------------- |
| `/plan`     | Produce a plan without editing files        |
| `/ship`     | Start a managed implementation + verify run |
| `/parallel` | Queue 2–4 parallel managed tasks            |
| `/research` | Evidence-backed research task               |
| `/review`   | Read-only quality / security review         |
| `/eval`     | Focused evaluation against a contract       |

### Session and context

| Command       | Description                    |
| ------------- | ------------------------------ |
| `/checkpoint` | Save a rewindable WIP snapshot |
| `/rewind`     | Restore a checkpoint           |
| `/compact`    | Compact session context        |
| `/recap`      | Session handoff summary        |

### Local run and preview

| Command      | Description                                       |
| ------------ | ------------------------------------------------- |
| `/preview`   | Start the app and return Mac URLs (`3100`/`3101`) |
| `/run-local` | Build/run using project or pack skills            |
| `/browser`   | HTTP smoke-test a preview or gallery URL          |

### Artifacts and publishing

| Command    | Description                                         |
| ---------- | --------------------------------------------------- |
| `/gallery` | Browse marketing images under `artifacts/marketing` |
| `/view`    | Validate an image or gallery path                   |
| `/publish` | Bounded commit / push flow                          |
| `/notion`  | Restricted Notion publish (when enabled)            |

### Operator menus

| Command        | Description                             |
| -------------- | --------------------------------------- |
| `/workflow`    | Lab command menu                        |
| `/agents-help` | Lane and agent reference                |
| `/runs`        | Managed-run control center              |
| `/chrome`      | Open an approved Chrome tab on the host |

Full behavior and flags: [CLI reference — slash commands](cli-reference.md).

---

## Local preview on your Mac

This is one of the most important Command Center conventions.

### The port contract

| Inside container | On your Mac             |
| ---------------- | ----------------------- |
| `0.0.0.0:3000`   | `http://127.0.0.1:3100` |
| `0.0.0.0:3001`   | `http://127.0.0.1:3101` |

Always open **`3100`/`3101` on the Mac** — never `localhost:3000` inside the
container from your browser, and never Codespaces / VS Code Ports / SSH tunnels.

The **`opencode-preview`** relay (started by the launcher) forwards loopback
`3100`/`3101` → container `3000`/`3001`.

### Starting a preview (agent or you)

Agents should use the durable starter — **not** bare background shell dev:

```bash
node /opencode-config/scripts/local-preview/start.mjs start
node /opencode-config/scripts/local-preview/start.mjs status
node /opencode-config/scripts/local-preview/start.mjs stop
node /opencode-config/scripts/local-preview/start.mjs restart
```

Why: `npm run dev &` dies when the agent's bash tool session exits. `start.mjs`
uses `nohup`, writes a pid/log under `/tmp/lab-preview/`, waits until the port
answers, and prints the Mac URL.

Check what's listening:

```bash
node /opencode-config/scripts/local-preview/check.mjs
```

Or ask the agent: **`/preview`**.

### Workspace docker compose

If the project publishes preview ports in its own `docker-compose.yml`, use:

```yaml
ports:
  - "127.0.0.1:3100:3000"
  - "127.0.0.1:3101:3001"
```

### Next.js dev through `:3100`

When you view **`next dev`** through the Lab relay, the browser origin is
`127.0.0.1:3100` while Next listens on container `:3000`. **Next.js 16+** blocks
dev HMR WebSocket connections from unrecognized origins. Symptom: the page loads
but **client-only UI never hydrates** (e.g. hero video stuck on a poster).

**Fix:** add to the project's `next.config`:

```js
allowedDevOrigins: ['127.0.0.1:3100', '127.0.0.1'],
```

Then restart dev (`start.mjs restart`). For animation or production-like QA, prefer
`npm run build && npm start` instead of dev mode.

### If Mac URL refuses connection

1. Confirm the app listens inside the container (`check.mjs` or `start.mjs status`).
2. If the container is up but Mac `3100` refuses: quit and **relaunch `lab`** so
   the preview relay recreates (launcher verifies port publish after start).
3. Read `/tmp/lab-preview/server.log` for bind or startup errors.

---

## Tool profiles: research and design

Default launch is the **fast coding profile**: gateway + OpenCode only. Optional
stacks are **off** until you opt in.

| Profile flag      | Adds                   | Enables                         |
| ----------------- | ---------------------- | ------------------------------- |
| `--with-research` | Hound + filtered relay | `/research`, **research** agent |
| `--with-design`   | OpenDesign daemon      | Design MCP tools                |
| `--full-tools`    | Both                   | Full research + design          |

Generic research in the TUI may auto-select Hound when the profile is active.
**Loaded packs** can declare that their agents require research or design tooling.

Rebuild when Dockerfiles change:

```bash
occtl open --rebuild --with-research
```

---

## Managed runs: ship, parallel, and /runs

Interactive chat edits the mounted workspace directly. **Managed runs** add
stronger guarantees for non-trivial work.

### What `/ship` gives you

- Isolated **Git worktree** and branch per attempt
- Explicit task, model route, limits, and quality contract
- Controller-owned commit with declared files only
- Deterministic **verification** + independent **review**
- Durable evidence, checkpoints, recovery refs
- Idempotent adoption and PR preparation

Related commands: `/parallel` (multiple tasks), `/research` (evidence runs).

### Operating runs

Open **`/runs`** or press **`Ctrl+Shift+R`**. The run desk shows phase, models,
elapsed time, cost telemetry (when available), approvals, verification, review,
worktree, artifacts, preview, and PR status.

Host automation (same controller):

```bash
npm run ship -- --workspace ~/Projects/app --task "Implement X"
npm run lab:background -- --workspace ~/Projects/app --prompt "…"
npm run lab:fleet -- enqueue --workspace ~/Projects/app --prompt "A" --prompt "B"
```

Deep dive: [Managed runs](managed-runs.md).

---

## Checkpoints, rewind, and session hygiene

| Command       | Use when                             |
| ------------- | ------------------------------------ |
| `/checkpoint` | Save WIP before a risky change       |
| `/rewind`     | Restore a saved checkpoint           |
| `/compact`    | Context is long; trim safely         |
| `/recap`      | Hand off to another session or human |

Managed runs maintain their own durable checkpoints and recovery refs separate from
interactive `/checkpoint`.

---

## Project skills, agents, and packs

### Project-local `.opencode/`

Your repo can add:

- **Agents** — extra personas (must not collide with reserved harness names)
- **Commands** — slash command definitions
- **Skills** — `SKILL.md` files the agent reads for domain workflows

Command Center merges project config with harness defaults. The **project-skills**
skill tells agents to load `/workspace/.opencode/skills` and project `AGENTS.md`.

### Authoring project skills

Use the harness **author-project-skill** skill or follow
`.opencode/skills/author-project-skill/SKILL.md` for conventions.

### External packs

Versioned **packs** add agents, commands, services, models, and contracts without
forking Command Center. Enable per project in `.opencode-lab/project.json` or at
`occtl init --pack <id>`. See [External workflow packs](packs.md).

### Frontend / Node in Docker

Node projects with native modules may need Linux `node_modules` inside the
container. See [Frontend workspaces](lab/frontend-workspaces.md).

---

## Safety, approvals, and trust boundaries

Command Center assumes the **agent is untrusted**. Layers:

1. **Container hardening** — read-only rootfs, `cap_drop: ALL`, memory limits,
   credential file masking
2. **Network** — no general outbound; models and tools use gateway + relays
3. **`opencode.json` permissions** — default ask; deny env/secrets reads and
   dangerous paths
4. **Tool lifecycle plugin** — blocks destructive bash patterns and credential paths
5. **Safe helpers** — `safe-git.mjs`, `safe-remove.mjs` (plan → approve → execute
   to `.agent-trash`)
6. **Scoped GitHub relay** — no raw token in container; operations bound to workspace
   origin

Deletion policy: never `rm -rf` improvisation. Always plan with `safe-remove.mjs`.

Full rules: [Agent safety](agent-safety.md). Threat model: [Threat model](threat-model.md).

---

## Browser, gallery, and visual review

| Service         | Mac URL                          | Purpose                          |
| --------------- | -------------------------------- | -------------------------------- |
| App preview     | `http://127.0.0.1:3100` / `3101` | Your running app                 |
| Gallery         | `http://127.0.0.1:3110`          | Safe image artifacts             |
| Browser verify  | `http://127.0.0.1:3111`          | Automated HTTP/Playwright checks |
| Browser session | `http://127.0.0.1:3112`          | Interactive browser relay        |

Host setup for Playwright relays:

```bash
npm run lab:browser:setup
npm run lab:browser -- http://127.0.0.1:3100
```

Use `/browser` in the TUI for smoke tests; `/visual-review` for screenshot critique.

---

## Where state lives

Command Center **never** writes runtime state into your mounted repository.

| What                              | Location (macOS)                                     |
| --------------------------------- | ---------------------------------------------------- |
| Host state & registry             | `~/Library/Application Support/OpenCode Lab/state`   |
| Host preferences                  | `~/Library/Application Support/OpenCode Lab/config`  |
| Project contract (optional)       | `<repo>/.opencode-lab/project.json` (safe to commit) |
| Tool audit log                    | `<repo>/.lab-hooks/tool-events.jsonl`                |
| Agent trash (recoverable deletes) | `<repo>/.agent-trash/`                               |
| In-container preview logs         | `/tmp/lab-preview/server.log`                        |

Git ignore: Command Center only adds patterns to **`.git/info/exclude`**, not
`.gitignore`. Credential files that exist on the host are **masked** with empty
read-only mounts in the container.

Docker **named volumes** are keyed by project ID so one project cannot inherit
another's caches or OpenCode state.

---

## Troubleshooting

### `occtl doctor` failures

Run from the harness checkout or after `npm link`:

```bash
occtl doctor /path/to/project
```

Checks Node, Docker, `opencode.env`, Git, runtime, verify commands, preview ports,
and stale runs. Doctor does **not** build images.

### Docker images stale

```bash
occtl open --rebuild /path/to/project
```

### Preview: container up, Mac URL dead

Relaunch **`lab`** / `occtl open` so `opencode-preview` recreates. The launcher
verifies `3100`/`3101` publish after start.

### Preview: static page, broken client animations (Next.js)

See [Next.js dev through `:3100`](#nextjs-dev-through-3100) — add
`allowedDevOrigins` or use production `next start`.

### Cannot click TUI / mouse seems dead

Ensure you relaunched after a TUI defaults update. Command Center sets **`mouse:
true`** in `.opencode/tui.json`. Use keyboard if needed: `Ctrl+P`, arrow keys,
`Enter`, `Esc`.

### HMR / WebSocket errors in console on `:3100`

Expected in dev without `allowedDevOrigins`. Harmless for production builds;
fix for dev as above.

### Agent stuck after permission deny

Re-run the action or switch to **ask** mode temporarily:
`occtl open --approval-mode ask`.

### Foreground already running

```bash
occtl status
occtl stop      # or resume the existing session
```

### Research or design tools missing

Quit TUI and relaunch:

```bash
occtl open --with-research /path/to/project
```

Tab-switching cannot start missing stacks mid-session.

---

## Further reading

| Topic               | Document                                               |
| ------------------- | ------------------------------------------------------ |
| Hands-on tutorial   | [tutorial.md](tutorial.md)                             |
| Architecture        | [architecture.md](architecture.md)                     |
| CLI & env vars      | [cli-reference.md](cli-reference.md)                   |
| Managed runs        | [managed-runs.md](managed-runs.md)                     |
| Known issues        | [lab/known-issues.md](lab/known-issues.md)             |
| Project contract    | [project-contract.md](project-contract.md)             |
| Agent selection     | [lab/when-to-use-agents.md](lab/when-to-use-agents.md) |
| Workspace agents    | [lab/workspace-agents.md](lab/workspace-agents.md)     |
| Packs               | [packs.md](packs.md)                                   |
| Safety              | [agent-safety.md](agent-safety.md)                     |
| Threat model        | [threat-model.md](threat-model.md)                     |
| Strict microVM mode | [strict-mode.md](strict-mode.md)                       |
| Updates & rollback  | [compatibility.md](compatibility.md)                   |

Repository policies: [SECURITY.md](../SECURITY.md), [SUPPORT.md](../SUPPORT.md),
[CONTRIBUTING.md](../CONTRIBUTING.md).
