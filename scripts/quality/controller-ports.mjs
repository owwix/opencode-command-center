/** Explicit module dependency contracts. Adding a capability requires updating
 * the owning contract; factories never receive a spread of the whole runtime. */
export const CONTROLLER_PORTS = Object.freeze({
  prepare:
    "atomicWriteJson controllerPackSet exec fail git harnessRoot idempotencyRoot limitsForLane limitsFromOptions loadContract loadRun preflightReviewPolicy qualityRoot readJson routingPolicyPath runPath saveRun selectRunModel withFileLockSync".split(
      " "
    ),
  implementation:
    "atomicWriteJson budgetBlocker clearPhaseProcess currentPhase fail git harnessRoot qualityRoot redactLog remainingBudgets runPath runsRoot saveRun selectRunModel setPhaseProcess transition writeHeartbeat".split(
      " "
    ),
  artifacts:
    "checkpointFailure checkpointImplementation contractName exec fail git harnessRoot loadRun qualityRoot readJson refreshRun runsRoot saveRun withWorkerLease".split(
      " "
    ),
  lifecycle:
    "applyValidatedManifest budgetBlocker checkpointFailure checkpointImplementation fail git loadRun prepare preflightReviewPolicy qualityRoot readJson refreshRun routingPolicyPath runDagger runOpenCode saveRun transition validateArtifactManifest withWorkerLease".split(
      " "
    ),
  process:
    "currentPhase exec fail loadRun preflightReviewPolicy qualityRoot readJson refreshRun review runOpenCode runPath saveRun transition verify withWorkerLease".split(
      " "
    )
});

/** @param {keyof typeof CONTROLLER_PORTS} name
 * @param {Record<string, unknown>[]} sources
 * @returns {Record<string, any>} */
export function controllerPorts(name, ...sources) {
  return Object.freeze(
    Object.fromEntries(
      CONTROLLER_PORTS[name].map((key) => {
        const owners = sources.filter((source) => Object.hasOwn(source, key));
        if (owners.length !== 1 || owners[0][key] === undefined)
          throw new Error(
            `Controller ${name} port ${key} must have exactly one owner.`
          );
        return [key, owners[0][key]];
      })
    )
  );
}
