# Public core and private extensions

OpenCode Command Center public core provides generic coding, planning, research, review,
preview, managed-run, safety, provenance, and release mechanisms. It does not
contain company strategy, customer data, destinations, brand assets, product
agents, proprietary evaluation cases, or operator credentials.

Private or company-specific behavior belongs in an external versioned pack
loaded through `docs/packs.md`. Packs are separately owned, distributed, and
supported. A pack may request only declared namespaced resources and supported
capabilities; it cannot replace core policy, approval state, credentials, or
gateway signing authority.

## Experimental limitations

- The `0.x` CLI, pack interface, state schemas, and supported OpenCode versions
  may change between minor releases with documented migrations.
- The supported launch target is macOS on Apple silicon with Docker Desktop and
  Node 24. Other hosts are community-supported until compatibility gates exist.
- Additional execution adapters and strict microVM isolation are incomplete
  until their roadmap phases land.
- Hound, OpenDesign, browser control, publishing relays, model evaluations, and
  paid providers are optional and are not required by the default profile.
- Generated changes require operator review. Quality scores and automated
  reviews are evidence, not proof of correctness or security.

## Telemetry

OpenCode Command Center has no outbound product telemetry in v0.x. It sends no product
analytics, usage telemetry, workspace names, source code, cost events, or agent
transcripts to the maintainers. Network traffic occurs only for
operator-selected model/tool providers, dependency and security databases,
container/package registries, and explicit publishing.
Those third parties have their own policies. A future telemetry proposal would
require an RFC, explicit opt-in, documented payloads, and a public implementation.
