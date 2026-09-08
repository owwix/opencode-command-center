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
4. Otherwise bind servers to `0.0.0.0:3000` / `0.0.0.0:3001` and rely on the Command Center preview relay.
5. Run `node /opencode-config/scripts/local-preview/check.mjs` and report the printed host URLs.
6. App previews use host 3100/3101 only.
