import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

/** A per-launch transport credential is never gateway authority. Only the host's
 * current signed lease is forwarded to the fixed loopback authority endpoint.
 * @param {{ token: string, leasePath: string, upstreamPort: number, now?: () => number }} options */
export function createLeaseTransport({
  token,
  leasePath,
  upstreamPort,
  now = Date.now
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(token) ||
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw new Error("Invalid lease transport configuration.");
  return createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url === "/health") {
      outgoing.end('{"ok":true,"service":"lease-transport"}');
      return;
    }
    const presented = Buffer.from(String(incoming.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      outgoing.writeHead(401).end("Launch transport authentication rejected.");
      return;
    }
    if (
      !incoming.url?.startsWith("/") ||
      incoming.url.startsWith("//") ||
      incoming.method === "CONNECT"
    ) {
      outgoing.writeHead(400).end("Only fixed gateway routes are supported.");
      return;
    }
    let lease;
    try {
      const current = JSON.parse(await readFile(leasePath, "utf8"));
      if (
        typeof current.lease !== "string" ||
        !Number.isFinite(current.expiresAt) ||
        current.expiresAt <= now()
      )
        throw new Error("Expired");
      lease = current.lease;
    } catch {
      outgoing
        .writeHead(503, { "retry-after": "30" })
        .end("Gateway lease unavailable or expired. Resume the host launcher.");
      return;
    }
    const headers = {
      ...incoming.headers,
      host: `127.0.0.1:${upstreamPort}`,
      authorization: `Bearer ${lease}`
    };
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      }
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent)
        outgoing.writeHead(502).end("Gateway connection unavailable.");
      else outgoing.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    upstream.setTimeout(180000, () => upstream.destroy());
    incoming.pipe(upstream);
  });
}
