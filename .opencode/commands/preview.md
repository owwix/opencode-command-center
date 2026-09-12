---
description: Build or start the mounted workspace and open it on the Mac via 3100/3101
agent: lab
---

$ARGUMENTS

Use the universal local-preview skill at
`/opencode-config/.opencode/skills/local-preview/SKILL.md`.
Use a matching workspace or loaded-pack run skill when one is present.

Goal: start the project in `/workspace` and give the user Mac URLs that work.

Rules:

1. Follow the local-preview skill exactly (and project skill when applicable).
2. Never mention Codespaces, Gitpod, VS Code Ports, or SSH tunnels.
3. Prefer workspace `docker compose up -d --build` with `127.0.0.1:3100` / `127.0.0.1:3101`.
4. Otherwise start the durable in-container preview:
   `node /opencode-config/scripts/local-preview/start.mjs start`
   Never use bare `npm run dev &` / `pnpm dev &` — those die when the tool shell exits.
5. On success, report the printed Mac URLs (`http://127.0.0.1:3100` / `3101`).
6. If start fails, check `/tmp/lab-preview/server.log`, fix once with
   `start.mjs restart` or `--cmd`, then stop. App previews use host 3100/3101 only.
