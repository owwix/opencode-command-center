import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  allowedChromeOrigin,
  validateChromeOperation,
  createChromeController
} from "./connected-chrome-policy.mjs";
import {
  chromeOperationCode,
  parseChromeResult,
  createChromeAdapter
} from "./connected-chrome-adapter.mjs";
import { chromeArguments } from "./connected-chrome.mjs";

const origins = ["https://example.com"];
const scope = {
  projectId: "project",
  workspaceHash: "hash",
  sessionId: "launch",
  runId: null,
  exp: 2000
};
const request = (input = { operation: "snapshot" }, overrides = {}) => ({
  scope,
  requestId: randomUUID(),
  input,
  ...overrides
});
function fixture(options = {}) {
  const calls = [];
  const controller = createChromeController({
    projectId: "project",
    workspaceHash: "hash",
    origins,
    now: () => 1000000,
    approve: async () => true,
    adapter: {
      perform: async (input) => {
        calls.push(input);
        return { ok: true };
      }
    },
    ...options
  });
  return { controller, calls };
}
test("exact origins and fixed operation schema reject escape hatches", () => {
  assert.equal(allowedChromeOrigin("https://example.com"), origins[0]);
  assert.equal(
    allowedChromeOrigin("http://localhost:3100"),
    "http://localhost:3100"
  );
  for (const url of [
    "file:///tmp",
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?token=x"
  ])
    assert.throws(() => allowedChromeOrigin(url));
  for (const input of [
    { operation: "evaluate", code: "bad" },
    { operation: "snapshot", code: "bad" },
    { operation: "navigate", url: "https://example.com.evil.test" },
    { operation: "navigate", url: "javascript:alert(1)" },
    { operation: "press", key: "Meta+L" }
  ])
    assert.throws(() => validateChromeOperation(input, origins));
  assert.throws(() => chromeArguments([]));
});
test("host consent, identity, foreground and expiry fail closed", async () => {
  const { controller, calls } = fixture();
  for (const patch of [
    { projectId: "other" },
    { workspaceHash: "other" },
    { runId: "background" },
    { exp: 1 },
    { exp: null },
    { sessionId: "" }
  ])
    await assert.rejects(
      controller.run(request(undefined, { scope: { ...scope, ...patch } }))
    );
  assert.equal(calls.length, 0);
  const rejected = fixture({ approve: async () => false });
  await assert.rejects(rejected.controller.run(request()), /approval/);
  assert.equal(rejected.calls.length, 0);
  await assert.rejects(
    controller.run(request(), () => false),
    /disconnected/
  );
  assert.equal(calls.length, 0);
});
test("requests are single use and locked to one launch", async () => {
  const { controller, calls } = fixture();
  const first = request();
  await controller.run(first);
  await assert.rejects(controller.run(first), /consumed/);
  await assert.rejects(
    controller.run(
      request(undefined, { scope: { ...scope, sessionId: "other" } })
    ),
    /another launch/
  );
  controller.revoke();
  await assert.rejects(controller.run(request()), /expired/);
  assert.equal(calls.length, 1);
});
test("concurrent requests rejected and expiry rechecked after approval", async () => {
  let allow;
  let time = 1000000;
  const { controller, calls } = fixture({
    now: () => time,
    approve: () =>
      new Promise((resolve) => {
        allow = resolve;
      })
  });
  const first = controller.run(request());
  await assert.rejects(controller.run(request()), /busy/);
  time = 3000000;
  allow(true);
  await assert.rejects(first, /expired/);
  assert.equal(calls.length, 0);
});
test("controller code binds one page and withholds cross-origin results", async () => {
  let url = "https://example.com/";
  let clicks = 0;
  const page = {
    url: () => url,
    locator: () => ({
      ariaSnapshot: async () => "heading test",
      click: async () => {
        clicks++;
        url = "https://other.test/";
      }
    })
  };
  const invoke = (input, attach = false, target = page) =>
    runInNewContext(
      `(${chromeOperationCode(input, origins, "test_binding", attach)})`
    )(target);
  assert.equal(
    (await invoke({ operation: "snapshot" }, true)).text,
    "heading test"
  );
  await assert.rejects(
    invoke({ operation: "snapshot" }, false, { ...page }),
    /tab changed/
  );
  await assert.rejects(
    invoke({ operation: "click", selector: "button" }),
    /left approved/
  );
  await assert.rejects(invoke({ operation: "snapshot" }), /outside approved/);
  assert.equal(clicks, 1);
});
test("agent strings stay data and password/file entry is refused", async () => {
  const payload = "'); throw Error('injected'); //";
  let received;
  const page = {
    url: () => "https://example.com/",
    locator: (selector) => ({
      getAttribute: async () => "text",
      fill: async (text) => {
        received = { selector, text };
      }
    })
  };
  await runInNewContext(
    `(${chromeOperationCode({ operation: "type", selector: "#field", text: payload }, origins, "binding", true)})`
  )(page);
  assert.equal(received.text, payload);
  const secretPage = {
    url: page.url,
    locator: () => ({ getAttribute: async () => "password" })
  };
  await assert.rejects(
    runInNewContext(
      `(${chromeOperationCode({ operation: "type", selector: "input", text: "secret" }, origins, "binding", true)})`
    )(secretPage),
    /handoff/
  );
});
test("raw MCP logs and other-tab content never escape", () => {
  const parsed = parseChromeResult({
    content: [
      {
        type: "text",
        text: '### Result\n{"labChromeResult":true,"url":"https://example.com/","text":"safe"}\n### Tabs\nSECRET_OTHER_TAB'
      }
    ]
  });
  assert.equal(JSON.stringify(parsed).includes("SECRET"), false);
  assert.throws(
    () =>
      parseChromeResult({
        isError: true,
        content: [{ type: "text", text: "secret" }]
      }),
    /action failed/
  );
  assert.throws(() => parseChromeResult({ content: [] }), /Unexpected/);
});
test("pinned official MCP exposes expected internal adapter without connecting Chrome", async () => {
  const adapter = await createChromeAdapter(origins);
  await adapter.close();
});
