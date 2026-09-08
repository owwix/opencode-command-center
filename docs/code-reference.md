# Codebase reference

This reference maps public behavior to its implementation. OpenCode Command Center is an
executable application rather than a stable JavaScript library: modules are
internal unless a schema, CLI, protocol, or pack contract explicitly marks the
surface as versioned.

## Entrypoints

| File                                 | Responsibility                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/opencode-entry.mjs`         | `occtl` CLI plus `lab`/`opencode-lab` compatibility aliases, pinned Node bootstrap, lifecycle dispatch, project-contract approval, update/rollback, strict-mode dispatch |
| `scripts/opencode.mjs`               | thin launch coordinator: project preflight, launch identity, capability lease, child environment, and exact cleanup                                                      |
| `scripts/quality-controller.mjs`     | thin managed-run CLI that composes runtime, implementation, lifecycle, artifact, process, and operator-command modules                                                   |
| `scripts/managed-task.mjs`           | generic `/ship` and `/research` managed-task dispatch                                                                                                                    |
| `docker/agent-gateway/server.mjs`    | validate required gateway configuration and start the fixed-purpose gateway                                                                                              |
| `docker/notion-publisher/server.mjs` | restricted Notion create-content sidecar                                                                                                                                 |

## Host lifecycle modules

| Module                               | Contract                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lab/host-state.mjs`         | Resolve state/config roots and exact project state paths; explicit overrides must be absolute.                                    |
| `scripts/lab/workspace-registry.mjs` | Stable project IDs, one foreground registration, background membership, registration-token verification, atomic registry updates. |
| `scripts/lab/project-lifecycle.mjs`  | Recent/status formatting, exact empty-directory creation, project selection, verified foreground stop.                            |
| `scripts/lab/project-contract.mjs`   | Detect, validate, and explicitly write project contract v1.                                                                       |
| `scripts/lab/project-preflight.mjs`  | Git/runtime/adapter/preview/ignore/managed-run eligibility diagnostics shared by doctor and launch.                               |
| `scripts/lab/execution-adapters.mjs` | Node, Python, and monorepo install/verify execution plans.                                                                        |
| `scripts/lab/pack-loader.mjs`        | Validate schemas v1/v2 and materialize declared namespaced pack resources.                                                        |
| `scripts/lab/launch-snapshot.mjs`    | Truthful snapshot of volumes, profiles, writable runtime config, image pins, and stale-image warnings.                            |
| `scripts/lab/compatibility.mjs`      | Validate `versions.lock`, schemas, adapters, and optional real pinned runtime behavior.                                           |
| `scripts/lab/update-manager.mjs`     | Candidate staging, compatibility gates, state backup, atomic activation pointer, rollback.                                        |
| `scripts/lab/prune.mjs`              | Report legacy volumes and delete only explicit revalidated names with `--apply`.                                                  |
| `scripts/lab/checkpoint.mjs`         | User WIP checkpoint and rewind for the current workspace.                                                                         |
| `scripts/lab/background-ship*.mjs`   | Detached managed-run preparation, worker process, heartbeat, optional PR request.                                                 |
| `scripts/lab/fleet.mjs`              | Bounded-concurrency multi-job parent records and wait/status operations.                                                          |
| `scripts/lab/strict-doctor.mjs`      | Read-only Docker Sandbox backend prerequisites.                                                                                   |
| `scripts/lab/strict-run.mjs`         | Clean-clone sandbox creation and chat-only strict lease.                                                                          |
| `scripts/lab/strict-export.mjs`      | Signed bounded export and explicit exact-base adoption.                                                                           |
| `scripts/lab/launcher/*.mjs`         | Workspace selection/ownership, runtime config, capability scope, Docker orchestration, helper supervision, and OAuth relay.       |

Lifecycle modules must not read project-controlled approval state or expose
host registry/configuration paths to the container.

## Managed-run and quality modules

