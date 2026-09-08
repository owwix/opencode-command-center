# Threat model

## Security objective

OpenCode Command Center lets an untrusted coding agent modify one selected project without
giving that project or model general authority over host credentials, other
projects, private networks, publishing destinations, or Command Center policy.

## Trust boundaries

| Component                    | Trust                        | Authority                                                             |
| ---------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Host launcher/controller     | Trusted operator code        | Selects workspace, policy, capabilities, adoption, and publication    |
| Project and OpenCode process | Untrusted                    | Mounted project files and short-lived scoped lease only               |
| Model providers              | External/untrusted           | Receive bounded request context through the gateway                   |
| Fixed-purpose relays         | Privileged but narrow        | One protocol, route allowlist, action allowlist, and credential class |
| Optional packs               | Operator-approved extensions | Declared namespaced resources and capabilities only                   |
| Managed-run worktrees        | Untrusted isolated work      | One repository clone/worktree and bounded run state                   |

## Protected assets

- Cloudflare, model-provider, GitHub, Notion, and browser credentials;
- files outside the selected workspace and another project's persistent state;
- host helpers, Docker control, localhost, private networks, and metadata APIs;
- protected branches, publishing targets, approval policy, evidence, and exact
  verified implementation commits.

## Adversaries and failure modes

The design assumes project files, dependencies, retrieved web content, model
output, tool output, and optional pack content may contain malicious
instructions. It addresses prompt injection, credential discovery, path and
symlink traversal, private-network access, DNS rebinding, forged tool success,
cross-workspace state reuse, stale helper reuse, approval spoofing, unverified
publication, destructive shell actions, and runaway or abandoned processes.

## Enforced controls

- OpenCode receives a signed, short-lived lease bound to project, workspace,
  session/run, routes, actions, and expiry; it never receives signing authority.
- Agent egress crosses authenticated fixed-purpose relays. Direct unrestricted
  egress, private address ranges, metadata endpoints, and arbitrary downloads
  are denied.
- Configuration, caches, sessions, runtime state, helpers, and artifacts are
  namespaced and checked against project ID and workspace hash.
- Privileged operations remain approval-gated. Broad auto-approval cannot
  override hard denies, credential, network, or publishing boundaries.
- Managed output is adopted by a controller commit and verification, review,
  evidence, and publication bind to the exact implementation SHA.
- Deletion helpers validate exact targets and move recoverable data into a fresh
  recovery directory rather than recursively deleting broad paths.
- Public releases use an allowlisted, hashed tree, retained notices, a new root
  commit, and two history secret scanners.

## Assumptions

The operator controls the host account, Docker daemon, Command Center checkout, enabled
packs, and gateway configuration. Docker Desktop, macOS, model providers,
GitHub, package registries, pinned upstream images, and the host kernel remain
external trusted dependencies. A compromised host or Docker daemon is outside
the container boundary.

## Non-goals and residual risk

- This is not a hardened multi-tenant cloud sandbox or a substitute for a
  dedicated VM/microVM when executing hostile code.
- Model prompts and source excerpts sent to configured providers are subject to
  those providers' policies. Operators must not mount data they cannot disclose.
- Dependency and image scanners reduce known risk but cannot prove safety.
- `broad-auto` increases project-write risk and is never the public default.
- Optional Hound, OpenDesign, browser, publishing, and private packs add attack
  surface and remain disabled unless explicitly selected.
- Availability, model correctness, semantic review quality, and recovery from a
  compromised host are not guaranteed.

Security changes require tests that cross the affected boundary and update this
document when assumptions or residual risks change.
