import { createHash, randomUUID } from "node:crypto";

/** Resolve execution ownership once; downstream services must not infer it from argv. */
export function createLaunchSpec(args, environment = process.env) {
  const command = args[0];
  const managed = command === "run" || command === "task";
  const maintenance = command === "notion:start" || command === "mcp";
  if (
    environment.OPENCODE_NON_INTERACTIVE === "1" &&
    !managed &&
    !maintenance
  ) {
    throw new Error(
      "Non-interactive launches require an explicit run or task command."
    );
  }
  const phase = environment.LAB_PHASE ?? "implementation";
  const runId =
    environment.LAB_RUN_ID || `run_${randomUUID().replaceAll("-", "")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/u.test(runId)) {
    throw new Error("Invalid managed run identity.");
  }
  const attemptId = `attempt_${randomUUID().replaceAll("-", "")}`;
  const resourceId = createHash("sha256")
    .update(`${runId}:${attemptId}`)
    .digest("hex")
    .slice(0, 24);
  return Object.freeze({
    kind: managed
      ? phase.startsWith("review")
        ? "managed-review"
        : "managed-implementation"
      : maintenance
        ? "maintenance"
        : "interactive",
    managed,
    dockerRunArguments: managed
      ? [
          "-T",
          "-e",
          "GIT_DIR=/run/managed-git",
          "-e",
          "GIT_WORK_TREE=/workspace",
          "-e",
          "GIT_OPTIONAL_LOCKS=0"
        ]
      : [],
    foreground: !managed && !maintenance,
    runId,
    attemptId,
    sessionId: `session_${randomUUID().replaceAll("-", "")}`,
    composeProject: managed ? `opencode-lab-run-${resourceId}` : "opencode-lab",
    stateNamespace: managed ? `run_${resourceId}` : null
  });
}
