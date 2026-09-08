# Tutorial: first project to verified pull request

This tutorial takes an existing Git project through installation, project
contract setup, an interactive launch, one managed implementation, evidence
inspection, and pull-request preparation.

It uses the public default profile: no private packs, Hound, OpenDesign, Notion,
or broad auto-approval are required.

## 1. Prepare the host

Requirements:

- supported macOS host with Docker Desktop running;
- Node version from `.nvmrc` (Node 24);
- Git;
- a Cloudflare account/token with Workers AI access for the default models;
- optional authenticated GitHub CLI for push/PR preparation.

Clone OpenCode Command Center and configure it:

```bash
git clone https://github.com/owwix/opencode-lab.git
cd opencode-lab
nvm use
npm ci
cp opencode.env.example opencode.env
```

Edit ignored `opencode.env` and set:

```text
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_API_TOKEN=<a-scoped-workers-ai-token>
```

Do not paste credentials into a project, prompt, tracked file, or issue. Command Center
generates local gateway/relay secrets when omitted.

Install the global launcher and verify the host:

```bash
npm link
lab --setup
occtl doctor /path/to/project
```

`occtl doctor` should identify Docker, Node, Git, project runtime/package manager,
verification commands, preview ports, and managed-run eligibility. It does not
build images.

## 2. Prepare a project

Use an existing clean Git repository with at least one deterministic test,
typecheck, lint, or build command:

```bash
cd /path/to/project
git status --short
```

If the project is dirty, commit/stash your work before a managed run. Command Center will
not silently mix existing changes into an isolated implementation.

Preview the detected project contract:

```bash
occtl init .
```

Command Center prints the complete candidate and writes nothing until you type `yes`. To
approve noninteractively after reviewing it:

```bash
occtl init . --yes
```

The resulting `.opencode-lab/project.json` is safe to commit. Review its
`install`, `verify`, `development`, `previewPorts`, `artifactRoots`,
`riskLevel`, and `enabledPacks`. It contains no credentials or host policy.

Validate the exact adapter plan:

```bash
occtl verify .
```

## 3. Open the project

Start the default coding profile:

```bash
occtl open .
```

The first launch builds missing core images. Warm launches reuse them. In the
TUI:

1. run `/agents-help` to see the fixed `fast`, `lab`, and `deep` lanes;
2. run `/workflow` to see available commands;
3. keep the public default `safe-auto` approval mode;
4. ask a read-only question first, such as “Explain the verification path for
   this project.”

Choose a lane with Tab before the task. The model does not switch automatically
mid-turn.

## 4. Preview the application when applicable

For an HTTP project, use:

```text
/preview
```

The project server binds inside Command Center to `0.0.0.0:3000` or `:3001`. Open only the
Mac relay URLs:

```text
http://127.0.0.1:3100
http://127.0.0.1:3101
```

Use `/browser` for a smoke check. If `3100`/`3101` are already occupied, Command Center
prints the owning `lsof` command/PID rather than claiming preview succeeded.

Non-HTTP projects report their CLI result and do not invent a browser URL.

## 5. Run one managed change

Use a bounded request with an observable outcome:

```text
/ship Add validation for empty display names, add focused tests, run the
project verification plan, and prepare the result for review. Do not change
unrelated files.
```

Command Center creates an isolated worktree and durable run. The implementation agent must
produce a machine-validated result, after which the controller:

1. commits exactly the declared changed files;
2. runs deterministic project verification;
3. runs independent read-only review;
4. records evidence against the implementation SHA;
5. reports `passed`, `needs_evidence`, or `failed`.

Do not manually copy files out of the worktree while the run is active; use the
run's adoption action after it passes.

## 6. Inspect evidence and operate the run

Open the control center:

```text
/runs
```

Select the run and verify:

- the project and task are correct;
- verification and review both reference the same head SHA;
- changed files match the request;
- every quality claim links to a log, manifest, review, or Git receipt;
- cost is observed or explicitly marked unavailable;
- there are no pending approvals or blockers.

Available actions depend on state. `resume` starts prepared work; `retry` adds a
bounded attempt to failed/cancelled work; `approve`/`reject` resolves one exact
pending request; `cancel` terminates the active process group.

If the run is `needs_evidence`, inspect the contract and add only the missing
research/visual evidence before resuming. Do not treat it as passed.

## 7. Adopt the verified change

For a passing release-requested run, choose `adopt` in `/runs`. Adoption:

- verifies the source checkout and base SHA;
- applies only the exact controller commit;
- records an adoption receipt;
- is idempotent if repeated;
- refuses a changed/dirty target instead of overwriting it.

Inspect the adopted checkout:

```bash
git status --short
git show --stat --oneline HEAD
occtl verify .
```

The worktree should be clean and the commit should contain only the declared
files.

## 8. Prepare a pull request

Authenticate GitHub on the host, not in the agent container:

```bash
gh auth login
gh auth status
```

In `/runs`, choose `prepare-pr`. The bounded GitHub relay supports only status,
push, and PR preparation. The receipt records PR URL, base, branch, and verified
head SHA. Repeating the action returns the existing PR rather than opening a
duplicate.

Confirm on GitHub that the PR head equals the verified SHA shown in `/runs`.

## 9. Finish and recover

After publication:

- `archive` hides a terminal run without deleting its evidence;
- `cleanup` removes only work proven safe and refuses dirty/unpublished work;
- `occtl status` shows remaining foreground/background activity;
- `occtl stop` stops the verified foreground launcher.

If the host or controller restarts, open Command Center and `/runs` again. Startup
reconciliation records the interrupted attempt, recovers controller state, and
retains `refs/opencode-lab/runs/<run-id>` for unpublished Git work.

## Optional profiles

Relaunch rather than switching tools inside an existing session:

```bash
occtl open . --with-research
occtl open . --with-design
occtl open . --full-tools
```

Use research only for public-web evidence and design only for a declared design
workflow. Optional profiles add attack surface and are disabled by default.

## Troubleshooting

| Symptom                          | Action                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm` cannot find `package.json` | Run `occtl` globally after `npm link`, or use `npm --prefix /path/to/opencode-lab run opencode -- --workspace /path/to/project`. |
| Node version mismatch            | Run `nvm install` and `nvm use` in the Command Center checkout. The launcher also locates the pinned nvm binary directly.        |
| Docker image/config mismatch     | Run `occtl doctor`; rebuild explicitly with `occtl open . --rebuild`.                                                            |
| Hound/OpenDesign unavailable     | Quit and relaunch with `--with-research` or `--with-design`.                                                                     |
| Preview cannot bind              | Stop/reconfigure the process printed for `3100`/`3101`, then retry.                                                              |
| Managed run stops at review      | Inspect `/runs`; a failed or evidence-incomplete run is intentionally not promoted.                                              |
| Push is unavailable              | Authenticate `gh` on the host and confirm the run requested publication. Do not copy a GitHub token into the container.          |
| Artifact download denied         | Add the exact public HTTPS hostname to `ARTIFACT_DOWNLOAD_ALLOWLIST`; private/localhost targets remain denied.                   |

For deeper references, see [Architecture](architecture.md),
[CLI/configuration](cli-reference.md), [Managed runs](managed-runs.md), and
[Gateway protocol](gateway-protocol.md).
