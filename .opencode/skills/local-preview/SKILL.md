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

Never start an HTTP app with bare backgrounding:

- `npm run dev &`
- `pnpm dev &`
- `yarn dev &`
- any `… &` / `disown` improvisation without the Lab starter

Those die when the bash tool shell exits. Use `start.mjs` instead.

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

### B. Processes inside this Command Center container (default)

Use the durable Lab starter — it detaches, binds `0.0.0.0`, waits for the port,
and prints the Mac URL:

```bash
node /opencode-config/scripts/local-preview/start.mjs start
```

Useful variants:

```bash
node /opencode-config/scripts/local-preview/start.mjs status
node /opencode-config/scripts/local-preview/start.mjs stop
node /opencode-config/scripts/local-preview/start.mjs restart
node /opencode-config/scripts/local-preview/start.mjs start --cmd "pnpm exec next dev --hostname 0.0.0.0 --port 3000"
```

The Command Center `opencode-preview` relay (started by the host launcher) forwards
container `:3000`/`:3001` to host `3100`/`3101`.

3. Verify from inside the container (also run by `start.mjs` on success):

```bash
node /opencode-config/scripts/local-preview/check.mjs
```

4. Tell the user exactly which Mac URLs to open. Example:

```text
Open on your Mac:
- App:  http://127.0.0.1:3100
- UI:   http://127.0.0.1:3101
```

5. If start/check fails, read `/tmp/lab-preview/server.log` (or the path printed
   by `start.mjs`), fix bind address or `--cmd`, and retry once with
   `start.mjs restart`. Do not invent remote-IDE port-forward instructions.
   If the container port is up (`check.mjs` shows up) but the Mac URL still
   refuses to connect, the preview relay failed to publish 3100/3101 — tell the
   user to quit and relaunch `lab` (not just restart the app).

6. **Next.js dev through `:3100`:** the relay changes the browser origin (Mac
   `127.0.0.1:3100` vs container `:3000`). Next.js 16+ blocks dev HMR unless the
   Mac origin is in `allowedDevOrigins` (e.g. `127.0.0.1:3100`). Without it,
   client-only UI (autoplay video, hooks) may never hydrate — use `next start`
   for production-style preview, or add the origin and restart dev.

## Host launcher duty

The Mac launcher (`lab` / `occtl`) must keep `opencode-preview` running so
3100/3101 work for in-container servers when those host ports are free. Agents
should assume that relay exists after a normal Command Center start (or that a workspace
compose stack already publishes 3100/3101).
