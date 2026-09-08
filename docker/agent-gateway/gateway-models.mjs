import fs from "node:fs/promises";
import { GatewayPolicyError } from "./gateway-errors.mjs";
import { parseJson } from "./gateway-http.mjs";

export const CHAT_MODELS = new Set([
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-120b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2"
]);
export const OPENAI_CHAT_MODELS = new Set([
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o4-mini"
]);
export const VERTEX_CHAT_MODELS = new Set([
  "gemini-3.7-flash",
  "gemini-3.1-pro-preview"
]);
export const IMAGE_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-dev"
]);
// Workers AI's GPT-OSS chat schema currently rejects the OpenAI-standard
// multi-turn representation used by tool loops (content-part arrays and
// assistant messages with null content). Keep this compatibility shim scoped
// to the text-only model; never flatten content for vision-capable models.
const TEXT_ONLY_CHAT_COMPAT_MODELS = new Set(["@cf/openai/gpt-oss-120b"]);
/** When GPT-OSS rejects an oversized session, retry once on the long-context lane. */
export const LONG_CONTEXT_FALLBACK_MODEL = "@cf/moonshotai/kimi-k2.6";
export const PAYLOAD_FALLBACK_SOURCE_MODELS = new Set([
  "@cf/openai/gpt-oss-120b"
]);

export function normalizeChatBody(body, model) {
  if (!TEXT_ONLY_CHAT_COMPAT_MODELS.has(model)) return body;
  const payload = parseJson(body);
  if (!Array.isArray(payload.messages)) return body;
  const messages = payload.messages.map((message) => {
    const normalized = { ...message };
    if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content
        .map((part) =>
          typeof part === "string"
            ? part
            : typeof part?.text === "string"
              ? part.text
              : ""
        )
        .filter(Boolean)
        .join("\n");
    } else if (normalized.content == null) {
      normalized.content = "";
    }
    return normalized;
  });
  return Buffer.from(JSON.stringify({ ...payload, messages }));
}

export function rewriteChatModel(body, model) {
  const payload = parseJson(body);
  return Buffer.from(JSON.stringify({ ...payload, model }), "utf8");
}

export function shouldFallbackPayloadTooLarge(
  status,
  model,
  allowlistedModels
) {
  return (
    status === 413 &&
    PAYLOAD_FALLBACK_SOURCE_MODELS.has(model) &&
    allowlistedModels.has(LONG_CONTEXT_FALLBACK_MODEL)
  );
}

const OVERFLOW_BODY_PATTERN =
  /payload too large|context.?length|maximum context|too many tokens|request.?too.?large|prompt.?too.?long/iu;

const GPT_OSS_SCHEMA_BODY_PATTERN =
  /schema|tool[_ -]?call|content.?part|messages(?:\.|\[)|null content|expected (?:a )?string|type.?error/iu;

const VERTEX_THOUGHT_BODY_PATTERN =
  /thought_signature|functioncall|function.?call.*signat/iu;

export function isContextOverflowStatus(status, bodyText = "") {
  if (status === 413) return true;
  if (status !== 400) return false;
  return OVERFLOW_BODY_PATTERN.test(String(bodyText));
}

export function isGptOssSchemaError(status, bodyText = "") {
  return status === 400 && GPT_OSS_SCHEMA_BODY_PATTERN.test(String(bodyText));
}

export function isVertexThoughtSignatureError(status, bodyText = "") {
  return status === 400 && VERTEX_THOUGHT_BODY_PATTERN.test(String(bodyText));
}

export function isGptOssAuthError(bodyText = "") {
  return /unauthorized|forbidden|invalid.?api.?key|authentication|permission denied/iu.test(
    String(bodyText)
  );
}

export function shouldFallbackGptOssToLongContext(
  status,
  model,
  bodyText = ""
) {
  if (!PAYLOAD_FALLBACK_SOURCE_MODELS.has(model)) return false;
  if (isGptOssAuthError(bodyText)) return false;
  return (
    isContextOverflowStatus(status, bodyText) ||
    isGptOssSchemaError(status, bodyText)
  );
}

/** Brief pause before a second attempt when a model slot is busy. */
export const CONCURRENCY_RETRY_DELAY_MS = 750;

export function shouldRetryConcurrency(status) {
  return status === 429;
}

export async function acquireLimiterSlot(
  limiter,
  { delay, delayMs = CONCURRENCY_RETRY_DELAY_MS, timeoutMs = 5_000 } = {}
) {
  let acquired = await limiter.acquire(timeoutMs);
  if (acquired) return { acquired: true, retried: false };
  await delay(delayMs);
  acquired = await limiter.acquire(timeoutMs);
  return { acquired, retried: true };
}

export function vertexOpenAiUrl(project) {
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/endpoints/openapi/chat/completions`;
}

export function vertexOpenAiModelId(model) {
  if (typeof model !== "string" || !model.includes("/")) {
    return `google/${model}`;
  }
  return model;
}

function thoughtSignatureOf(call) {
  const fromExtra = call?.extra_content?.google?.thought_signature;
  if (typeof fromExtra === "string" && fromExtra) return fromExtra;
  const fromFunction = call?.function?.thought_signature;
  if (typeof fromFunction === "string" && fromFunction) return fromFunction;
  return "";
}

export function attachVertexThoughtSignatures(
  messages,
  { forceAll = false } = {}
) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (
      !Array.isArray(message?.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      return message;
    }
    return {
      ...message,
      tool_calls: message.tool_calls.map((call, index) => {
        if (thoughtSignatureOf(call) && !forceAll) return call;
        // Gemini 3 requires a signature on functionCall steps. OpenCode's
        // OpenAI-compatible client strips extra_content, so inject Google's
        // documented skip token when the original signature is gone.
        if (!forceAll && index > 0) return call;
        return {
          ...call,
          extra_content: {
            ...(call.extra_content ?? {}),
            google: {
              ...(call.extra_content?.google ?? {}),
              thought_signature: "skip_thought_signature_validator"
            }
          }
        };
      })
    };
  });
}

export function rewriteVertexChatBody(body, options = {}) {
  const payload = parseJson(body);
  return Buffer.from(
    JSON.stringify({
      ...payload,
      model: vertexOpenAiModelId(payload.model),
      messages: attachVertexThoughtSignatures(payload.messages, options)
    })
  );
}

const vertexTokenCache = { token: "", expiresAt: 0 };

export async function resolveVertexAccessToken(config, fetchImpl) {
  const configured = String(config.googleAccessToken ?? "").trim();
  if (configured) return configured;
  if (vertexTokenCache.token && Date.now() < vertexTokenCache.expiresAt) {
    return vertexTokenCache.token;
  }
  const credentialPath = String(
    config.googleApplicationCredentials ?? ""
  ).trim();
  if (!credentialPath) {
    throw new GatewayPolicyError("Vertex credentials are not configured.");
  }
  const raw = await fs.readFile(credentialPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayPolicyError("Vertex credentials are invalid.", 500);
  }
  if (parsed.type !== "authorized_user" || !parsed.refresh_token) {
    throw new GatewayPolicyError("Vertex credentials are invalid.", 500);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: parsed.refresh_token,
    client_id: parsed.client_id,
    client_secret: parsed.client_secret
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) {
    throw new GatewayPolicyError("Vertex authentication failed.", 502);
  }
  const payload = await response.json();
  const token = String(payload.access_token ?? "").trim();
  if (!token)
    throw new GatewayPolicyError("Vertex authentication failed.", 502);
  const expiresIn = Number(payload.expires_in) || 3600;
  vertexTokenCache.token = token;
  vertexTokenCache.expiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1000;
  return token;
}
