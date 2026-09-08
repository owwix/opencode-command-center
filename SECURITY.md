# Security policy

## Supported versions

OpenCode Command Center is pre-1.0 software. Security fixes are provided only for the most
recent tagged `0.x` release and the current `main` branch. Older tags, private
packs, downstream forks, and unpinned local modifications are unsupported.

| Version        | Supported   |
| -------------- | ----------- |
| latest `0.x`   | Yes         |
| `main`         | Best effort |
| older releases | No          |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
**Security → Report a vulnerability** flow for `owwix/opencode-lab`. If that
flow is unavailable, contact the maintainer through the private contact method
on the maintainer's GitHub profile and ask for a secure reporting channel. Do
not send exploit details or credentials in the initial message.

Include the affected version or commit, impact, reproduction steps, relevant
configuration, and whether credentials or external systems may be exposed. Use
synthetic credentials in reproductions.

We aim to acknowledge complete reports within 7 days, provide an initial
assessment within 14 days, and coordinate disclosure after a fix is available.
These are goals, not service-level guarantees.

## Scope

In scope:

- capability leases, gateway and relay authorization;
- workspace, network, credential, helper, and persistent-state isolation;
- managed-run adoption, verification, publishing, and destructive-action
  boundaries;
- release provenance and public/private pack separation.

Out of scope: social engineering, denial of service against third-party model
providers, vulnerabilities already fixed on `main`, and reports requiring real
credentials or access to another person's systems.

See `docs/threat-model.md` for assumptions and explicit non-goals.
