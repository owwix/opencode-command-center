---
name: browser-verify
description: Smoke-check Command Center preview or gallery URLs (HTTP, Playwright when available). Use after /preview or /gallery when the user wants proof the Mac URL loads.
---

# Browser verify

After a local preview is up on the Mac:

```bash
node /opencode-config/scripts/lab/browser-verify.mjs http://127.0.0.1:3100
node /opencode-config/scripts/lab/browser-verify.mjs http://127.0.0.1:3110
```

Inside the Command Center container this prefers the **host Playwright relay** on
`http://host.docker.internal:3111` (started with Command Center). That runs Chromium on the
Mac against loopback `3100`/`3101`/`3110`.

Host setup (once):

```bash
npm run lab:browser:setup
```

Prefer `/browser` after `/preview`. Never claim visual QA without this script’s
output (or an equivalent screenshot).
