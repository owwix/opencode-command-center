import net from "node:net";
import https from "node:https";
import { GatewayPolicyError } from "./gateway-errors.mjs";

const nonPublicNetworks = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3]
]) {
  nonPublicNetworks.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
]) {
  nonPublicNetworks.addSubnet(address, prefix, "ipv6");
}

function privateAddress(address) {
  const normalized = String(address).toLowerCase();
  const family = net.isIPv4(normalized)
    ? "ipv4"
    : net.isIPv6(normalized)
      ? "ipv6"
      : null;
  return family === null || nonPublicNetworks.check(normalized, family);
}

export async function resolveArtifactTarget(url, allowlist, dnsLookup) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new GatewayPolicyError("Only HTTPS URLs are allowed.", 400);
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new GatewayPolicyError("Artifact URL authority is not allowed.", 400);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!allowlist.includes(host)) {
    throw new GatewayPolicyError("Domain is not allowlisted.", 403);
  }
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIPv4(host) ? 4 : 6 }]
    : await dnsLookup(host, { all: true, verbatim: true }).catch(() => []);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => privateAddress(address))
  ) {
    throw new GatewayPolicyError("Target resolves to a non-public IP.", 403);
  }
  return { parsed, host, addresses };
}

export function pinnedArtifactRequest(
  url,
  { address, family, timeoutMs, maxBytes }
) {
  return new Promise((resolveRequest, rejectRequest) => {
    const parsed = new URL(url);
    const request = https.request(
      parsed,
      {
        method: "GET",
        servername: parsed.hostname,
        lookup(_hostname, _options, callback) {
          callback(null, address, family);
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(
              new GatewayPolicyError("Artifact size exceeds limit.", 413)
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", rejectRequest);
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) headers.append(name, entry);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          const status = response.statusCode ?? 502;
          resolveRequest({
            status,
            ok: status >= 200 && status < 300,
            headers,
            async arrayBuffer() {
              return buffer;
            }
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new GatewayPolicyError("Artifact request timed out.", 504)
      );
    });
    request.on("error", rejectRequest);
    request.end();
  });
}
