---
description: Open the Command Center gallery for image artifacts under artifacts/marketing
---

Run:

```bash
node /opencode-config/scripts/artifacts/list-gallery.mjs
```

Tell the user:

1. Open `http://127.0.0.1:3110` in their Mac browser (Command Center gallery; loopback only).
2. Or open any printed `/file/...` URL from that list.

Never invent ports other than `3110`. Never link files outside
`artifacts/marketing/`.
