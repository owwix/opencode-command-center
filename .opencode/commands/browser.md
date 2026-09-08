---
description: Verify the Mac preview or gallery URL in a browser-like smoke check
---

$ARGUMENTS

Run:

```bash
node /opencode-config/scripts/lab/browser-verify.mjs $ARGUMENTS
```

Default targets are `http://127.0.0.1:3100` and `http://127.0.0.1:3101`.
Inside Command Center, the script prefers the host Playwright relay at
`http://host.docker.internal:3111` (Chromium on the Mac). You may also pass
`http://127.0.0.1:3110` for the gallery when it is up.

Report status, title, timing, mode (`playwright`/`http`/`relay`), and any
screenshot path under `artifacts/lab-browser/`. Do not invent other ports.
