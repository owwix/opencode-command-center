const gatewayUrl = (
  process.env.GITHUB_PUBLISH_GATEWAY_URL || "http://agent-gateway:8787"
).trim();
const gatewayToken = process.env.AGENT_GATEWAY_TOKEN?.trim();

if (!gatewayToken) {
  throw new Error("Agent gateway is not configured for GitHub publishing.");
}

async function call(path, body = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(130_000)
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { error: `Relay returned HTTP ${response.status}.` };
  }
  if (!response.ok)
    throw new Error(payload.error || `Relay returned HTTP ${response.status}.`);
  return payload;
}

const tools = [
  {
    name: "github_status",
    description:
      "Read the current workspace branch, GitHub origin, and clean/dirty state. Does not expose credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "github_push",
    description:
      "Push the reviewed current non-protected branch to its GitHub origin. Requires explicit approval and refuses dirty workspaces or force-pushes.",
    inputSchema: {
      type: "object",
      properties: {
        expectedBranch: {
          type: "string",
          description: "Branch returned by github_status during review"
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "github_list_pull_requests",
    description:
      "List open pull requests for this workspace's GitHub origin. Uses host authentication without exposing credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "github_view_pull_request",
    description: "Read one pull request from this workspace's GitHub origin.",
    inputSchema: {
      type: "object",
      required: ["number"],
      properties: { number: { type: "integer", minimum: 1 } },
      additionalProperties: false
    }
  },
  {
    name: "github_list_issues",
    description:
      "List open issues for this workspace's GitHub origin. Uses host authentication without exposing credentials.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "github_view_issue",
    description: "Read one issue from this workspace's GitHub origin.",
    inputSchema: {
      type: "object",
      required: ["number"],
      properties: { number: { type: "integer", minimum: 1 } },
      additionalProperties: false
    }
  },
  {
    name: "github_create_issue",
    description:
      "Create an issue in this workspace's GitHub origin. Requires explicit approval.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "github_comment",
    description:
      "Comment on an issue or pull request in this workspace's GitHub origin. Requires explicit approval.",
    inputSchema: {
      type: "object",
      required: ["kind", "number", "body"],
      properties: {
        kind: { type: "string", enum: ["issue", "pr"] },
        number: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1, maxLength: 20000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "github_open_pr",
    description:
      "Push the reviewed current non-protected branch and open a pull request to main. Requires explicit approval.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", maxLength: 20000 },
        base: { type: "string", description: "Only main is supported" }
      },
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
  const method = message.method;
  if (id === undefined) return;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "github-publish", version: "1.0.0" }
      }
    });
    return;
  }
  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    try {
      let value;
      if (name === "github_status") value = await call("/github/status");
      else if (name === "github_push")
        value = await call("/github/push", {
          expectedBranch: message.params?.arguments?.expectedBranch
        });
      else if (name === "github_list_pull_requests")
        value = await call("/github/pulls");
      else if (name === "github_view_pull_request")
        value = await call("/github/pull", message.params?.arguments || {});
      else if (name === "github_list_issues")
        value = await call("/github/issues");
      else if (name === "github_view_issue")
        value = await call("/github/issue", message.params?.arguments || {});
      else if (name === "github_create_issue")
        value = await call(
          "/github/issue-create",
          message.params?.arguments || {}
        );
      else if (name === "github_comment")
        value = await call("/github/comment", message.params?.arguments || {});
      else if (name === "github_open_pr")
        value = await call("/github/pr", message.params?.arguments || {});
      else throw new Error(`Unknown tool: ${name}`);
      write({ jsonrpc: "2.0", id, result: textResult(value) });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          ...textResult({
            error: error instanceof Error ? error.message : String(error)
          }),
          isError: true
        }
      });
    }
    return;
  }
  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
});
