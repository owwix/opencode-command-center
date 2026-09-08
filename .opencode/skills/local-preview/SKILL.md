---
name: local-preview
description: Universal skill for building and serving any mounted workspace locally in OpenCode Command Center, and opening it on the host Mac via fixed preview ports. Use whenever the user asks to run, start, build, preview, open locally, localhost, docker compose up, or access a dashboard/API from their browser. Never use Codespaces, Gitpod, VS Code Ports, or SSH tunnels.
---

# Local preview (universal)

This session runs inside OpenCode Command Center on Docker Desktop. The selected project is
already mounted at `/workspace`. Do not tell the user to clone it or install
tooling on their laptop.

## Host URLs (always)

| Inside Command Center container | Open on the Mac       |
| ------------------------------- | --------------------- |
| `0.0.0.0:3000`                  | http://127.0.0.1:3100 |
| `0.0.0.0:3001`                  | http://127.0.0.1:3101 |

- Prefer **3100** for the primary HTTP service (API or single app).
- Prefer **3101** for a second service (dashboard / frontend).
- Only loopback (`127.0.0.1`) on the host. Never publish `0.0.0.0` on the host.
- If the chat hits context limits, Command Center auto-compacts; users can also `/compact`.

## Forbidden

Never say:

- Forward port 3000/3001 in VS Code, Codespaces, or Gitpod
- `ssh -L ...`
- Clone the repo / `pnpm install` on the laptop as the primary path
- "I cannot fix Docker port mapping"
- Open `http://localhost:3000` or `http://localhost:3001` for the app

## Workflow

1. Read the project's README / compose / package scripts.
2. Start services using one of these patterns (smallest that works):

### A. Workspace `docker-compose.yml` (preferred when present)

Publish only loopback preview ports:

```yaml
ports:
  - "127.0.0.1:3100:3000"
  - "127.0.0.1:3101:3001"
```

Then:

```bash
docker compose up -d --build
```

If compose currently maps host `3000`/`3001`, fix it to `3100`/`3101` before starting.

### B. Processes inside this Command Center container

Bind every server to `0.0.0.0` on container ports **3000** and/or **3001**.
The Command Center `opencode-preview` relay (started by the host launcher) forwards those to
host 3100/3101. Prefer the repo's package manager (`pnpm` or `npm`).

3. Verify from inside the container:

```bash
node /opencode-config/scripts/local-preview/check.mjs
```

4. Tell the user exactly which Mac URLs to open. Example:

```text
Open on your Mac:
- App:  http://127.0.0.1:3100
- UI:   http://127.0.0.1:3101
```

5. If the check fails because nothing listens on 3000/3001, fix the server bind
   address or start command. Do not invent remote-IDE port-forward instructions.

## Host launcher duty

The Mac launcher (`npm run opencode`) must keep `opencode-preview` running so
3100/3101 work for in-container servers when those host ports are free. Agents
should assume that relay exists after a normal Command Center start (or that a workspace
compose stack already publishes 3100/3101).