| Module                                          | Contract                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `scripts/quality/run-service-core.mjs`          | Durable records, locks, migrations, attempts, heartbeats, recovery refs, and external-action receipts.                 |
| `scripts/quality/run-service.mjs`               | Legacy migration, startup reconciliation, archival, and cleanup safety over the durable core.                          |
| `scripts/quality/controller-runtime.mjs`        | Atomic state, Git/process wrappers, budgets, leases, persistence, transitions, tracing, and notifications.             |
| `scripts/quality/controller-prepare.mjs`        | Project policy, route preflight, isolated worktree creation, context, memory, and idempotent preparation.              |
| `scripts/quality/controller-implementation.mjs` | Bounded agent/reviewer execution, telemetry, Dagger verification, refresh, and controller-owned implementation commit. |
| `scripts/quality/controller-lifecycle.mjs`      | Verification, independent review, risk evidence, and end-to-end execution phases.                                      |
| `scripts/quality/controller-artifacts.mjs`      | Artifact validation, release gate, finalization, adoption, and exact-SHA PR preparation.                               |
| `scripts/quality/controller-process.mjs`        | Resume, cancellation, process-group termination, archive, and safe cleanup.                                            |
| `scripts/quality/run-control.mjs`               | Exact result/review parsing, phase limits, telemetry accounting, bounded process execution/termination.                |
| `scripts/quality/implementation-checkpoint.mjs` | Stage and commit only declared safe changes; bind evidence to content SHA.                                             |
| `scripts/quality/durable-state.mjs`             | Redacted trace, chained checkpoints, queue, approvals, and bounded workspace memory.                                   |
| `scripts/quality/model-registry.mjs`            | Model lanes, routes, provider/family metadata, and policy validation.                                                  |
| `scripts/quality/reviewer-qualification.mjs`    | Evidence-backed reviewer trials and explicit manual promotion.                                                         |
| `scripts/quality/parallel-synthesis.mjs`        | Detect member failures and conflicts; never synthesize a failed group as ready.                                        |
| `scripts/quality/run-artifacts.mjs`             | Project/run-scoped artifact index and safe retention.                                                                  |
| `scripts/quality/run-notifications.mjs`         | Deduplicated project-scoped operator events.                                                                           |
| `scripts/quality/run-outcomes.mjs`              | Immutable outcome and operational metric records.                                                                      |
| `scripts/quality/run-view.mjs`                  | Evidence-linked operator view and state-aware allowed actions.                                                         |
| `scripts/quality-mcp/run-operations.mjs`        | Registered run lookup, managed/parallel starts, status views, and state-valid operator actions.                        |
| `scripts/quality-mcp/handler.mjs`               | Authenticated project-scoped MCP and `/runs`, notification, artifact, and action protocol.                             |
| `scripts/quality-lib.mjs`                       | Shared state transitions, IDs, routing, requirement inference, and release/risk gates.                                 |
| `scripts/dagger-quality.mjs`                    | Deterministic containerized verification boundary.                                                                     |

Normative lifecycle behavior is in [Managed runs](managed-runs.md). Tests under
`scripts/quality/*.test.mjs`, `scripts/quality-mcp/*.test.mjs`, and
`scripts/quality/controller-integration.test.mjs` are executable boundary
evidence.

## Gateway and relays

