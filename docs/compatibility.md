# Compatibility

`versions.lock` is the source of truth for OpenCode Command Center's supported runtime
combination. It binds the exact OpenCode and OpenDesign image digests, Hound and
Node versions, state schemas, and configuration-adapter fixtures used by this
checkout.

Run the offline source check after changing a pin, schema, adapter, Dockerfile,
or Compose file:

```bash
npm run compatibility:check
```

Before an update is promoted, exercise the real digest-pinned OpenCode binary
and the supported OpenCode configuration fixture in a networkless container:

```bash
npm run compatibility:runtime
```

The runtime probe may pull the public pinned image if it is absent locally. It
does not receive project files, credentials, or network access while loading
the compatibility fixture. Hound and OpenDesign remain optional profiles; the
default coding launch requires neither.

## Update and rollback

`occtl version` reports the checkout commit, compatibility lock, and active staged
release. `occtl update [--ref REF]` fetches an exact commit, creates a fresh
temporary checkout, pulls digest-pinned bases, builds every service under
commit-specific candidate tags, verifies the real candidate OpenCode binary and
configuration adapter without network access, and backs up host and persistent
volume state while sessions are stopped. Candidate session migrations are probed
on fresh volume copies with checksummed manifests. Only
after every step passes does it atomically switch the active-release pointer.

`occtl rollback` switches that pointer and image set back to the immediately
previous staged release after taking another state backup. If schema or OpenCode
version metadata differs, pre-upgrade state is restored into fresh volumes and
probed before activation. Newer volumes remain untouched. Host run records,
publishing receipts and security settings are not rewound. Releases,
backups, and failed unpublished managed work are never deleted by update or
rollback.

See [reliability evidence](reliability-implementation.md) for backup scope,
maintenance exclusion, optional-service limitations and runtime tests.
