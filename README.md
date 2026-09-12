# OpenCode Command Center

The independent control plane for [OpenCode](https://opencode.ai): open any
project in an isolated workspace, operate parallel agent runs, and accept only
reviewed, verified changes.

OpenCode Command Center is an independent project. It is not affiliated with, endorsed by,
or sponsored by OpenCode or its maintainers. OpenCode is a separate upstream
project and its name and trademarks remain with their respective owners.

Core is product-neutral. Company agents, commands, themes, contracts, and run
skills load from external versioned packs and are not stored in this repository.

## Requirements

- Docker Desktop
- Node.js 24 (`nvm use` reads `.nvmrc`)
- Cloudflare Workers Paid (for default Kimi / Workers AI models)

## Quick start

```bash
cp opencode.env.example opencode.env
# Fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (optional OpenAI / Vertex)
npm install
npm run opencode
# or:
npm run opencode -- --workspace "$HOME/Projects/some-app"
```

Install a global launcher (optional):

```bash
npm link
occtl --setup
occtl open "$HOME/Projects/some-app"
```

macOS shortcut: `launch-opencode.command`.

**New here?** Read the **[User guide](docs/user-guide.md)** for a full walkthrough of
agents, preview ports, managed runs, and troubleshooting.

## Documentation

- **[User guide](docs/user-guide.md)** — full feature reference for operators
- [Documentation index](docs/README.md)
- [Architecture and data flow](docs/architecture.md)
- [Codebase reference](docs/code-reference.md)
- [First project to verified PR](docs/tutorial.md)
- [CLI and configuration reference](docs/cli-reference.md)
- [Managed-run lifecycle](docs/managed-runs.md)
- [Gateway and capability protocol](docs/gateway-protocol.md)
- [Threat model](docs/threat-model.md)

## Project lifecycle

The `occtl` launcher works from any directory. With no path, `occtl open` uses
the workspace picker; `occtl new` creates one exact empty directory before opening it.
Recent projects and active launches come from the host-owned project registry,
not from files written into a mounted repository.

```bash
occtl open [path]
occtl new [path]
occtl recent                    # add --json for machine-readable output
occtl status                    # foreground + background activity
occtl stop                      # SIGTERM only after verifying the launcher PID
occtl resume [index|name|path]
occtl init [path] [--pack id] [--yes] # preview and approve contract v1
occtl doctor [path]
occtl prune [--apply]
occtl version
occtl update [--ref REF]
occtl rollback
```

The previous `lab` and `opencode-lab` commands remain compatibility aliases;
`--workspace <path>`, managed `task` commands, and `--setup` also continue to
work.

Projects may commit `.opencode-lab/project.json` to declare install, verify,
development, preview, artifact, risk, and enabled-pack metadata. Without it,
Command Center uses a read-only detected contract. See the
[project contract reference](docs/project-contract.md).
Runtime compatibility, staged updates, backups, and rollback are documented in
the [compatibility reference](docs/compatibility.md).

Every open runs a project preflight before Docker starts. It reports the Git
root and cleanliness, supported runtime/package manager, verification commands,
preview-port listeners, local ignore setup, and managed-run eligibility. A
declared unsupported executable stops with a remediation instead of failing
inside the container later.

## Tool profiles and rebuilds

The default interactive launch is the fast coding profile: it starts the
required credential gateway and state initializer, while Hound and OpenDesign
stay disabled. Generic research selects Hound automatically; loaded packs
declare whether their agents require research or design tooling.

```bash
occtl open --with-research               # Hound only
occtl open --with-design                 # OpenDesign only
occtl open --full-tools                  # both optional stacks
occtl open --rebuild --with-research     # rebuild only core + research images
```

Launcher-only flags are removed before OpenCode starts. Warm launches reuse
matching images. Command Center automatically rebuilds the core OpenCode image
when its Dockerfile fingerprint is missing or stale; use `--rebuild` only to
force every selected profile image to rebuild.
Switching agents with Tab during an existing interactive session cannot start a
new tool stack: relaunch with `--with-research` or `--with-design` first.

Command Center keeps one foreground interactive workspace. Opening another shows the
canonical path and PID of the active launch, then offers to resume it or stop it
before opening the new project. Background managed runs register separately and
continue without taking foreground ownership. Project/session/helper ownership
is recorded in host-owned state; no project receives the launch registration
token or access to that registry. To preserve existing installations, the v0.x
on-disk namespace remains
`~/Library/Application Support/OpenCode Lab/state` on macOS. Preferences live beside it
under the host-owned `config` directory. Runtime config, run state, logs, and
approval preferences are never created in a selected repository.

Command Center adds only compatibility patterns to the repository-local
`.git/info/exclude`; it does not edit `.gitignore`. Credential files that
already exist are masked with empty read-only mounts. Missing `.env`, `.npmrc`,
and related paths are redirected inside the container, so Docker does not
create empty placeholders in the project.

## What stays in Docker

| Piece              | Role                                                             |
| ------------------ | ---------------------------------------------------------------- |
| OpenCode container | TUI + agents; Node/npm/pnpm/Git; scoped gateway token only       |
| Agent gateway      | Real CF / Vertex / Quality credentials; model allowlist          |
| Hound              | On-demand research profile; isolated through its fixed relay     |
| OpenDesign         | On-demand design profile; separate scoped daemon token           |
| opencode-preview   | Mac `3100`/`3101` → app `:3000`/`:3001` (skipped if ports taken) |
| Gallery            | Host `http://127.0.0.1:3110` for safe image artifacts            |
| Browser relays     | Verify `:3111`, interactive session `:3112` (Playwright on Mac)  |

## Agents (Tab)

**Coding lanes for ordinary prompts:** **fast** (GLM-4.7 Flash, small low-risk
changes), **lab** (GPT-OSS 120B, standard/default), and **deep** (Kimi K2.7
Code, complex or high-risk work). Choose the lane with Tab before the coding
prompt; models do not switch automatically mid-turn.

**Workflow agents (always):** **plan**, **research**, **dispatcher**, and
**reviewer**. Managed `/ship` and `/parallel` runs use their separate task router.

**Extensions:** project-local `.opencode` files and enabled external packs add
agents and commands without changing core. See `docs/packs.md`,
`docs/lab/workspace-agents.md`, and `docs/lab/when-to-use-agents.md`.

## Local preview contract

Inside Command Center, apps bind `:3000` / `:3001`. On the Mac open only:

- `http://127.0.0.1:3100`
- `http://127.0.0.1:3101`

Never Codespaces / VS Code Ports. Skills: `local-preview`, `project-skills`, and
workspace or loaded-pack `run-*-dev` contributions.

## Useful commands

```text
/agents-help /workflow /plan /ship /parallel /research /review /eval /runs
/checkpoint /rewind /compact /recap /preview /run-local /browser /gallery
/view /publish /notion
```

The [CLI/configuration reference](docs/cli-reference.md) documents every core
lifecycle flag, approval mode, operator environment variable, slash command,
and exit behavior.

```bash
npm run lab:background -- --workspace ~/Projects/app --prompt "…"
npm run lab:fleet -- enqueue --workspace ~/Projects/app --prompt "A" --prompt "B"
npm run lab:browser:setup
npm run lab:browser -- http://127.0.0.1:3100
```

Foreground, background, parallel, and fleet work use the same durable run
records. Command Center reconciles interrupted heartbeats at startup, preserves a Git
recovery ref for every managed worktree, and refuses cleanup while changes are
dirty or have not been adopted/published.

Open `/runs` in the TUI (or press `Ctrl+Shift+R`) to inspect and operate those
runs. The project-scoped control center shows phase, state, models, elapsed
time, observed cost, approvals, verification, review, worktree, artifacts,
preview, and pull-request status. Quality claims include their concrete
evidence path; unavailable provider cost telemetry is labeled unavailable,
never `$0`.

## Safety

- Workspace credential files are masked; use `safe-git.mjs` / `safe-remove.mjs`
- Tool lifecycle plugin audits/blocks dangerous bash and credential paths
- OpenCode has no direct outbound network; model, browser, research, design,
  preview, publishing, and approved downloads cross fixed-purpose relays
- Host browser relays require the current scoped launch capability and run under
  macOS seatbelt when available
- Sessions, configuration, caches, and optional-service state use project-ID
  namespaced volumes, so one project cannot inherit another project's state
- Gallery, browser, preview, quality, GitHub, and companion helpers are reused
  only when their reported project ID and workspace hash match the launch
- Container: `read_only`, `cap_drop: ALL`, `no-new-privileges`, optional bwrap

The supported trust boundaries, attacker model, and known experimental limits
are documented in the [threat model](docs/threat-model.md). The public core has
no outbound product telemetry in v0.x. Company-specific agents, destinations,
credentials, evaluation cases, and operating policy belong in private packs;
see the [public/private product boundary](docs/product-boundary.md).

## Verify

```bash
npm run test:lab
npm run quality:test   # broader Command Center + quality suite
npm run provenance:check
npm run release:test
```

Public release candidates are exported from the private development repository
as a provenance-checked allowlisted tree with one new root commit. See
`docs/public-release.md`. Original contributions are Apache-2.0; retained
upstream notices are in `THIRD_PARTY_NOTICES.md`.

## Community and support

- Security reports: [SECURITY.md](SECURITY.md)
- Supported versions and help: [SUPPORT.md](SUPPORT.md)
- Contributions and DCO sign-off: [CONTRIBUTING.md](CONTRIBUTING.md)
- Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Proposed design changes: [RFC template](docs/rfcs/0000-template.md)
- Complete documentation map: [docs/README.md](docs/README.md)
- Release history: [CHANGELOG.md](CHANGELOG.md)

## Layout

```text
.opencode/          Generic agents, commands, plugins, and skills
docker-compose.opencode.yml
Dockerfile.opencode
docker/agent-gateway/   Credential gateway
docker/opencode-preview/
scripts/opencode.mjs    Launcher
scripts/lab/            Checkpoints, browser, fleet, sandbox
scripts/quality*/       Managed runs
quality/                Generic contracts + model routing
docs/packs.md           Versioned external pack contract
docs/agent-safety.md
docs/lab/
```

## License

Apache-2.0 for original OpenCode Command Center contributions. See
`THIRD_PARTY_NOTICES.md` and `provenance/files.json` for retained upstream
attributions.
