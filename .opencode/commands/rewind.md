---
description: Rewind the workspace to a Command Center checkpoint id
---

$ARGUMENTS

If `$ARGUMENTS` is empty, list checkpoints first:

```bash
node /opencode-config/scripts/lab/checkpoint.mjs list
```

Otherwise rewind (this resets the worktree; a pre-rewind autosave checkpoint is
created when the tree is dirty):

```bash
node /opencode-config/scripts/lab/checkpoint.mjs rewind $ARGUMENTS
```

Report the checkpoint id restored. Never use this for production deploy rollback.
