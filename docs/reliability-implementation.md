# Reliability implementation and evidence

This ledger describes implemented protections and verification scope, not a
production certification or a model-quality qualification.

## Managed execution and ownership

Both `run` and `task` launches are headless managed attempts. Controller run IDs
survive launch; session, attempt, Compose project and volume namespace are unique.
Interactive sessions alone claim foreground ownership. Managed Git inspection
uses a read-only metadata snapshot without source remotes, not a writable mount
of the source repository's common Git directory.

Normal exit stops only the attempt's services. Startup reconciliation stops
orphan containers only after checking a dead registered owner and exact Compose
project labels. Worktrees, volumes and evidence are retained. Orphan networks
may remain; this is not an automatic disk-retention policy.

Quality startup is serialized; competing launches never kill a live unhealthy
helper. Registrations select canonical workspace and pack roots independently.
Status, cancellation and listing remain project-scoped. Parallel replay keys
include canonical workspace and pack selection.

## Renewable authority

The host signs immutable launch-scoped 30-minute capabilities, renewing five
minutes before expiry. Per-launch opaque transport credentials are not signed
gateway authority. A fixed-destination transport reads the atomically replaced
lease per request and forwards to the loopback gateway. Neither signing keys nor
the lease directory are mounted into project code. Expired/missing leases fail
closed; existing streams can finish while later requests use renewed authority.
Renewal stops after bounded consecutive failures.

Tests simulate eight hours, rotation, expiry, immutable scope and stopped
sessions. Loopback transport tests cover cached client credentials and streaming.
These are accelerated tests, not an eight-hour wall-clock soak.

## Update and recovery

Updates require quiescent sessions, managed workers and selected volumes.
Maintenance locking excludes new launches. Persistent conversation, user-config
and optional-service volumes receive checksummed versioned backups; caches and
unrelated volumes are excluded. Candidate probes run on fresh copies, never the
only original. The real candidate OpenCode binary opens copied session state
without network access before activation.

Active releases retain logical-to-physical volume mappings and schema/version
metadata. Incompatible rollback restores pre-upgrade backups into new generations
and probes them with the previous image. Newer volumes, host run records,
publishing receipts and security settings are not overwritten. Failed probes
leave the current release active and preserve recovery material. Optional service
state is backed up but has no service-specific migration probe yet.

## Controller contracts and projections

Factories receive explicit validated dependency ports. Shared type contracts
describe identity, storage, runners, verification, publishing and capability
scope. TypeScript checking is incremental, not repository-wide.

`run.json` is authoritative. Revision-aware views repair from newer records and
reject stale backward updates. Artifact, notification and outcome projections
are rebuildable. Projection failure after an authoritative save warns rather
than pretending the transition failed and inviting duplicate external actions.
Publishing receipts bind to the exact verified/reviewed implementation SHA.

## Reproducible verification

Run with Node 24:

```sh
npm run check
npm run lint
npm run quality:eval:test
npm run provenance:check
npm run release:test
# Requires the local pinned OpenCode Docker image:
npm run test:runtime
```

The runtime suite uses real pinned OpenCode 1.18.18 with a deterministic local
OpenAI-compatible fixture, isolated networks and no paid-provider secrets.
Node, Python and monorepo cases exercise implementation, verification, review
and exact-SHA fake-GitHub PR preparation, including repeat preparation after
restart. Verification uses real local adapter commands, not production Dagger.
Additional cases exercise a foreground TUI alongside two managed containers,
cancelling one while the other finishes, provider-crash isolation, and real
Docker volume snapshot/restoration with session-database initialization.

The fixture controls responses: this tests plumbing, not model intelligence,
independent reviewer quality or live GitHub availability. Session recovery probes
an initialized database, not a long real conversation. Compatibility CI runs
these unpaid tests separately. Coverage thresholds apply to six selected boundary
modules, not the entire repository. `release:dogfood` reports preflight-only and
does not count as full workflow dogfooding.

External-user dogfooding, production soak tests, independent security reviews
and paid model qualification remain release evidence to collect. This working
tree does not claim those activities or a production deployment.
