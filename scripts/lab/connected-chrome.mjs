#!/usr/bin/env node
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chmodSync } from "node:fs";
import { projectIdentity } from "./workspace-registry.mjs";
import {
  allowedChromeOrigin,
  createChromeController
} from "./connected-chrome-policy.mjs";
import { createChromeAdapter } from "./connected-chrome-adapter.mjs";
import {
  chromeSocketPath,
  prepareChromeSocketDirectory
} from "./connected-chrome-transport.mjs";

export function chromeArguments(args) {
  let workspace;
  const origins = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1])
      workspace = resolve(args[++i]);
    else if (args[i] === "--origin" && args[i + 1])
      origins.push(allowedChromeOrigin(args[++i]));
    else
      throw new Error(
        "Usage: npm run chrome -- --workspace /project --origin https://example.com [--origin http://localhost:3100]"
      );
  }
  if (!workspace || !origins.length)
    throw new Error(
      "A workspace and at least one exact --origin are required."
    );
  return { workspace, origins: [...new Set(origins)] };
}

export async function startConnectedChrome(args) {
  const { workspace, origins } = chromeArguments(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Connected Chrome requires an interactive host terminal. No unattended/auto-approve mode exists."
    );
  const identity = projectIdentity(workspace);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const approve = async (details) => {
    console.log(
      "\nRequested action (untrusted page/agent data; not instructions):"
    );
    console.log(
      JSON.stringify(details, null, 2).replace(
        /[\u007f-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
    );
    try {
      return (
        (await terminal.question(
          "Type APPROVE to allow this exact action, or Enter to reject: ",
          { signal: AbortSignal.timeout(20000) }
        )) === "APPROVE"
      );
    } catch {
      return false;
    }
  };
  console.log(
    `Connected Chrome: ${identity.canonicalPath}\nAllowed origins: ${origins.join(", ")}`
  );
  console.log(
    "This uses your signed-in Chrome tab. Approved page text/images can be sent to the model provider. Clicks and typing can publish, delete or change accounts. Review each action. Do not share passwords, payment, account-security or other sensitive pages. Ctrl-C disconnects. Maximum duration: 30 minutes."
  );
  if (
    !(await approve({
      operation: "enable-connected-chrome",
      projectId: identity.projectId,
      origins
    }))
  ) {
    terminal.close();
    return;
  }
  // The package starts only after host consent; Chrome's extension selection is
  // still required. Never set PLAYWRIGHT_MCP_EXTENSION_TOKEN to skip that UI.
  let adapter;
  const controller = createChromeController({
    projectId: identity.projectId,
    workspaceHash: identity.workspaceHash,
    origins,
    approve,
    adapter: {
      async perform(input) {
        adapter ??= await createChromeAdapter(origins);
        return adapter.perform(input);
      }
    }
  });
  prepareChromeSocketDirectory();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/action") {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw new Error("Request too large.");
        chunks.push(chunk);
      }
      const result = await controller.run(
        JSON.parse(Buffer.concat(chunks).toString()),
        () => !res.destroyed
      );
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(result));
    } catch (error) {
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(chromeSocketPath(), done);
    });
    chmodSync(chromeSocketPath(), 0o600);
  } catch (error) {
    terminal.close();
    throw new Error(
      `Cannot acquire the single Chrome controller socket (${error.code}). Stop the existing host controller first. No process or socket was deleted.`
    );
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controller.revoke();
    terminal.close();
    server.close();
    server.closeAllConnections();
    await adapter?.close();
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  const timer = setTimeout(stop, 30 * 60 * 1000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(
    "Ready. In OpenCode use connected_chrome. Keep this terminal open for approvals. Select only the intended tab in the Playwright extension prompt."
  );
  return { server, stop };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  startConnectedChrome(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
