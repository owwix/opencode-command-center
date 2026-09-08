#!/usr/bin/env node
/**
 * Host-side: ensure the opencode-preview relay is up for Lab app ports.
 * Run from the OpenCode Command Center checkout on the Mac, not from inside the agent container.
 * If 3100/3101 are already published by a workspace compose stack, leave them.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const envFile = resolve(root, "opencode.env");

function probing(port) {
  return new Promise((resolveProbe) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 500 },
      (res) => {
        res.resume();
        resolveProbe(true);
      }
    );
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
  });
}

function portListening(port) {
  return (
    spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8"
    }).status === 0
  );
}

const already =
  (await probing(3100)) ||
  (await probing(3101)) ||
  portListening(3100) ||
  portListening(3101);

if (already) {
  console.log("Preview ports already published on this Mac.");
  console.log("  http://127.0.0.1:3100  <- app primary");
  console.log("  http://127.0.0.1:3101  <- app secondary");
  process.exit(0);
}

if (!existsSync(envFile)) {
  console.error("Missing opencode.env. Run npm run opencode:setup first.");
  process.exit(1);
}

const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    envFile,
    "-f",
    "docker-compose.opencode.yml",
    "up",
    "-d",
    "--build",
    "opencode-preview"
  ],
  { cwd: root, stdio: "inherit", encoding: "utf8" }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("");
console.log("Preview relay ready on this Mac:");
console.log("  http://127.0.0.1:3100  <- container :3000");
console.log("  http://127.0.0.1:3101  <- container :3001");
