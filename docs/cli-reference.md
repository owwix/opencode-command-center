# CLI and configuration reference

The `occtl` executable is the supported host interface. `lab` and
`opencode-lab` are v0.x compatibility aliases. Install them with `npm link`
from the Command Center checkout, or use `npm run opencode -- ...` from that
checkout.

```bash
npm link
occtl --help
```

Commands may be run from any directory. Paths are resolved canonically before
state or containers are created.

## Project lifecycle

| Command                                    | Behavior                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occtl open [path]`                        | Open a canonical project path. With no path, use the workspace picker/current directory behavior.                                                   |
| `occtl new [path]`                         | Create one exact empty directory, then open it. On interactive macOS, omitting the path opens a folder/name chooser. Refuses nonempty targets.      |
| `occtl recent [--json]`                    | List registered projects by most-recently-opened time.                                                                                              |
| `occtl status [--json]`                    | Show the foreground launch and durable background activity.                                                                                         |
| `occtl stop [--json]`                      | Stop only the registered foreground PID after verifying that it is the expected launcher.                                                           |
| `occtl resume [index\|name\|path]`         | Resolve and reopen a recent project. Reports success without relaunching when it is already foreground.                                             |
| `occtl init [path] [--pack ID]... [--yes]` | Preview the detected project contract, validate pack IDs, and write it atomically only after exact approval. Never overwrites an existing contract. |
| `occtl doctor [path]`                      | Diagnose host/runtime state and the same project preflight used by launch. Does not build images.                                                   |
| `occtl verify [path]`                      | Execute the verification plan selected by the project adapter.                                                                                      |
| `occtl prune [--apply]`                    | Report recognized legacy `opencode-lab-*` volumes. Delete only exact revalidated names when `--apply` is present.                                   |

`recent`, `status`, and `stop` accept `--json` for automation. Other unknown
lifecycle flags fail with status 1 instead of being silently forwarded.

## Launch profiles

These flags apply to `occtl open`, `occtl new`, `occtl resume`, and the v0.x
launcher path. They are consumed by Command Center and are not passed to
OpenCode.

| Flag              | Effect                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--with-research` | Start Hound and its filtered relay.                                                                                     |
| `--with-design`   | Start OpenDesign.                                                                                                       |
| `--full-tools`    | Start both optional stacks.                                                                                             |
| `--rebuild`       | Force-rebuild every selected profile image before launch. The core OpenCode image is rebuilt automatically when stale.  |
| `--strict`        | Use strict clone-isolated execution instead of the normal Compose launch. Cannot be combined with normal profile flags. |

The default coding profile requires neither Hound nor OpenDesign. Switching to
a research/design agent after launch cannot start a missing service; quit and
relaunch with the corresponding profile.

## Approval modes

Approval selection is host-owned and persists outside projects.

