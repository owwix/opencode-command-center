import { request as httpRequest } from "node:http";

/**
 * Probe a launcher-owned loopback HTTP health endpoint without using Undici.
 *
 * @param {string | URL} url
 * @param {{ headers?: import("node:http").OutgoingHttpHeaders, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, payload: unknown }>}
 */
export function loopbackHealth(url, { headers = {}, timeoutMs = 1000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    return Promise.reject(
      new Error("Health checks must target loopback HTTP.")
    );
  }
  return new Promise((resolveHealth, rejectHealth) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        timeout: timeoutMs
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 64 * 1024) {
            request.destroy(new Error("Health response is too large."));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", rejectHealth);
        response.once("end", () => {
          /** @type {unknown} */
          let payload = null;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // A malformed health response is simply unhealthy.
          }
          const status = response.statusCode ?? 500;
          resolveHealth({ ok: status >= 200 && status < 300, payload });
        });
      }
    );
    request.once("timeout", () =>
      request.destroy(new Error("Health check timed out."))
    );
    request.once("error", rejectHealth);
    request.end();
  });
}
