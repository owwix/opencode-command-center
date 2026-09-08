import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { loopbackHealth } from "./loopback-health.mjs";

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("loopback health parses bounded JSON responses", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"service":"test"}');
    },
    async (port) => {
      assert.deepEqual(
        await loopbackHealth(`http://127.0.0.1:${port}/health`),
        {
          ok: true,
          payload: { ok: true, service: "test" }
        }
      );
    }
  );
});

test("loopback health rejects non-loopback and oversized responses", async () => {
  await assert.rejects(
    loopbackHealth("https://example.com/health"),
    /loopback HTTP/u
  );
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(65 * 1024));
    },
    async (port) => {
      await assert.rejects(
        loopbackHealth(`http://127.0.0.1:${port}/health`),
        /too large/u
      );
    }
  );
});
