---
description: Build and run the current workspace locally; publish preview ports for the Mac browser.
agent: lab
---

$ARGUMENTS

The user wants the mounted project running locally so they can open it on their Mac.

1. Load `/opencode-config/.opencode/skills/project-skills/SKILL.md` and follow any
   matching `/workspace/.opencode/skills/*/SKILL.md` (prefer `run-*-dev`).
2. Always follow `/opencode-config/.opencode/skills/local-preview/SKILL.md`.
3. If no workspace or loaded-pack run skill matches, do not infer a product
   runbook from the folder name.
4. Prefer `docker compose up -d --build` from `/workspace` when a compose file
   exists and maps `127.0.0.1:3100` / `127.0.0.1:3101` and the mount is an HTTP app.
5. Otherwise, for HTTP apps only, run:
   `node /opencode-config/scripts/local-preview/start.mjs start`
   Never use bare `npm run dev &` / `pnpm dev &`.
6. For HTTP preview apps, confirm with
   `node /opencode-config/scripts/local-preview/check.mjs` if needed and reply
   with Mac URLs (`http://127.0.0.1:3100` and/or `3101`).
7. For non-HTTP projects, report the CLI outcome instead of inventing preview URLs.

Never mention Codespaces, Gitpod, VS Code Ports, SSH tunnels, or cloning the repo.
Never send the user to localhost:3000/3001 for the app.
