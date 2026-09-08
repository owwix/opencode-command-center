# Clean public release

The working repository remains private and retains its complete development
history. Public releases are built from an allowlisted, provenance-checked tree
with a new root commit; the private repository is never force-pushed or
rewritten.

## Prepare a candidate

Use a freshly created temporary directory, then run:

```bash
npm run provenance:check
npm run release:export -- /absolute/path/to/empty/candidate --init
```

The exporter refuses the filesystem root, home directory, private repository,
directories inside the private repository, and non-empty destinations. It
copies regular files listed in `provenance/files.json`, rejects credential and
runtime paths, preserves file modes, and verifies that `--init` created exactly
one commit.

Run both history scanners inside the candidate before publishing:

```bash
cd /absolute/path/to/empty/candidate
npm run secrets:history
```

The public remote must be empty. Never push the private repository's refs to the
public remote. Repository creation, renaming an existing remote, changing
visibility, or pushing the candidate remains a separate, explicit owner action.

## Beta tags

Release tags must be annotated and signed. The tag workflow refuses lightweight
or unsigned tags, reruns the release suite and real compatibility probe, exports
only the provenance inventory, and publishes checksums, SBOMs, OCI provenance,
and signed GitHub attestations. Review `migrations/manifest.json` and the exact
version's file in `docs/release-notes/` before creating the tag.

Example owner action after all release gates pass:

```bash
git tag -s v0.1.0-beta.1 -m "OpenCode Command Center v0.1.0-beta.1"
git push public v0.1.0-beta.1
```

## Provenance rule

`provenance/files.json` is an exact, hashed inventory of the release tree.
`original` files are Apache-2.0 contributions. `attributed-upstream` files retain
their source license and notice. `unknown` is a hard release failure. Generate a
new inventory only after reviewing new paths:

```bash
npm run provenance:generate
git diff -- provenance/files.json
npm run provenance:check
```
