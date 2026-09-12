import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// This code is controller-owned. No agent-supplied JavaScript, filenames, CDP
// endpoints or MCP tool names are accepted. Inputs are serialized as JSON data.
export function chromeOperationCode(input, origins, binding, attach = false) {
  return `async (page) => {
    const input = ${JSON.stringify(input)};
    const origins = ${JSON.stringify(origins)};
    const binding = ${JSON.stringify(binding)};
    const allowed = () => origins.some(origin => page.url() === origin || page.url().startsWith(origin + '/'));
    if (!allowed()) throw new Error('Selected tab is outside approved origins.');
    if (${attach}) Object.defineProperty(page, binding, {value: true});
    if (!page[binding]) throw new Error('Selected tab changed. Reconnect on the host.');
    let result = {};
    if (input.operation === 'snapshot') result.text = (await page.locator('body').ariaSnapshot()).slice(0, 16000);
    else if (input.operation === 'screenshot') result.image = (await page.screenshot({type: 'png'})).toString('base64');
    else if (input.operation === 'navigate') await page.goto(input.url, {waitUntil: 'domcontentloaded', timeout: 15000});
    else if (input.operation === 'click') await page.locator(input.selector).click({timeout: 10000});
    else if (input.operation === 'type') {
      const element = page.locator(input.selector);
      if ((await element.getAttribute('type')) === 'password' || (await element.getAttribute('type')) === 'file')
        throw new Error('Password entry and file uploads require user handoff.');
      await element.fill(input.text, {timeout: 10000});
    } else if (input.operation === 'press') await page.keyboard.press(input.key);
    if (!allowed()) throw new Error('Tab left approved origins; no page content returned.');
    return {labChromeResult: true, url: page.url(), ...result};
  }`;
}

export function parseChromeResult(response) {
  if (response.isError)
    throw new Error(
      "Chrome action failed. Check the selected tab; do not retry mutations blindly."
    );
  // Never forward MCP's automatic snapshots, logs, generated code or other tabs.
  for (const item of response.content ?? []) {
    if (item.type !== "text") continue;
    const match = item.text.match(/(?:^|\n)\{"labChromeResult":true,[^\n]*\}/);
    if (!match) continue;
    const result = JSON.parse(match[0].trim());
    if (result.image?.length > 8 * 1024 * 1024)
      throw new Error("Screenshot exceeds size limit.");
    return {
      ok: true,
      url: result.url,
      ...(typeof result.text === "string"
        ? { text: result.text.slice(0, 16000) }
        : {}),
      ...(typeof result.image === "string" ? { image: result.image } : {})
    };
  }
  throw new Error(
    "Unexpected Chrome adapter result; upgrade compatibility must be checked."
  );
}

export async function createChromeAdapter(origins) {
  const { createConnection } = await import("@playwright/mcp");
  const server = await createConnection({
    extension: true,
    browser: { browserName: "chromium" },
    snapshot: { mode: "none" },
    imageResponses: "omit",
    codegen: "none",
    timeouts: { action: 10000, navigation: 15000 }
  });
  const client = new Client({ name: "lab-connected-chrome", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === "browser_run_code_unsafe")) {
    await client.close();
    await server.close();
    throw new Error("Pinned Playwright MCP adapter is incompatible.");
  }
  const binding = `__labChrome_${randomUUID().replaceAll("-", "")}`;
  let attached = false;
  return {
    async perform(input) {
      const result = await client.callTool(
        {
          name: "browser_run_code_unsafe",
          arguments: {
            code: chromeOperationCode(input, origins, binding, !attached)
          }
        },
        undefined,
        { timeout: 45000 }
      );
      const parsed = parseChromeResult(result);
      attached = true;
      return parsed;
    },
    async close() {
      await client.close();
      await server.close();
    }
  };
}
