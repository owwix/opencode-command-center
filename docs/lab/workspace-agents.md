# Workspace agents (project-local)

OpenCode Command Center loads **two** agent sources:

1. **Project** — `/workspace/.opencode/agents/*.md` (cwd is the mounted repo)
2. **Harness** — `OPENCODE_CONFIG_DIR=/opencode-config/.opencode` (Lab)

OpenCode discovers project `.opencode` unless `OPENCODE_DISABLE_PROJECT_CONFIG` is
set (Lab must leave that unset). Harness agents load **after** project agents, so
for the same name the **Lab harness wins**.

## Reserved harness names

Do not redefine these in a project (Lab would override anyway):

`fast`, `lab`, `deep`, `plan`, `reviewer`, `dispatcher`, `research`

## External pack agents

Versioned packs may contribute additional agents, commands, skills, themes, and
managed-run kinds. The launcher materializes only manifest-declared files into a
fresh host-owned config directory for that launch. See `docs/packs.md`.

## Adding a project agent

1. Create `/workspace/.opencode/agents/<name>.md` with OpenCode frontmatter.
2. Avoid reserved harness names.
3. Prefer product doctrine here; keep mount/preview/safety skills in Lab or
   project `skills/` (see `author-project-skill`).
