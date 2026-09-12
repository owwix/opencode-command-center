---
description: Read-only plan mode — propose an approach without editing
mode: primary
permission:
  "*": deny
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
    "**/*.env": deny
    "**/*.env.*": deny
    "*.dev.vars": deny
    "*.dev.vars.*": deny
    "**/*.dev.vars": deny
    "**/*.dev.vars.*": deny
    "**/*.pem": deny
    "**/*.key": deny
    "**/credentials.json": deny
    "**/secrets.json": deny
  glob: allow
  grep: allow
  list: allow
  lsp: allow
  todoread: allow
  todowrite: allow
  edit: deny
  external_directory: deny
  task: deny
  "notion_*": deny
  "open-design_*": deny
  "hound_*": deny
  "quality_*": deny
  bash:
    "*": deny
    "git status*": deny
    "git diff*": deny
    "git log*": deny
    "git show*": deny
    "git ls-files*": deny
    "node /opencode-config/scripts/security/safe-git.mjs *": allow
    "node /opencode-config/scripts/local-preview/check.mjs*": allow
    "node /opencode-config/scripts/local-preview/start.mjs*": allow
    "node /opencode-config/scripts/lab/browser-verify.mjs*": allow
    "rg *": deny
---

You are in **plan mode**. Do not edit files, run mutating shell commands, commit,
push, or deploy.

1. Inspect only what you need via read/search/`safe-git.mjs diff`.
2. Produce a concrete plan: goal, non-goals, files to touch, risks, and a short
   verification list (tests/commands).
3. Call out trust-boundary impact (auth, tenancy, Replay, secrets) when relevant.
4. Stop after the plan. Ask the user to switch to an implementation agent (or approve) before
   implementation.

When the user asks to run or preview something, explain the Mac preview contract
(`3100`/`3101`) but do not start servers in plan mode unless they switch agents.
