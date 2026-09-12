# Known issues and regressions

This page records **operator-visible failures** seen in recent Lab sessions and
what Command Center does so they do not recur silently.

For day-to-day use, see the [User guide](../user-guide.md) troubleshooting
section.

## Error registry

| Symptom                                                                | Cause                                                                          | Prevention in harness                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cannot click** Ctrl+P, permissions, or lists in TUI                  | Lab previously forced `mouse: false` for clipboard                             | Default `mouse: true` in `.opencode/tui.json`; merge no longer disables mouse; bump `OPENCODE_TUI_INIT_VERSION` on change. Relaunch `lab` after updates. |
| **Mac `3100` connection refused** while app is up in container         | Preview relay on Docker `internal: true` network never published host ports    | `preview-ingress` network in compose; launcher verifies `3100`/`3101` after `up` and throws if missing.                                                  |
| **Preview dies** after agent runs `npm run dev &`                      | Background job tied to tool shell                                              | Durable `start.mjs` (`nohup` + pid/log); skills/commands forbid bare `&`.                                                                                |
| **Next.js page loads but client UI frozen** (video poster, hooks dead) | `next dev` through `:3100` — HMR WebSocket blocked without `allowedDevOrigins` | Preflight warns (`next-preview`); `start.mjs` prints hint; workflow menu note; user guide documents fix.                                                 |
| **Tab cannot start research/design**                                   | Optional stacks are launch-time only                                           | `/workflow` and `/agents-help` say to quit and relaunch with `--with-research` / `--with-design`.                                                        |
| **Stale OpenCode image** after Dockerfile change                       | Doctor does not auto-build                                                     | `occtl doctor` warns when image fingerprint mismatches; use `occtl open --rebuild`.                                                                      |
| **CI red on format**                                                   | Unformatted commits on `main`                                                  | Run `npm run format` before push; Sanity Check runs `oxfmt --check`.                                                                                     |

## Operator checks

Before blaming the mounted project:

```bash
occtl doctor /path/to/project   # host + project preflight
node /opencode-config/scripts/local-preview/check.mjs
```

Preflight for **Next.js** projects should show:

```text
PASS Next.js allowedDevOrigins covers Lab preview (127.0.0.1:3100).
```

If you see `WARN next-preview`, add to `next.config`:

```js
allowedDevOrigins: ["127.0.0.1:3100", "127.0.0.1"],
```

Then `start.mjs restart` and reload `http://127.0.0.1:3100`.

## Regression tests

| Area                    | Test file                                    |
| ----------------------- | -------------------------------------------- |
| Preview ingress network | `scripts/quality/security-boundary.test.mjs` |
| TUI mouse defaults      | `scripts/opencode-tui-merge.test.mjs`        |
| Durable preview starter | `scripts/local-preview/start.test.mjs`       |
| Next.js preview origins | `scripts/lab/preview-readiness.test.mjs`     |
| Tool profile flags      | `scripts/opencode-tooling.test.mjs`          |

Run locally:

```bash
npm run test:lab
```

## Reporting new issues

If a failure repeats after the prevention above:

1. Note whether you used `lab` / `occtl open` (not host `opencode`).
2. Capture `occtl doctor` output and `/tmp/lab-preview/server.log` when preview-related.
3. File an issue with repro steps and Mac URL used (`3100`/`3101` only).

Behavior-changing fixes must update this page and add or extend a regression test
when practical.
