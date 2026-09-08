# Agent filesystem safety

These rules apply to every modifying OpenCode profile and managed run.

Approval policy is selected by the host launcher and mounted read-only into the
agent container. The public default is `safe-auto`; `ask` disables automatic
replies, and `broad-auto` expands non-shell automation only. No mode can
auto-approve shell execution, credentials, publishing, external directories, or
hard-denied tools. Change it from the host with
`lab --approval-mode ask|safe-auto|broad-auto`, never from project code.

## Private GitHub workflow

GitHub authentication remains on the host. The agent can use the scoped
GitHub tools to inspect the selected workspace's origin, list or view pull
requests and issues, and—after an explicit approval—push a reviewed branch,
open a pull request, create an issue, or add a comment. The relay always binds
the operation to the current workspace origin; it does not expose a GitHub
token, SSH key, `gh` session, arbitrary GitHub API endpoint, force push, or
protected-branch write to the agent container.

- Resolve and inspect every exact deletion target inside the confirmed workspace
  before acting. Stop and ask when the target or scope is ambiguous. Never target
  the workspace root, a home directory, or anything outside the workspace.
- Raw removal commands and improvised deletion scripts are prohibited. Create a
  bound plan with
  `node /opencode-config/scripts/security/safe-remove.mjs plan <exact-relative-paths>`,
  show its exact targets, and execute that unchanged plan only after approval with
  `node /opencode-config/scripts/security/safe-remove.mjs execute <plan-path>`.
  Execution moves unchanged targets into a fresh `.agent-trash` recovery directory.
- Create scratch directories with `mktemp -d`, `mkdtemp`, or the platform
  equivalent. Never reuse a shared predictable temporary path.
- Never assign to or repurpose system environment variables such as `HOME`, `PATH`,
  `SHELL`, `TMPDIR`, or `CODEX_HOME`. Use a task-specific variable name.
- Prefer recoverable actions. If secure irreversible erasure is genuinely required,
  stop and obtain explicit authority for that separate operation.
- The selected project is already mounted at `/workspace`. Do not instruct the
  user to clone it or install dependencies on their laptop.
- For local run/preview of any project, follow
  `/opencode-config/.opencode/skills/local-preview/SKILL.md` and `/preview`.
  Bind app servers to container `0.0.0.0:3000` / `0.0.0.0:3001` (or publish
  `127.0.0.1:3100` / `127.0.0.1:3101` from workspace compose). Tell the user to
  open only `http://127.0.0.1:3100` and `http://127.0.0.1:3101` on the Mac.
  Never mention Codespaces, Gitpod, VS Code Ports, or SSH tunnels.
