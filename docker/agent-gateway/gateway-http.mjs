import { once } from "node:events";
import { Readable } from "node:stream";
import { GatewayPolicyError } from "./gateway-errors.mjs";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-lab-request-id",
  "x-lab-correlation-id"
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "cf-aig-log-id",
  "cf-ray",
  "content-language",
  "content-type",
  "last-modified",
  "mcp-session-id",
  "retry-after",
  "x-accel-buffering",
  "x-request-id",
  "x-lab-request-id",
  "x-lab-correlation-id",
  "x-lab-model",
  "x-lab-fallback-from",
  "x-lab-concurrency-retry",
  "x-lab-duration-ms"
]);

export function filteredRequestHeaders(
  headers,
  upstreamToken,
  bodyLength,
  capabilityLease,
  additionalHeaders = {}
) {
  const result = {
    authorization: `Bearer ${upstreamToken}`,
    "content-length": String(bodyLength),
    "x-opencode-capability-lease": capabilityLease,
    ...additionalHeaders
  };
  for (const [name, value] of headers.entries()) {
    if (REQUEST_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

export function filteredResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

export function createLimiter(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire(timeoutMs = 1_000) {
      if (active < limit) {
        active += 1;
        return true;
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
        waiters.push({ resolve, timer });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(true);
      } else {
        active = Math.max(0, active - 1);
      }
    }
  };
}

export function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (exceeded) {
        reject(new GatewayPolicyError("Request body is too large.", 413));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("aborted", () => reject(new Error("Request was aborted.")));
    request.on("error", reject);
  });
}

export function parseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new GatewayPolicyError("Request body must be valid JSON.", 400);
  }
}

export async function streamResponse(upstream, response, metadata = {}) {
  const headers = filteredResponseHeaders(upstream.headers);
  if (metadata.requestId) headers["x-lab-request-id"] = metadata.requestId;
  if (metadata.correlationId) {
    headers["x-lab-correlation-id"] = metadata.correlationId;
  }
  if (metadata.model) headers["x-lab-model"] = metadata.model;
  if (metadata.fallbackFrom) {
    headers["x-lab-fallback-from"] = metadata.fallbackFrom;
  }
  if (metadata.concurrencyRetried) {
    headers["x-lab-concurrency-retry"] = "1";
  }
  if (metadata.durationMs !== undefined) {
    headers["x-lab-duration-ms"] = String(metadata.durationMs);
  }
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    if (!response.write(chunk)) await once(response, "drain");
  }
  response.end();
}

export function policyResponse(response, error) {
  const statusCode =
    error instanceof GatewayPolicyError ? error.statusCode : 502;
  const message =
    error instanceof GatewayPolicyError
      ? error.message
      : "The credential gateway could not reach its fixed upstream.";
  const body = `${JSON.stringify({ error: { message } })}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}
