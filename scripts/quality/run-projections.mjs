import { syncControllerRun } from "./run-service.mjs";
import { buildRunArtifactIndex } from "./run-artifacts.mjs";
import { syncRunNotifications } from "./run-notifications.mjs";
import { recordRunOutcome } from "./run-outcomes.mjs";

/** Rebuildable views only: this function never executes an agent or publishes. */
export function rebuildRunProjections({ root, run }) {
  const durable = syncControllerRun({ root, run });
  const artifactIndex = buildRunArtifactIndex({
    root,
    durable,
    controller: run
  });
  syncRunNotifications({ root, durable, controller: run, artifactIndex });
  recordRunOutcome({ root, run });
  return { durable, artifactIndex };
}
