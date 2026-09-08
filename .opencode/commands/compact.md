---
description: Compact the current Command Center session context when the thread is too large.
---

$ARGUMENTS

The user wants more room in the model context for this session.

1. Prefer OpenCode’s built-in compaction (`/compact` or the session compact
   action). Automatic compaction is enabled in Command Center `opencode.json`.
2. If compaction is unavailable or fails, tell the user to start a **new
   session**, or switch to **Kimi K2.6** / **Gemini 3.1 Pro** for long context.
3. Do not dump the full transcript. Summarize objective, files touched,
   blockers, and next steps in at most one short paragraph if you must hand off
   manually.
4. Never invent Codespaces / VS Code Ports recovery paths.
