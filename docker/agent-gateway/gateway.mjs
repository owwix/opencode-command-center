/**
 * Fixed-purpose credential and relay gateway.
 *
 * This privileged process holds provider/relay credentials. Every non-health
 * request must present a capability lease matching the configured launch and
 * route/action, and every upstream is selected from compiled allowlists.
 * OpenCode/project input cannot supply an arbitrary upstream, credential,
 * method, model, private-network target, or publishing operation. Artifact
 * fetches additionally revalidate DNS and redirects and enforce bounded HTTPS
 * staging. Keep new routes synchronized with docs/gateway-protocol.md and the
 * threat model, with positive and malicious boundary tests.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import {
  bearerCapability,
  verifyCapabilityLease
} from "./capability-lease.mjs";
import { GatewayPolicyError } from "./gateway-errors.mjs";
import {
  createLimiter,
  filteredRequestHeaders,
  parseJson,
  policyResponse,
  readBody,
  streamResponse
} from "./gateway-http.mjs";
import {
  CHAT_MODELS,
  CONCURRENCY_RETRY_DELAY_MS,
  IMAGE_MODELS,
  LONG_CONTEXT_FALLBACK_MODEL,
  OPENAI_CHAT_MODELS,
  PAYLOAD_FALLBACK_SOURCE_MODELS,
  VERTEX_CHAT_MODELS,
  acquireLimiterSlot,
  isVertexThoughtSignatureError,
  normalizeChatBody,
  resolveVertexAccessToken,
  rewriteChatModel,
  rewriteVertexChatBody,
  shouldFallbackGptOssToLongContext,
  shouldRetryConcurrency
} from "./gateway-models.mjs";
import {
  GATEWAY_CAPABILITIES,
  capabilityScopeForTarget,
  fixedTarget,
  requireCapabilityScope
} from "./gateway-routes.mjs";
import {
  pinnedArtifactRequest,
  resolveArtifactTarget
} from "./artifact-network.mjs";

export {
  CHAT_MODELS,
  CONCURRENCY_RETRY_DELAY_MS,
  IMAGE_MODELS,
  LONG_CONTEXT_FALLBACK_MODEL,
  OPENAI_CHAT_MODELS,
  PAYLOAD_FALLBACK_SOURCE_MODELS,
  VERTEX_CHAT_MODELS,
  isContextOverflowStatus,
  isGptOssAuthError,
  isGptOssSchemaError,
  isVertexThoughtSignatureError,
  rewriteChatModel,
  rewriteVertexChatBody,
  shouldFallbackGptOssToLongContext,
  shouldFallbackPayloadTooLarge,
  shouldRetryConcurrency,
  vertexOpenAiModelId,
  attachVertexThoughtSignatures
} from "./gateway-models.mjs";
export { GATEWAY_CAPABILITIES } from "./gateway-routes.mjs";

export function createAgentGateway(
  config,
  {
    fetchImpl = fetch,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    capabilities = GATEWAY_CAPABILITIES.filter(
      (capability) =>
        !new Set([
          "openai-chat",
          "vertex-chat",
          "notion-publish",
          "github-publish",
          "openpets",
          "browser-verify",
          "browser-session",
          "artifact"
        ]).has(capability)
    ),
    chatModels = CHAT_MODELS,
    openaiChatModels = OPENAI_CHAT_MODELS,
    vertexChatModels = VERTEX_CHAT_MODELS,
    imageModels = IMAGE_MODELS,
    artifactStagingRoot = "/workspace/.artifact-staging",
    dnsLookup = dns.lookup
  } = {}
) {
  const capabilitySet = new Set(capabilities);
  const unknownCapabilities = [...capabilitySet].filter(
    (capability) => !GATEWAY_CAPABILITIES.includes(capability)
  );
  if (unknownCapabilities.length) {
    throw new Error(
      `Unknown gateway capabilities: ${unknownCapabilities.join(", ")}.`
    );
  }
  const requiredConfig = [
    "gatewaySigningKey",
    "expectedWorkspaceHash",
    "expectedProjectId",
    "expectedSessionId",
    "expectedRunId"
  ];
  if (capabilitySet.has("chat") || capabilitySet.has("image")) {
    requiredConfig.push("cloudflareAccountId", "cloudflareApiToken");
  }
  if (capabilitySet.has("openai-chat")) requiredConfig.push("openaiApiKey");
  if (capabilitySet.has("vertex-chat"))
    requiredConfig.push("googleCloudProject");
  if (capabilitySet.has("quality")) {
    requiredConfig.push("qualityMcpToken", "qualityRegistrationToken");
  }
  if (capabilitySet.has("open-design")) requiredConfig.push("openDesignToken");
  if (capabilitySet.has("notion-publish")) {
    requiredConfig.push("notionPublisherToken", "notionPublisherUrl");
  }
  if (capabilitySet.has("github-publish")) {
    requiredConfig.push("githubRelayToken", "githubRelayUrl");
  }
  if (capabilitySet.has("openpets")) {
    requiredConfig.push("openPetsRelayToken", "openPetsRelayUrl");
  }
  if (capabilitySet.has("browser-verify")) {
    requiredConfig.push("browserVerifyRelayToken", "browserVerifyRelayUrl");
  }
  if (capabilitySet.has("browser-session")) {
    requiredConfig.push("browserSessionRelayToken", "browserSessionRelayUrl");
  }
  if (capabilitySet.has("artifact")) {
    requiredConfig.push("artifactAllowlist");
  }
  for (const name of requiredConfig) {
    if (!String(config[name] ?? "").trim())
      throw new Error(`${name} is required.`);
  }
  const policy = Object.freeze({
    capabilities: capabilitySet,
    chatModels: new Set(chatModels),
    openaiChatModels: new Set(openaiChatModels),
    vertexChatModels: new Set(vertexChatModels),
    imageModels: new Set(imageModels)
  });
  const concurrency = new Map([
    ["@cf/moonshotai/kimi-k2.6", createLimiter(2)],
    ["@cf/moonshotai/kimi-k2.7-code", createLimiter(2)],
    ["@cf/zai-org/glm-5.2", createLimiter(1)],
    ["@cf/zai-org/glm-4.7-flash", createLimiter(8)],
    ["@cf/openai/gpt-oss-120b", createLimiter(4)],
    ["gpt-5", createLimiter(2)],
    ["gpt-5-mini", createLimiter(4)],
    ["gpt-4.1", createLimiter(2)],
    ["gpt-4.1-mini", createLimiter(4)],
    ["o4-mini", createLimiter(2)],
    ["gemini-3.7-flash", createLimiter(4)],
    ["gemini-3.1-pro-preview", createLimiter(3)],
    ["quality", createLimiter(4)],
    ["open-design", createLimiter(2)],
    ["notion-publish", createLimiter(2)],
    ["github-publish", createLimiter(2)],
    ["openpets", createLimiter(4)],
    ["browser-verify", createLimiter(2)],
    ["browser-session", createLimiter(2)],
    ["artifact", createLimiter(4)]
  ]);

  const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024; // 10 MiB
  const MAX_ARTIFACT_REDIRECTS = 5;
  const DEFAULT_ARTIFACT_TIMEOUT_MS = 30 * 1000; // 30 s

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"service":"agent-gateway"}\n');
      return;
    }
    let capabilityLease;
    let capabilityClaims;
    try {
      capabilityLease = bearerCapability(request.headers.authorization);
      capabilityClaims = verifyCapabilityLease(capabilityLease, {
        key: config.gatewaySigningKey,
        workspaceHash: config.expectedWorkspaceHash,
        projectId: config.expectedProjectId,
        sessionId: config.expectedSessionId,
        runId: config.expectedRunId
      });
    } catch (error) {
      policyResponse(
        response,
        new GatewayPolicyError(
          error instanceof Error ? error.message : "Capability lease rejected.",
          401
        )
      );
      return;
    }
    let limiter = null;
    let acquired = false;
    try {
      const body = await readBody(request);

      // Artifact download route (HTTPS only, allow‑list enforced)
      if (request.method === "POST" && request.url === "/artifact/download") {
        requireCapabilityScope(capabilityClaims, {
          route: "artifact",
          action: "download"
        });
        if (!policy.capabilities.has("artifact")) {
          throw new GatewayPolicyError("Route is not allowlisted.", 404);
        }
        const payload = parseJson(body);
        const { url, checksum, filename, maxSize, allowedContentTypes } =
          payload;
        const allowlist = (config.artifactAllowlist ?? "")
          .split(",")
          .map((entry) => entry.trim().toLowerCase().replace(/\.$/u, ""))
          .filter(Boolean);
        if (typeof url !== "string") {
          throw new GatewayPolicyError("Artifact URL is required.", 400);
        }
        const initialTarget = await resolveArtifactTarget(
          url,
          allowlist,
          dnsLookup
        );
        const parsedUrl = initialTarget.parsed;
        if (
          maxSize !== undefined &&
          (!Number.isSafeInteger(maxSize) ||
            maxSize <= 0 ||
            maxSize > MAX_ARTIFACT_SIZE)
        ) {
          throw new GatewayPolicyError("Invalid artifact size limit.", 400);
        }
        const limitSize = maxSize ?? MAX_ARTIFACT_SIZE;
        // Follow redirects manually
        let currentUrl = url;
        let redirectCount = 0;
        let responseObj;
        const fetchOptsBase = {
          method: "GET",
          headers: {},
          redirect: "manual",
          signal: AbortSignal.timeout(DEFAULT_ARTIFACT_TIMEOUT_MS)
        };
        while (true) {
          const target = await resolveArtifactTarget(
            currentUrl,
            allowlist,
            dnsLookup
          );
          responseObj =
            fetchImpl === fetch
              ? await pinnedArtifactRequest(currentUrl, {
                  ...target.addresses[0],
                  timeoutMs: DEFAULT_ARTIFACT_TIMEOUT_MS,
                  maxBytes: limitSize
                })
              : await fetchImpl(currentUrl, fetchOptsBase);
          if (
            responseObj.status >= 300 &&
            responseObj.status < 400 &&
            responseObj.headers.get("location")
          ) {
            if (redirectCount >= MAX_ARTIFACT_REDIRECTS) {
              throw new GatewayPolicyError("Too many redirects.", 400);
            }
            const location = responseObj.headers.get("location");
            const nextUrl = new URL(location, currentUrl).toString();
            currentUrl = nextUrl;
            redirectCount++;
            continue;
          }
          break;
        }
        if (!responseObj.ok) {
          throw new GatewayPolicyError(
            `Failed to download artifact (status ${responseObj.status}).`,
            responseObj.status
          );
        }
        const contentType =
          responseObj.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        const allowedTypes = allowedContentTypes?.length
          ? allowedContentTypes
          : [
              "application/octet-stream",
              "application/pdf",
              "image/png",
              "image/jpeg",
              "image/webp",
              "text/plain"
            ];
        if (!allowedTypes.includes(contentType)) {
          throw new GatewayPolicyError("Disallowed content type.", 415);
        }
        const buffer = Buffer.from(await responseObj.arrayBuffer());
        if (buffer.length > limitSize) {
          throw new GatewayPolicyError("Artifact size exceeds limit.", 413);
        }
        if (checksum) {
          const computed = crypto
            .createHash("sha256")
            .update(buffer)
            .digest("hex");
          if (computed !== checksum.toLowerCase()) {
            throw new GatewayPolicyError("Checksum mismatch.", 400);
          }
        }
        // Determine safe filename
        let safeName = filename ?? path.basename(parsedUrl.pathname);
        if (
          !safeName ||
          safeName.includes("..") ||
          safeName.includes("/") ||
          safeName.includes("\\")
        ) {
          throw new GatewayPolicyError("Invalid filename.", 400);
        }
        const stagingRoot = path.resolve(artifactStagingRoot);
        await fs.mkdir(stagingRoot, { recursive: true });
        const tmpDir = await fs.mkdtemp(path.join(stagingRoot, "tmp-"));
        const destPath = path.join(tmpDir, safeName);
        await fs.writeFile(destPath, buffer);
        const result = {
          url,
          finalUrl: currentUrl,
          size: buffer.length,
          mimeType: contentType,
          checksum:
            checksum ??
            crypto.createHash("sha256").update(buffer).digest("hex"),
          stagingPath: path.relative(path.dirname(stagingRoot), destPath)
        };
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify(result));
        return;
      }

      // Normal route handling
      const target = fixedTarget(
        request.url,
        request.method ?? "GET",
        body,
        config,
        policy
      );
      requireCapabilityScope(
        capabilityClaims,
        capabilityScopeForTarget(request.url, target)
      );
      if (target.auth === "vertex") {
        target.token = await resolveVertexAccessToken(config, fetchImpl);
      }
      const upstreamBody = request.url?.startsWith(
        "/vertex/v1/chat/completions"
      )
        ? rewriteVertexChatBody(body)
        : request.url?.startsWith("/v1/chat/completions")
          ? normalizeChatBody(body, target.model)
          : body;
      const requestId =
        request.headers["x-lab-request-id"]?.toString().trim() || randomUUID();
      const correlationId =
        request.headers["x-lab-correlation-id"]?.toString().trim() || requestId;
      limiter = concurrency.get(target.model) ?? createLimiter(2);
      let concurrencyRetried = false;
      {
        const slot = await acquireLimiterSlot(limiter, { delay });
        acquired = slot.acquired;
        concurrencyRetried = slot.retried && slot.acquired;
        if (!slot.acquired) {
          response.writeHead(429, {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "1",
            "x-lab-request-id": requestId,
            "x-lab-concurrency-retry": "1"
          });
          response.end(
            '{"error":{"message":"Model concurrency limit reached."}}\n'
          );
          return;
        }
      }
      const startedAt = Date.now();
      let activeModel = target.model;
      let activeBody = upstreamBody;
      let activeUrl = target.url;
      let activeToken = target.token;
      const fetchUpstream = () =>
        fetchImpl(activeUrl, {
          method: request.method,
          headers: filteredRequestHeaders(
            new Headers(request.headers),
            activeToken,
            activeBody.length,
            capabilityLease,
            {
              ...target.headers,
              "x-lab-correlation-id": correlationId
            }
          ),
          body: new Set(["GET", "HEAD"]).has(request.method)
            ? undefined
            : activeBody,
          redirect: "manual",
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });
      let upstream = await fetchUpstream();
      let fallbackFrom = null;
      if (
        request.url?.startsWith("/v1/chat/completions") &&
        PAYLOAD_FALLBACK_SOURCE_MODELS.has(activeModel) &&
        policy.chatModels.has(LONG_CONTEXT_FALLBACK_MODEL) &&
        (upstream.status === 413 || upstream.status === 400)
      ) {
        const errorBody = upstream.body
          ? Buffer.from(
              await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
            ).toString("utf8")
          : "";
        if (
          shouldFallbackGptOssToLongContext(
            upstream.status,
            activeModel,
            errorBody
          )
        ) {
          const previousModel = activeModel;
          activeModel = LONG_CONTEXT_FALLBACK_MODEL;
          activeBody = rewriteChatModel(body, activeModel);
          activeUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/v1/chat/completions`;
          if (acquired) {
            limiter.release();
            acquired = false;
          }
          limiter = concurrency.get(activeModel) ?? createLimiter(2);
          const slot = await acquireLimiterSlot(limiter, { delay });
          acquired = slot.acquired;
          if (slot.retried && slot.acquired) concurrencyRetried = true;
          if (!slot.acquired) {
            response.writeHead(429, {
              "content-type": "application/json; charset=utf-8",
              "retry-after": "1",
              "x-lab-request-id": requestId,
              "x-lab-fallback-from": previousModel,
              "x-lab-concurrency-retry": "1"
            });
            response.end(
              '{"error":{"message":"Model concurrency limit reached during payload fallback."}}\n'
            );
            return;
          }
          fallbackFrom = previousModel;
          upstream = await fetchUpstream();
        } else {
          response.writeHead(upstream.status, {
            "content-type": "application/json; charset=utf-8",
            "x-lab-request-id": requestId,
            "x-lab-model": activeModel
          });
          response.end(errorBody || '{"error":{"message":"Bad Request"}}\n');
          return;
        }
      }
      if (
        request.url?.startsWith("/vertex/v1/chat/completions") &&
        upstream.status === 400
      ) {
        const errorBody = upstream.body
          ? Buffer.from(
              await upstream.arrayBuffer().catch(() => new ArrayBuffer(0))
            ).toString("utf8")
          : "";
        if (isVertexThoughtSignatureError(upstream.status, errorBody)) {
          activeBody = rewriteVertexChatBody(body, { forceAll: true });
          upstream = await fetchUpstream();
        } else {
          response.writeHead(upstream.status, {
            "content-type": "application/json; charset=utf-8",
            "x-lab-request-id": requestId,
            "x-lab-model": activeModel
          });
          response.end(errorBody || '{"error":{"message":"Bad Request"}}\n');
          return;
        }
      }
      if (
        shouldRetryConcurrency(upstream.status) &&
        (request.url?.startsWith("/v1/chat/completions") ||
          request.url?.startsWith("/openai/v1/chat/completions") ||
          request.url?.startsWith("/vertex/v1/chat/completions"))
      ) {
        if (upstream.body) {
          await upstream.arrayBuffer().catch(() => undefined);
        }
        await delay(CONCURRENCY_RETRY_DELAY_MS);
        concurrencyRetried = true;
        upstream = await fetchUpstream();
      }
      await streamResponse(upstream, response, {
        requestId,
        correlationId,
        model: activeModel,
        fallbackFrom,
        concurrencyRetried,
        durationMs: Date.now() - startedAt
      });
      process.stderr.write(
        `${JSON.stringify({
          requestId,
          correlationId,
          model: activeModel,
          fallbackFrom,
          concurrencyRetried,
          status: upstream.status,
          durationMs: Date.now() - startedAt
        })}\n`
      );
    } catch (error) {
      if (!response.headersSent) policyResponse(response, error);
      else response.destroy();
    } finally {
      if (acquired) limiter.release();
    }
  });
}
