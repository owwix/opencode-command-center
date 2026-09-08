# Project contract v1

OpenCode Command Center can describe a repository with the optional tracked file
`.opencode-lab/project.json`. The contract is project metadata; it contains no
credentials, approval policy, host paths, or executable shell strings.

Run `occtl init [path]` to inspect an auto-detected contract. Add repeatable
`--pack <id>` flags to explicitly enable configured packs for this project. The
command prints the complete candidate before asking for approval. It writes
nothing unless the interactive answer is exactly `yes`, or the caller
explicitly passes `--yes`. An existing contract is validated and displayed but
never overwritten.

```bash
occtl init ~/Projects/example
occtl init ~/Projects/example --pack example-pack --yes
```

## Schema

Schema v1 is published at
[`schemas/project-v1.schema.json`](../schemas/project-v1.schema.json). Every
written contract includes:

- `install`: bounded argv-based dependency commands.
- `verify`: bounded argv-based deterministic checks.
- `development`: bounded argv-based local development commands, with optional
  relative working directories and non-secret environment values.
- `previewPorts`: only container `3000`/`3001` to host `3100`/`3101`.
- `artifactRoots`: unique relative paths that cannot leave the repository.
- `riskLevel`: `low`, `standard`, or `high`.
- `enabledPacks`: explicit IDs from the host-configured pack allowlist.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/owwix/opencode-lab/main/schemas/project-v1.schema.json",
  "schemaVersion": 1,
  "install": [{ "name": "npm", "argv": ["npm", "ci"] }],
  "verify": [{ "name": "check", "argv": ["npm", "run", "check"] }],
  "development": [
    {
      "name": "app",
      "argv": ["npm", "run", "dev"],
      "env": { "HOST": "0.0.0.0", "PORT": "3000" }
    }
  ],
  "previewPorts": [{ "name": "primary", "container": 3000, "host": 3100 }],
  "artifactRoots": ["artifacts"],
  "riskLevel": "standard",
  "enabledPacks": []
}
```

Commands are argv arrays so Command Center does not need a shell to interpret them. This
schema does not make project-owned commands trusted: later execution remains
subject to preflight, the selected approval mode, hard denies, scoped
capabilities, and verification policy.

## Launch preflight

`occtl open` and `occtl doctor [path]` evaluate the same project preflight. It
checks Git metadata and cleanliness, the declared runtime/package manager,
verification commands, fixed preview ports, repository-local ignore rules, and
managed-run eligibility. Opening an empty directory remains supported, but
managed work requires a clean Git repository and at least one verification
command. An executable not present in the current Node/npm/pnpm Command Center adapter is
a launch error with an actionable diagnostic; additional language adapters are
versioned separately.

Opening a Git project may add `/.quality/` and `/.opencode-user/` to that
repository's `.git/info/exclude`. This is local metadata and never changes the
project's tracked `.gitignore` or contract.

## Detection

When the file is absent, Command Center detects a read-only in-memory contract from bounded
root-level signals. It recognizes npm, pnpm, Yarn, Bun, uv, Poetry, pip,
JavaScript package scripts, Python tests, standard artifact directories, fixed
preview ports, and conservative high-risk directory names. Detection never
writes the repository.

A detected contract enables no external packs. This keeps generic repositories
product-neutral even when the host has private packs configured. Use
`occtl init --pack <id>` to opt a project in. `enabledPacks` is authoritative: an
empty list disables all packs, and an unavailable ID blocks launch instead of
silently loading another pack.

## Safety properties

- Unknown schema fields and versions fail closed.
- The workspace, `.opencode-lab` directory, manifest, and detected package JSON
  must be real local files/directories; symlink escapes are rejected.
- Paths are relative and traversal-free; command arguments and environment
  values are bounded and single-line.
- `occtl init` creates one exact file atomically and refuses overwrite.
- Launch state, preferences, caches, and run records remain in host-owned Command Center
  state rather than the selected repository.
- Missing credential files are never created as Docker mount placeholders.
- Project code cannot use this file to change host approval state, credentials,
  gateway routes, network policy, or hard denies.
