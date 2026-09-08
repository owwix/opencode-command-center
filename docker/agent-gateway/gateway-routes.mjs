import { assertCapabilityScope } from "./capability-lease.mjs";
import { GatewayPolicyError } from "./gateway-errors.mjs";
import { parseJson } from "./gateway-http.mjs";
import { vertexOpenAiUrl } from "./gateway-models.mjs";

export const GATEWAY_CAPABILITIES = Object.freeze([
  "chat",
  "openai-chat",
  "vertex-chat",
  "image",
  "quality",
  "open-design",
  "notion-publish",
  "github-publish",
  "openpets",
  "browser-verify",
  "browser-session",
  "artifact"
]);

export function fixedTarget(requestUrl, method, body, config, policy) {
  const url = new URL(requestUrl, "http://gateway.invalid");
  if (url.pathname === "/openai/v1/chat/completions") {
    if (!policy.capabilities.has("openai-chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.openaiChatModels.has(payload?.model)) {
      throw new GatewayPolicyError("OpenAI model is not allowlisted.");
    }
    return {
      model: payload.model,
      token: config.openaiApiKey,
      url: "https://api.openai.com/v1/chat/completions"
    };
  }
  if (url.pathname === "/vertex/v1/chat/completions") {
    if (!policy.capabilities.has("vertex-chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.vertexChatModels.has(payload?.model)) {
      throw new GatewayPolicyError("Vertex model is not allowlisted.");
    }
    const project = String(config.googleCloudProject ?? "").trim();
    if (!project)
      throw new GatewayPolicyError("Vertex project is not configured.");
    return {
      model: payload.model,
      token: "",
      auth: "vertex",
      url: vertexOpenAiUrl(project)
    };
  }
  if (url.pathname === "/v1/chat/completions") {
    if (!policy.capabilities.has("chat")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const payload = parseJson(body);
    if (!policy.chatModels.has(payload?.model)) {
      throw new GatewayPolicyError("Workers AI model is not allowlisted.");
    }
    return {
      model: payload.model,
      token: config.cloudflareApiToken,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/v1/chat/completions`
    };
  }

  if (url.pathname.startsWith("/run/")) {
    if (!policy.capabilities.has("image")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    const model = decodeURIComponent(url.pathname.slice("/run/".length));
    if (!policy.imageModels.has(model)) {
      throw new GatewayPolicyError(
        "Workers AI image model is not allowlisted."
      );
    }
    return {
      model,
      token: config.cloudflareApiToken,
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/run/${model}`
    };
  }

  if (url.pathname === "/quality/mcp") {
    if (!policy.capabilities.has("quality")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["DELETE", "POST"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "quality",
      token: config.qualityMcpToken,
      headers: {
        "x-lab-registration-token": config.qualityRegistrationToken
      },
      url: `http://host.docker.internal:8793/mcp${url.search}`
    };
  }

  if (
    url.pathname === "/quality/notifications" ||
    url.pathname === "/quality/runs" ||
    url.pathname.startsWith("/quality/runs/")
  ) {
    if (!policy.capabilities.has("quality")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["GET", "POST"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const upstreamPath = url.pathname.slice("/quality".length);
    return {
      model: "quality",
      token: config.qualityMcpToken,
      headers: {
        "x-lab-registration-token": config.qualityRegistrationToken
      },
      url: `http://host.docker.internal:8793${upstreamPath}${url.search}`
    };
  }

  if (url.pathname.startsWith("/open-design/")) {
    if (!policy.capabilities.has("open-design")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (!new Set(["DELETE", "GET", "HEAD", "POST", "PUT"]).has(method)) {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const upstreamPath = url.pathname.slice("/open-design".length);
    if (
      !new Set(["/api", "/artifacts", "/frames"]).has(upstreamPath) &&
      !["/api/", "/artifacts/", "/frames/"].some((prefix) =>
        upstreamPath.startsWith(prefix)
      )
    ) {
      throw new GatewayPolicyError("OpenDesign route is not allowlisted.");
    }
    return {
      model: "open-design",
      token: config.openDesignToken,
      url: `http://open-design:7456${upstreamPath}${url.search}`
    };
  }

  if (url.pathname === "/notion/publish") {
    if (!policy.capabilities.has("notion-publish")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST")
      throw new GatewayPolicyError("Method not allowed.", 405);
    return {
      model: "notion-publish",
      token: config.notionPublisherToken,
      url: `${config.notionPublisherUrl}/publish`
    };
  }

  if (url.pathname.startsWith("/github/")) {
    if (!policy.capabilities.has("github-publish")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const operation = url.pathname.slice("/github/".length);
    if (
      !new Set([
        "status",
        "push",
        "pr",
        "pulls",
        "pull",
        "issues",
        "issue",
        "issue-create",
        "comment"
      ]).has(operation)
    ) {
      throw new GatewayPolicyError("GitHub route is not allowlisted.");
    }
    return {
      model: "github-publish",
      token: config.githubRelayToken,
      url: `${config.githubRelayUrl}/v1/${operation}`
    };
  }

  if (url.pathname === "/openpets/react") {
    if (!policy.capabilities.has("openpets")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    const payload = parseJson(body);
    if (
      typeof payload?.reaction !== "string" ||
      !new Set([
        "thinking",
        "editing",
        "testing",
        "waiting",
        "success",
        "error"
      ]).has(payload.reaction)
    ) {
      throw new GatewayPolicyError("OpenPets reaction is not allowlisted.");
    }
    return {
      model: "openpets",
      token: config.openPetsRelayToken,
      url: `${config.openPetsRelayUrl}/v1/react`
    };
  }

  if (url.pathname === "/browser/verify") {
    if (!policy.capabilities.has("browser-verify")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "browser-verify",
      token: config.browserVerifyRelayToken,
      url: `${config.browserVerifyRelayUrl}/verify`
    };
  }

  if (url.pathname === "/browser/session") {
    if (!policy.capabilities.has("browser-session")) {
      throw new GatewayPolicyError("Route is not allowlisted.", 404);
    }
    if (method !== "POST") {
      throw new GatewayPolicyError("Method not allowed.", 405);
    }
    return {
      model: "browser-session",
      token: config.browserSessionRelayToken,
      url: `${config.browserSessionRelayUrl}/action`
    };
  }

  throw new GatewayPolicyError("Route is not allowlisted.", 404);
}

export function capabilityScopeForTarget(requestUrl, target) {
  const pathname = new URL(requestUrl, "http://gateway.invalid").pathname;
  if (pathname === "/openai/v1/chat/completions") {
    return { route: "openai-chat", action: "invoke" };
  }
  if (pathname === "/vertex/v1/chat/completions") {
    return { route: "vertex-chat", action: "invoke" };
  }
  if (pathname === "/v1/chat/completions") {
    return { route: "chat", action: "invoke" };
  }
  if (pathname.startsWith("/run/")) {
    return { route: "image", action: "generate" };
  }
  if (pathname === "/quality/mcp") {
    return { route: "quality", action: "mcp" };
  }
  if (pathname === "/quality/runs") {
    return { route: "quality", action: "read" };
  }
  if (pathname === "/quality/notifications") {
    return { route: "quality", action: "read" };
  }
  if (pathname.startsWith("/quality/runs/")) {
    return {
      route: "quality",
      action: pathname.includes("/actions/") ? "operate" : "read"
    };
  }
  if (pathname.startsWith("/open-design/")) {
    return { route: "open-design", action: "mcp" };
  }
  if (pathname === "/notion/publish") {
    return { route: "notion-publish", action: "publish" };
  }
  if (pathname.startsWith("/github/")) {
    return {
      route: "github-publish",
      action: pathname.slice("/github/".length)
    };
  }
  if (pathname === "/openpets/react") {
    return { route: "openpets", action: "react" };
  }
  if (pathname === "/browser/verify") {
    return { route: "browser-verify", action: "verify" };
  }
  if (pathname === "/browser/session") {
    return { route: "browser-session", action: "control" };
  }
  throw new GatewayPolicyError(
    `No capability scope is defined for ${target.model}.`,
    404
  );
}

export function requireCapabilityScope(claims, scope) {
  try {
    return assertCapabilityScope(claims, scope);
  } catch (error) {
    throw new GatewayPolicyError(
      error instanceof Error ? error.message : "Capability scope rejected.",
      403
    );
  }
}