| Flag                         | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--approval-mode ask`        | Ask for every action not explicitly allowlisted.                                                                           |
| `--approval-mode safe-auto`  | Automatically allow only low-risk file tools. Public default.                                                              |
| `--approval-mode broad-auto` | Broad non-shell auto-approval; still cannot bypass hard denies, credential, publishing, network, or capability boundaries. |
| `--auto`                     | Persistent alias for `broad-auto`.                                                                                         |
| `--no-auto`                  | Persistent alias for `ask`.                                                                                                |

Project code, project contracts, packs, and the OpenCode container cannot edit
the host approval preference.

## Releases and compatibility

| Command                    | Behavior                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `occtl version`            | Print source, compatibility manifest, active release, and image state as JSON.                                                    |
| `occtl update [--ref REF]` | Stage a source ref (default `main`), build candidate images, run compatibility checks, back up state, and atomically activate it. |
| `occtl rollback`           | Restore the previous staged release and record the state backup path.                                                             |

See [Compatibility](compatibility.md) for pin and rollback guarantees.

## Strict mode

| Command                              | Behavior                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `occtl strict doctor [--json]`       | Validate macOS, Apple silicon, Docker Desktop, and standalone `sbx`. Read-only.     |
| `occtl strict run [path]`            | Create a clone-isolated Docker Sandbox session with a chat-only lease.              |
| `occtl open [path] --strict`         | Alias for strict run.                                                               |
| `lab --strict [--workspace path]`    | v0.x-compatible alias.                                                              |
| `occtl strict export <run>`          | Export a signed bundle containing a clean Git patch and bounded evidence/artifacts. |
| `occtl strict adopt <run> --approve` | Verify and explicitly adopt the signed patch into the original clean checkout.      |

Strict export/adoption is idempotent. It does not push or publish automatically.

## Managed host commands

The TUI commands are preferred for normal use. These npm commands expose the
same controller for automation and debugging:

```bash
npm run ship -- --workspace /path/to/repo --task "Implement the change"
npm run research -- --workspace /path/to/repo --task "Research the decision"
npm run lab:background -- --workspace /path/to/repo --prompt "Implement X"
npm run lab:fleet -- enqueue --workspace /path/to/repo --prompt "A" --prompt "B"
npm run quality:status -- --run <run-id>
npm run quality:artifacts -- --run <run-id>
npm run quality:resume -- --run <run-id>
npm run quality:cancel -- --run <run-id> --reason "operator cancelled"
npm run quality:archive -- --run <run-id>
npm run quality:cleanup -- --run <run-id>
```

The controller also implements `prepare`, `finalize`, `verify`, `review`,
`gate`, `adopt`, `prepare-pr`, `abandon`, `metrics`, `retention`, `checkpoint`,
`replay`, `approvals`, `approve`, `trace`, `queue`, `memory`, `parallel`,
`route`, `research-stage`, and `research-approve`. These are controller
interfaces used by `/runs` and managed scripts; use them only with the exact
run/workspace identifiers printed by Command Center. See [Managed runs](managed-runs.md)
for lifecycle constraints.

## TUI commands

Command availability may depend on the selected profile and enabled packs.

| Command             | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `/agents-help`      | Show fixed model lanes and loaded workflow agents.                                       |
| `/workflow`         | Show the command map and explain that missing research/design profiles require relaunch. |
| `/plan`             | Propose an approach without editing.                                                     |
| `/ship`             | Implement and verify one scoped outcome in a managed run.                                |
| `/parallel`         | Start two to four isolated managed tasks and synthesize only passing members.            |
| `/research`         | Produce an evidence-backed research result.                                              |
| `/review`           | Review current changes without modifying them.                                           |
| `/eval`             | Run a focused evaluation with explicit success criteria.                                 |
| `/runs`             | Open the project-scoped managed-run control center (`Ctrl+Shift+R`).                     |
| `/checkpoint`       | Save a rewindable checkpoint of current workspace WIP.                                   |
| `/rewind`           | Restore a named Command Center checkpoint.                                               |
| `/compact`          | Compact an oversized session context.                                                    |
| `/recap`            | Summarize the current outcome, completed work, blocker, and next action.                 |
| `/preview`          | Start/build the project and expose Mac preview ports.                                    |
| `/run-local`        | Run an HTTP or CLI project using matching workspace/pack skills.                         |
| `/browser`          | Smoke-test an allowed loopback preview/gallery URL.                                      |
| `/gallery`          | Open image artifacts under `artifacts/marketing`.                                        |
| `/view --file PATH` | Validate and report a workspace image or gallery URL.                                    |
| `/publish`          | Validate, commit, and push through the bounded publication flow.                         |
| `/notion`           | Publish one Markdown file to a configured restricted Notion target.                      |

Pack-provided commands appear only when their pack is enabled by the project
contract and accepted by the pack loader.

## Operator configuration

Copy `opencode.env.example` to ignored `opencode.env`. Do not commit it.

| Variable                          | Required              | Owner and purpose                                                                           |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`           | default model profile | Gateway-only Workers AI account.                                                            |
| `CLOUDFLARE_API_TOKEN`            | default model profile | Gateway-only Workers AI token.                                                              |
| `OPENAI_API_KEY`                  | optional              | Enables allowlisted OpenAI chat routes through the gateway.                                 |
| `GOOGLE_CLOUD_PROJECT`            | optional              | Enables Vertex Gemini routes; ADC remains mounted read-only into the gateway, not OpenCode. |
| `AGENT_GATEWAY_SIGNING_KEY`       | generated if absent   | Host/gateway-only HMAC signer for launch/run capability leases. Minimum 32 bytes.           |
| `STRICT_EXPORT_SIGNING_KEY`       | optional              | Separate host-only signer for strict exports; falls back to the capability signer.          |
| `STRICT_GATEWAY_URL`              | strict mode only      | HTTPS fixed-purpose gateway accepting the strict session lease.                             |
| `OD_API_TOKEN`                    | generated if absent   | Authenticates the local OpenDesign API.                                                     |
| `QUALITY_MCP_TOKEN`               | generated if absent   | Authenticates gateway-to-quality relay traffic.                                             |
| `GITHUB_PUBLISH_RELAY_TOKEN`      | generated if absent   | Authenticates only the local GitHub publishing relay.                                       |
| `OPENPETS_RELAY_TOKEN`            | generated if absent   | Authenticates only the local OpenPets relay.                                                |
| `LAB_BROWSER_VERIFY_RELAY_TOKEN`  | generated if absent   | Authenticates only browser-verification relay traffic.                                      |
| `LAB_BROWSER_SESSION_RELAY_TOKEN` | generated if absent   | Authenticates only interactive browser relay traffic.                                       |
| `ARTIFACT_DOWNLOAD_ALLOWLIST`     | optional              | Comma-separated exact public HTTPS hostnames accepted by the artifact relay.                |
| `OPENCODE_PREVIEW_PORT`           | optional              | Host preview port for container `3000`; default `3100`.                                     |
| `OPENCODE_PREVIEW_PORT_ALT`       | optional              | Host preview port for container `3001`; default `3101`.                                     |
| `NOTION_API_TOKEN`                | Notion profile only   | Held only by the restricted Notion sidecar.                                                 |
| `NOTION_PUBLISH_TARGETS_JSON`     | Notion profile only   | Map of route names to pre-shared parent-page IDs.                                           |
| `NOTION_PUBLISHER_TOKEN`          | Notion profile only   | Authenticates gateway-to-publisher traffic.                                                 |
| `OPENCODE_LAB_PACKS`              | optional              | Host-delimited absolute pack roots. Paths are not exposed to OpenCode.                      |
| `OPENCODE_GIT_USER_NAME`          | optional              | Git identity injected as process-local Git configuration.                                   |
| `OPENCODE_GIT_USER_EMAIL`         | optional              | Git email injected as process-local Git configuration.                                      |
| `OPENCODE_LAB_STATE_ROOT`         | optional              | Absolute override for host state.                                                           |
| `OPENCODE_LAB_CONFIG_ROOT`        | optional              | Absolute override for host preferences/configuration.                                       |

Generated relay URLs, project IDs, workspace hashes, run IDs, runtime paths,
image tags, volume names, and launch tokens are internal implementation
variables. They are validated and injected by the launcher; users and projects
must not set them.

## Exit behavior

- `0`: the requested command completed, or a no-op state was already satisfied.
- `1`: invalid arguments, failed preflight, missing dependency/configuration,
  failed/cancelled managed run, rejected adoption, or another bounded error.
- A managed parallel/fleet parent is unsuccessful when any required member
  fails or is cancelled; it cannot report ready synthesis from failed members.
- `occtl stop` returns success when no foreground launch exists.

Errors are written to stderr with an actionable message. Commands fail closed
on unknown options and unsafe/mismatched state rather than guessing.

## Package and compatibility aliases

`opencode-command-center` is the long canonical package alias. The remaining
entries are supported during v0.x so existing launchers and automation do not
break:

```text
opencode-command-center
lab
lab --workspace <folder>
opencode-lab
opencode-lab --workspace <folder>
opencode-lab task <type> <request>
opencode-lab --setup
npm run opencode -- --workspace <folder>
```

New documentation and automation should use `occtl` lifecycle commands.
