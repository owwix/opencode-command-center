import { randomUUID } from "node:crypto";

export function allowedChromeOrigin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Specify an exact origin, without a path or credentials.");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Connected Chrome requires HTTPS (or localhost HTTP).");
  return url.origin;
}

export function validateChromeOperation(input, origins) {
  const fields = {
    snapshot: [],
    screenshot: [],
    navigate: ["url"],
    click: ["selector"],
    type: ["selector", "text"],
    press: ["key"]
  };
  if (!input || !Object.hasOwn(fields, input.operation))
    throw new Error("Unsupported Chrome operation.");
  if (
    Object.keys(input).some(
      (key) => !["operation", ...fields[input.operation]].includes(key)
    )
  )
    throw new Error("Unexpected Chrome argument.");
  for (const key of fields[input.operation]) {
    if (
      typeof input[key] !== "string" ||
      input[key].length > 4000 ||
      (key !== "text" && !input[key])
    )
      throw new Error(`Invalid ${key}.`);
  }
  if (input.operation === "navigate") {
    const url = new URL(input.url);
    if (url.username || url.password || !origins.includes(url.origin))
      throw new Error("Origin is not approved.");
  }
  if (
    input.operation === "press" &&
    ![
      "Enter",
      "Tab",
      "Shift+Tab",
      "Escape",
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
      "Space",
      "Home",
      "End",
      "PageDown",
      "PageUp"
    ].includes(input.key)
  )
    throw new Error("Browser/OS shortcuts are not permitted.");
  return structuredClone(input);
}

// Host approval is mandatory even when the agent's own approval mode is broad-auto.
export function createChromeController({
  projectId,
  workspaceHash,
  origins,
  adapter,
  approve,
  now = Date.now
}) {
  const expiresAt = now() + 30 * 60 * 1000;
  const seen = new Set();
  let owner = null,
    busy = false,
    revoked = false;
  function check(scope) {
    if (
      revoked ||
      now() >= expiresAt ||
      !scope ||
      !Number.isFinite(scope.exp) ||
      scope.exp * 1000 <= now()
    )
      throw new Error("Chrome connection or launch lease expired.");
    if (
      scope.projectId !== projectId ||
      scope.workspaceHash !== workspaceHash ||
      !scope.sessionId ||
      scope.runId
    )
      throw new Error("Chrome workspace/foreground scope mismatch.");
    if (owner && scope.sessionId !== owner)
      throw new Error("Chrome is controlled by another launch.");
  }
  return {
    async run({ scope, requestId, input }, active = () => true) {
      check(scope);
      if (busy)
        throw new Error("Chrome is busy; concurrent control is not allowed.");
      if (
        typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(requestId) ||
        seen.has(requestId)
      )
        throw new Error("Invalid or already consumed Chrome request.");
      const operation = validateChromeOperation(input, origins);
      busy = true;
      seen.add(requestId);
      try {
        const approved = await approve({
          requestId,
          sessionId: scope.sessionId,
          origins,
          ...operation
        });
        check(scope);
        if (!active())
          throw new Error("Chrome requester disconnected before approval.");
        if (!approved) throw new Error("Host approval rejected or timed out.");
        owner = scope.sessionId;
        return await adapter.perform(operation);
      } finally {
        busy = false;
      }
    },
    revoke() {
      revoked = true;
    },
    id: randomUUID()
  };
}
