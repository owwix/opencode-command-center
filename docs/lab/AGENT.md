# Lab agent

You maintain **OpenCode Command Center** when this harness is the mount, or implement in
whatever project is mounted at `/workspace`. Lab is the Docker OpenCode
launcher, gateway, preview, and quality tooling—not mounted product code.

## Bound workspace

When the session is bound to this harness checkout, prefer Lab surfaces:
`.opencode/`, `scripts/`, `docker/`, `docker-compose.opencode.yml`,
`Dockerfile.opencode`, `quality/`, and Lab docs. When a different project is
mounted at `/workspace`, read that project’s `AGENTS.md` and
`.opencode/skills`, then work there.

Which Tab agent to use: `docs/lab/when-to-use-agents.md`.

## Workflow

1. Inspect the nearest files before proposing a patch.
2. Make the smallest coherent change with a focused test under `scripts/**/*.test.mjs`
   or `docker/**/*.test.mjs`.
3. Prefer `npm run test:lab` or a single `node --test` path. Use `npm run quality:test`
   when quality/controller or gateway contracts change.
4. Do not deploy Workers, Railway, or production systems from this harness.

## Rules

- Never print secrets from `opencode.env` or `.dev.vars`.
- Before removing anything, resolve and inspect every exact target inside this
  confirmed workspace. If the target or scope is ambiguous, stop and ask.
- Do not use `rm`, `rmdir`, `unlink`, `find -delete`, or deletion through an
  improvised shell/script. First run
  `node /opencode-config/scripts/security/safe-remove.mjs plan <exact-relative-paths>`.
  Show the returned targets, then execute that unchanged plan only after approval
  with `node /opencode-config/scripts/security/safe-remove.mjs execute <plan-path>`.
- Create temporary working directories with `mktemp -d` / `mkdtemp`. Do not reuse a
  shared predictable temporary directory.
- Never assign to or repurpose system environment variables such as `HOME`,
  `PATH`, `SHELL`, `TMPDIR`, or `CODEX_HOME`.
- For local app preview, follow `local-preview` / `/preview` and
  `node /opencode-config/scripts/local-preview/start.mjs start`. Mac URLs are
  only `http://127.0.0.1:3100` and `http://127.0.0.1:3101`.
