---
description: Save a rewindable Command Center checkpoint of the current workspace WIP
---

Create a checkpoint of the mounted workspace:

```bash
node /opencode-config/scripts/lab/checkpoint.mjs create "$ARGUMENTS"
```

Show the returned id and tell the user they can `/rewind <id>` later. Do not
rewrite history or force-push.
