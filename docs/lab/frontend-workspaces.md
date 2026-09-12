# Frontend workspaces

For an npm project using Docker, prepare Linux-native dependencies on the host:

```sh
node scripts/lab/node-dependencies.mjs /absolute/project
```

The installer reads only package.json and package-lock.json, allows integrity-pinned
public npm registry packages, and disables lifecycle scripts. It receives neither
source code nor host credentials. A fresh project-scoped volume is mounted read-only
at /workspace/node_modules on the next interactive launch. Lock changes fail closed
until preparation is repeated; old volumes are retained, not automatically deleted.
Private registries, workspace links and script-dependent packages require a separately
reviewed installation path. Managed worktrees are separate identities and are not
automatically provisioned by this command.

The runtime image includes Alpine Chromium. Playwright projects can use
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH instead of downloading a glibc browser binary.
Host browser-session support uses the pinned Playwright dependency; host browser
binaries may require the normal Playwright installation step.

The generic `/visual-review` command uses a read-only image-capable agent. Attach
actual images; a path in text is not visual evidence. The runtime image-input test
checks PNG bytes reach a local deterministic provider, without paid model calls.
This validates transport, not visual model quality or production provider access.

Keep repository-specific verification and visual expectations in AGENTS.md and
the project contract. Browser tests should avoid production forms and credentials.
