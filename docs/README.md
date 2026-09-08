# OpenCode Command Center documentation

This directory documents the public, product-neutral OpenCode Command Center core. Start
with the quick start in the repository [`README.md`](../README.md), then use
this page as the documentation index.

## Learn the system

1. [Architecture](architecture.md) — components, trust boundaries, data flow,
   state ownership, and extension points.
2. [Codebase reference](code-reference.md) — entrypoints, lifecycle modules,
   managed-run internals, relays, schemas, and release code.
3. [First project tutorial](tutorial.md) — install Command Center, open a project, run a
   verified change, inspect evidence, and prepare a pull request.
4. [CLI and configuration reference](cli-reference.md) — lifecycle commands,
   profiles, approval modes, slash commands, environment variables, and exit
   behavior.
5. [Project contract](project-contract.md) — optional
   `.opencode-lab/project.json` schema and auto-detection.
6. [External workflow packs](packs.md) — versioned agents, commands, services,
   models, contracts, and artifacts.

## Operate and extend Command Center

- [Managed runs](managed-runs.md) — state machine, isolation, verification,
  review, evidence, adoption, recovery, retention, and `/runs` operations.
- [Gateway and capability protocol](gateway-protocol.md) — lease claims,
  authenticated routes, credential boundaries, and relay requirements.
- [Execution adapters](execution-adapters.md) — Node, Python, and monorepo
  verification plans.
- [Compatibility and updates](compatibility.md) — pinned components, staged
  updates, backups, and rollback.
- [Strict microVM mode](strict-mode.md) — clone-isolated Docker Sandbox runs,
  signed export, and explicit adoption.
- [Workspace agents](lab/workspace-agents.md) — project-local agents and
  skills.
- [When to use agents](lab/when-to-use-agents.md) — fixed model lanes and
  workflow-agent selection.

## Quality and security

- [Threat model](threat-model.md)
- [Agent safety](agent-safety.md)
- [Agent quality](agent-quality.md)
- [Quality CI](quality-ci.md)
- [Review metrics](review-metrics.md)
- [Public/private product boundary](product-boundary.md)
- [Public release process](public-release.md)

Repository-level policies live in [`SECURITY.md`](../SECURITY.md),
[`SUPPORT.md`](../SUPPORT.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md), and
[`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md).

## Integrations

- [Cloudflare AI Gateway](cloudflare-ai-gateway.md)
- [Restricted Notion publisher](notion-publisher.md)

## Releases and governance

- [Beta program](beta-program.md)
- [Release notes](release-notes/v0.1.0-beta.1.md)
- [RFC template](rfcs/0000-template.md)
- [`CHANGELOG.md`](../CHANGELOG.md)

## Documentation contract

Behavior-changing pull requests must update the closest reference above. A
change to a security boundary must also update the threat model and include a
boundary-crossing test. A change to a CLI command, environment variable,
durable schema, gateway route, pack schema, or project contract is incomplete
until its reference and examples match the executable implementation.
