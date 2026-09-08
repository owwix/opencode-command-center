/**
 * Signed launch/run capability protocol.
 *
 * The trusted launcher/gateway owns the HMAC key; untrusted OpenCode receives
 * only a short-lived token bound to one workspace, project, session, optional
 * run, and explicit route/action lists. Creation normalizes and bounds claims.
 * Verification authenticates the signature and exact launch identity before a
 * caller may assert a route/action. Any malformed, expired, altered,
 * cross-launch, or over-scoped token fails closed.
 *
 * Protocol reference: ../../docs/gateway-protocol.md
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const CAPABILITY_LEASE_VERSION = 1;
export const MAX_CAPABILITY_LEASE_SECONDS = 4 * 60 * 60;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeJson(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error(`Capability lease ${label} is invalid.`);
  }
}

function normalizedList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Capability lease ${label} must be a non-empty list.`);
  }
  const normalized = [...new Set(values.map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort();
  if (
    normalized.length !== values.length ||
    normalized.some(
      (value) =>
        !/^[a-z][a-z0-9-]{0,63}(?::[a-z][a-z0-9-]{0,63})?$/u.test(value)
    )
  ) {
    throw new Error(`Capability lease ${label} contains an invalid value.`);
  }
  return normalized;
}

function requiredId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,160}$/u.test(normalized)) {
    throw new Error(`Capability lease ${label} is invalid.`);
  }
  return normalized;
}

function signingKey(value) {
  const normalized = String(value ?? "");
  if (Buffer.byteLength(normalized) < 32) {
    throw new Error("Capability signing key must contain at least 32 bytes.");
  }
  return normalized;
}

function signature(key, signingInput) {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

/** @param {{ key: string, workspaceHash: string, projectId: string, sessionId: string, runId?: string | null, routes: string[], actions: string[], now?: number, ttlSeconds?: number }} options */
export function createCapabilityLease({
  key,
  workspaceHash,
  projectId,
  sessionId,
  runId = null,
  routes,
  actions,
  now = Date.now(),
  ttlSeconds = 30 * 60
}) {
  const secret = signingKey(key);
  const ttl = Number(ttlSeconds);
  if (
    !Number.isInteger(ttl) ||
    ttl < 30 ||
    ttl > MAX_CAPABILITY_LEASE_SECONDS
  ) {
    throw new Error(
      `Capability lease lifetime must be 30-${MAX_CAPABILITY_LEASE_SECONDS} seconds.`
    );
  }
  const issuedAt = Math.floor(Number(now) / 1000);
  const header = {
    alg: "HS256",
    typ: "OCL-CAP",
    v: CAPABILITY_LEASE_VERSION
  };
  const payload = {
    v: CAPABILITY_LEASE_VERSION,
    jti: randomUUID(),
    workspaceHash: requiredId(workspaceHash, "workspace hash"),
    projectId: requiredId(projectId, "project ID"),
    sessionId: requiredId(sessionId, "session ID"),
    runId: runId ? requiredId(runId, "run ID") : null,
    routes: normalizedList(routes, "routes"),
    actions: normalizedList(actions, "actions"),
    iat: issuedAt,
    exp: issuedAt + ttl
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload)
  )}`;
  return `${signingInput}.${signature(secret, signingInput)}`;
}

export function verifyCapabilityLease(
  token,
  {
    key,
    workspaceHash,
    projectId,
    sessionId,
    runId,
    now = Date.now(),
    clockSkewSeconds = 30
  }
) {
  const secret = signingKey(key);
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Capability lease token is invalid.");
  }
  const [encodedHeader, encodedPayload, receivedSignature] = parts;
  const header = decodeJson(encodedHeader, "header");
  const claims = decodeJson(encodedPayload, "payload");
  if (
    header.alg !== "HS256" ||
    header.typ !== "OCL-CAP" ||
    header.v !== CAPABILITY_LEASE_VERSION ||
    claims.v !== CAPABILITY_LEASE_VERSION
  ) {
    throw new Error("Capability lease version or algorithm is unsupported.");
  }
  const expectedSignature = signature(
    secret,
    `${encodedHeader}.${encodedPayload}`
  );
  const actual = Buffer.from(receivedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Capability lease signature is invalid.");
  }
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const current = Math.floor(Number(now) / 1000);
  if (
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_CAPABILITY_LEASE_SECONDS
  ) {
    throw new Error("Capability lease lifetime is invalid.");
  }
  if (issuedAt > current + clockSkewSeconds) {
    throw new Error("Capability lease is not active yet.");
  }
  if (expiresAt <= current - clockSkewSeconds) {
    throw new Error("Capability lease has expired.");
  }
  const expectedClaims = {
    workspaceHash,
    projectId,
    sessionId,
    ...(runId !== undefined ? { runId } : {})
  };
  for (const [name, expectedValue] of Object.entries(expectedClaims)) {
    if (expectedValue !== undefined && claims[name] !== expectedValue) {
      throw new Error(`Capability lease ${name} does not match this launch.`);
    }
  }
  claims.workspaceHash = requiredId(claims.workspaceHash, "workspace hash");
  claims.projectId = requiredId(claims.projectId, "project ID");
  claims.sessionId = requiredId(claims.sessionId, "session ID");
  claims.runId = claims.runId ? requiredId(claims.runId, "run ID") : null;
  claims.routes = normalizedList(claims.routes, "routes");
  claims.actions = normalizedList(claims.actions, "actions");
  return claims;
}

export function assertCapabilityScope(claims, { route, action }) {
  if (!claims?.routes?.includes(route)) {
    throw new Error(`Capability lease does not allow route '${route}'.`);
  }
  const scopedAction = `${route}:${action}`;
  if (!claims?.actions?.includes(scopedAction)) {
    throw new Error(
      `Capability lease does not allow action '${scopedAction}'.`
    );
  }
  return claims;
}

export function bearerCapability(header) {
  const match = /^Bearer ([^\s]+)$/u.exec(String(header ?? ""));
  if (!match) throw new Error("Capability lease authentication is required.");
  return match[1];
}