| Module                                      | Contract                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docker/agent-gateway/capability-lease.mjs` | Create/verify HMAC leases bound to workspace/project/session/run and route/action scope.           |
| `docker/agent-gateway/gateway.mjs`          | Request coordinator, credential injection, provider dispatch, and artifact staging.                |
| `docker/agent-gateway/gateway-models.mjs`   | Model registry normalization, provider payload compatibility, fallback, and Vertex token handling. |
| `docker/agent-gateway/gateway-routes.mjs`   | Fixed route definitions and route/action capability requirements.                                  |
| `docker/agent-gateway/gateway-http.mjs`     | Request bounds, headers, rate/concurrency limits, streaming, and error responses.                  |
| `docker/agent-gateway/artifact-network.mjs` | DNS/private-network policy and pinned HTTPS requests for bounded artifact downloads.               |
| `scripts/hound-relay.mjs`                   | Passive, bounded public-web MCP surface and filtered Hound upstream.                               |
| `scripts/github/publish-relay.mjs`          | Fixed GitHub status/push/PR operations using host authentication and current lease.                |
| `scripts/local-preview/*`                   | Fixed loopback preview readiness and ownership checks.                                             |
| `scripts/lab/browser-*-relay.mjs`           | Authenticated loopback browser verification/session actions.                                       |
| `scripts/openpets-relay.mjs`                | Fixed reaction enum only.                                                                          |
| `docker/notion-publisher/*`                 | Fixed target map and insert-content-only publication.                                              |

Normative routes and claims are in
[Gateway and capability protocol](gateway-protocol.md). A relay must not become
a generic proxy, shell, filesystem browser, or credential-forwarding endpoint.

## OpenCode configuration and TUI

| Path                               | Responsibility                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `opencode.json`                    | Provider/model/MCP configuration template consumed through generated runtime config.     |
| `.opencode/agents/`                | Product-neutral fixed lanes and workflow agents.                                         |
| `.opencode/commands/`              | Core slash-command prompt contracts and frontmatter.                                     |
| `.opencode/plugins/`               | Workflow menus, agent state, quality/run center, preferences, and tool lifecycle policy. |
| `.opencode/skills/`                | Generic safety, preview, project, and workflow instructions.                             |
| `.opencode/themes/`                | Provenance-classified public themes.                                                     |
| `scripts/opencode-tui-merge.mjs`   | Merge generated/project/pack UI resources without cross-project state.                   |
| `scripts/opencode-preferences.mjs` | Host-owned persistent approval/TUI preferences.                                          |
| `scripts/opencode-routing.mjs`     | One task-boundary route to a registered lane/agent.                                      |

Project-local `.opencode` files remain untrusted and are loaded only for the
selected project. External packs use the versioned contract in
[packs.md](packs.md).

## Schemas and versioned contracts

| Surface                             | Source of truth                                                      |
| ----------------------------------- | -------------------------------------------------------------------- |
| Project contract v1                 | `schemas/project-v1.schema.json`, `scripts/lab/project-contract.mjs` |
| Workflow pack v2 (v1 compatibility) | `schemas/pack-v2.schema.json`, `scripts/lab/pack-loader.mjs`         |
| Execution adapter v1                | `scripts/lab/execution-adapters.mjs`, `versions.lock`                |
| Durable run schema v1               | `scripts/quality/run-service.mjs`                                    |
| Capability lease v1                 | `docker/agent-gateway/capability-lease.mjs`                          |
| Implementation result v1            | `scripts/quality/run-control.mjs`                                    |
| Compatibility pins                  | `versions.lock`                                                      |
| Release provenance                  | `provenance/files.json`                                              |

Schema changes require migration/compatibility behavior and tests. Unknown
versions and fields fail closed unless a documented compatibility adapter
exists.

## Release and governance code

| Path                                     | Responsibility                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `scripts/release/provenance.mjs`         | Classify/hash every public release file.                                                                             |
| `scripts/release/export-public-tree.mjs` | Copy only classified files into a fresh clean-root export.                                                           |
| `scripts/release/module-budget.mjs`      | Enforce the 700-physical-line production-module ceiling from `quality/module-budget.json`.                           |
| `scripts/release/scan-history.mjs`       | Run Gitleaks and TruffleHog over every reachable ref tip.                                                            |
| `scripts/release/release-artifacts.mjs`  | Build release bundle/checksums.                                                                                      |
| `scripts/release/dogfood.mjs`            | Enforce distinct healthy dogfood repositories.                                                                       |
| `scripts/release/documentation.test.mjs` | Prevent documentation navigation, command/config coverage, local links, and critical module contracts from drifting. |

GitHub workflows are pinned to immutable action commits and cover sanity,
quality, Semgrep, provenance/dependencies, container SBOM/scanning, and secret
history. Paid model evaluations remain opt-in.

## Code documentation rule

Security-critical and lifecycle modules begin with a module contract that
states trust, authority, state ownership, invariants, and fail-closed behavior.
Export-level comments are expected when an exported function's preconditions,
side effects, idempotency, path handling, or return shape are not obvious from
its name and versioned reference.

When changing code:

1. update the module contract if an invariant changes;
2. update the relevant reference document;
3. add positive and adversarial tests at the changed boundary;
4. update schemas/migrations for versioned data;
5. regenerate and review provenance;
6. run `npm run check`, `npm run release:test`, and
   `npm run provenance:check`.
