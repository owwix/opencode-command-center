# Contributing

Thank you for improving OpenCode Command Center. Small, reviewable changes with executable
evidence are easiest to accept.

## Before opening a pull request

1. Open or reference an issue for behavior changes and use the RFC template for
   architecture, security-boundary, pack-contract, or compatibility changes.
2. Keep company-specific agents, destinations, themes, credentials, and
   evaluation cases out of public core. Use a versioned external pack.
3. Add tests for changed behavior and update the provenance inventory only
   after reviewing every new path.
4. Run `npm ci`, `npm run provenance:generate`, review the inventory diff, then
   run `npm run provenance:check`, `npm run release:test`, and `npm run check`.
5. Never include secrets, personal paths, generated runtime state, or private
   repository history.

## Documentation expectations

Behavior and documentation ship together. Update the closest entry in the
[documentation index](docs/README.md) when changing a command, flag,
environment variable, state/schema transition, gateway route, capability,
project contract, workflow-pack contract, execution adapter, or operator
workflow.

Architecture or security-boundary changes must update
`docs/architecture.md`, `docs/gateway-protocol.md` when applicable, and
`docs/threat-model.md`. Critical exported modules should begin with a concise
module contract describing trust, inputs, outputs, state ownership,
idempotency, and fail-closed behavior. Tests remain executable evidence, but do
not replace the public reference.

## Developer Certificate of Origin

All commits must include a `Signed-off-by` trailer certifying the
`DCO-1.1-Signed-off-by` terms in `DCO`. Add it with:

```bash
git commit -s -m "type(scope): concise change"
```

The sign-off is a legal certification, not a cryptographic signature. Do not
sign off a contribution you do not have the right to submit.

## Pull requests

- Explain the threat boundary and rollback for security-sensitive changes.
- Report exact tests and evidence; do not claim checks that were not run.
- Pin new actions and container inputs to immutable commits or digests.
- Preserve Apache-2.0 headers and all applicable third-party notices.
- Expect maintainers to request changes or decline work outside the public core.

Participation is governed by `CODE_OF_CONDUCT.md`. Security reports follow
`SECURITY.md` rather than the public issue tracker.
