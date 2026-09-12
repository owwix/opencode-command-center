#!/usr/bin/env node
/**
 * MCP stdio bridge to the host Playwright session relay through the scoped
 * agent gateway. OpenCode never connects to the host relay directly.
 */
import { randomUUID } from "node:crypto";
const gatewayBase = (
  process.env.WORKERS_AI_GATEWAY_URL || "http://agent-gateway:8787"
).replace(/\/$/u, "");
const capabilityLease = process.env.AGENT_GATEWAY_TOKEN?.trim();

async function call(action, params = {}) {
  if (!capabilityLease) throw new Error("Agent capability lease is required.");
  try {
    const response = await fetch(`${gatewayBase}/browser/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capabilityLease}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action, ...params }),
      signal: AbortSignal.timeout(action === "chrome" ? 100_000 : 60_000)
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

const tools = [
  {
    name: "connected_chrome",
    description:
      "Opt-in control of one existing Chrome tab through the host approval terminal. Requires npm run chrome on the host. Every action (including reads) needs host approval. Never retry an uncertain mutation blindly. No credentials, uploads, arbitrary code or tab switching.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["snapshot", "screenshot", "navigate", "click", "type", "press"]
        },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        key: { type: "string" }
      }
    }
  },
  {
    name: "browser_navigate",
    description:
      "Navigate the Lab browser session to a Mac loopback URL (127.0.0.1:3100/3101/3110 only).",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_snapshot",
    description: "Read current page URL, title, and body text (truncated).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "browser_click",
    description: "Click a CSS selector on the current page.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string" },
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_type",
    description: "Fill a CSS selector with text.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_press",
    description: "Press a keyboard key (e.g. Enter, Tab).",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG under artifacts/lab-browser/ on the Mac workspace.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        fullPage: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_close",
    description: "Close the Playwright session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      additionalProperties: false
    }
  }
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const id = message.id;
  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lab-browser", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    try {
      if (name === "connected_chrome") {
        const result = await call("chrome", {
          requestId: randomUUID(),
          input: args
        });
        const { image, ...details } = result;
        const content = [{ type: "text", text: JSON.stringify(details) }];
        if (image)
          content.push({ type: "image", mimeType: "image/png", data: image });
        write({ jsonrpc: "2.0", id, result: { content } });
        return;
      }
      const map = {
        browser_navigate: "navigate",
        browser_snapshot: "snapshot",
        browser_click: "click",
        browser_type: "type",
        browser_press: "press",
        browser_screenshot: "screenshot",
        browser_close: "close"
      };
      const action = map[name];
      if (!action) throw new Error(`Unknown tool: ${name}`);
      const result = await call(action, args);
      write({ jsonrpc: "2.0", id, result: textResult(result) });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }
          ],
          isError: true
        }
      });
    }
    return;
  }
  if (id !== undefined) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
});
