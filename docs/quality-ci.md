# Quality CI

OpenCode Command Center has two distinct checks. Keep them separate: one proves the
harness is internally consistent, and the other tells an operator whether this
Mac is ready to launch it.

## Pull-request checks

The `Agent Quality` workflow runs on pull requests and protected-branch pushes.
It uses Node 24, read-only repository access, and no model, Cloudflare,
deployment, Notion, or GitHub-write credentials. It should run:

```bash
npm run lint
npm run quality:modules
npm run typecheck
npm run quality:test
npm run quality:coverage
npm run quality:eval:test
```

`npm run quality:modules` scans production JavaScript/TypeScript under
`scripts/` and `docker/` and fails when a module exceeds the 700-line ceiling
in `quality/module-budget.json`. Tests, generated code, dependencies, and
vendored code are excluded. This is a maintainability boundary: add a focused
module instead of raising the ceiling.

The tests cover launcher policy, model routing, Docker/Compose contracts,
gateway boundaries, quality-controller state, TUI cache behavior, and the
offline Inspect contracts. They do not make paid model calls and do not build
Docker images as part of a health check.

`npm run typecheck` is an incremental JavaScript type-safety gate. It checks the
capability lease, gateway error surface, GitHub publishing boundary, OAuth
relay, module-budget scanner, preference persistence, preview launch policy,
and loopback health probe with TypeScript's `checkJs` mode. It also checks launch
identity, lease-session/transport and explicit controller ports/contracts. New
security or process boundaries should join this allowlist after their public
inputs and outputs have stable shapes. Expanding it is deliberate: enabling
strict checking over every legacy launcher file at once would turn the signal
into an unactionable migration backlog.

`npm run quality:coverage` uses Node's built-in test coverage and fails below
85% line, 60% branch, or 90% function coverage across six selected modules:
capability leases, GitHub publishing, preferences, preview policy, loopback health
and module budgets. This is not repository-wide coverage or the typecheck
allowlist. These are enforced thresholds rather than dashboard estimates.
Raise floors as boundary tests improve; do not lower them to land a change.

Durable-run tests additionally cover schema migration, stale-heartbeat startup
reconciliation, bounded retries and attempt history, restart-idempotent
external receipts, Git recovery refs, failed parallel synthesis, and cleanup
refusal for unpublished work. Background and fleet commands are compatibility
facades over that same service rather than independent state machines.

Run-control-center tests additionally prove canonical project scoping,
evidence-linked quality claims, unavailable-cost semantics, state-aware action
availability, no fixed TUI polling, distinct read/operate lease scopes, and
fixed-route credential forwarding. A read-only run lease cannot cancel,
approve, adopt, clean, or publish work.

Artifact and notification tests prove complete run-index coverage, exact patch
capture, project isolation, event deduplication, and conservative retention.
Retention can delete only an expired Command Center-owned cache and fails closed for
unpublished work; worktree artifacts and evidence indexes are not retention
targets.

`occtl doctor [path]` (or `npm run doctor` for the harness itself) is intentionally
not a CI replacement. It inspects the local
Docker daemon, local images, named volumes, writable runtime state, and the
running Quality MCP. It also reports the selected project's Git, runtime,
verification, port, local-ignore, and managed-run readiness. It never runs
`docker build`. A stale local image is a warning that says to run
`lab --rebuild`; it is not silently repaired by doctor.

## Metered evaluations

Run paid evaluation trials only from an explicitly enabled, protected workflow
or a disposable local environment. Store `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` as repository secrets, never in logs or fixtures. Keep
`AGENT_EVALS_ENABLED` disabled until there is an approved budget and a test
matrix. A passing trial informs routing; it does not automatically promote a
model or grant deployment authority.

## Release evidence

Before merging a harness change, record the exact commands and results in the
PR. For changes to the launcher or Compose file, include:

```bash
npm run doctor
npm run quality:modules
npm run typecheck
npm run quality:test
npm run quality:coverage
docker compose --env-file opencode.env -f docker-compose.opencode.yml config --quiet
```

If the Dockerfile or an image pin changed, run `lab --rebuild` explicitly and
repeat `npm run doctor`. The snapshot will then show the local image fingerprint
matching `Dockerfile.opencode` and its pinned OpenDesign runtime.

## Branch protection

Require the offline quality jobs before merge. Keep deployment, publishing,
credential rotation, and metered evaluations in separate protected workflows.
No CI job should receive a general-purpose personal token simply to make a
quality badge green.
