import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";

export function readGlobalGitConfig(key) {
  try {
    return execFileSync("git", ["config", "--global", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

export function startOAuthRelay({ authContainerName, safeHostEnvironment }) {
  return new Promise((resolveRelay, rejectRelay) => {
    const relay = createServer((request, response) => {
      if (!request.url?.startsWith("/mcp/oauth/callback")) {
        response.writeHead(404).end();
        return;
      }

      const callbackUrl = `http://127.0.0.1:19876${request.url}`;
      const forward = spawn(
        "docker",
        ["exec", authContainerName, "/usr/bin/wget", "-qO-", callbackUrl],
        { env: safeHostEnvironment() }
      );

      forward.stdout.pipe(response);
      forward.on("error", (error) => {
        response
          .writeHead(502)
          .end(`Could not complete OAuth callback: ${error.message}`);
      });
      forward.on("close", (code) => {
        if (code && !response.headersSent) response.writeHead(502);
        response.end();
      });
    });

    relay.once("error", rejectRelay);
    relay.listen(19876, "127.0.0.1", () => resolveRelay(relay));
  });
}
