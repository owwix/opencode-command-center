import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createLeaseTransport } from "./lease-transport.mjs";

test("cached client sees atomic lease rotation; streams survive; credentials and expiry fail closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "transport-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const rotate = (lease, expiresAt = now + 10000) => {
    writeFileSync(join(root, "next"), JSON.stringify({ lease, expiresAt }));
    renameSync(join(root, "next"), join(root, "lease.json"));
  };
  rotate("lease-one");
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${req.headers.authorization}\n\n`);
    setTimeout(() => res.end("data: done\n\n"), 40);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const token = "a".repeat(64);
  const transport = createLeaseTransport({
    token,
    leasePath: join(root, "lease.json"),
    upstreamPort: upstream.address().port,
    now: () => now
  });
  transport.listen(0, "127.0.0.1");
  await once(transport, "listening");
  t.after(() => transport.close());
  const url = `http://127.0.0.1:${transport.address().port}/v1/chat/completions`;
  const headers = { authorization: `Bearer ${token}` };
  const first = await fetch(url, { headers });
  rotate("lease-two");
  assert.match(await first.text(), /lease-one[\s\S]*done/);
  assert.match(await (await fetch(url, { headers })).text(), /lease-two/);
  assert.equal((await fetch(url)).status, 401);
  now += 20000;
  assert.equal((await fetch(url, { headers })).status, 503);
});
