import { request } from "node:http";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function chromeSocketPath() {
  return join(
    "/tmp",
    `opencode-connected-chrome-${process.getuid()}`,
    "relay.sock"
  );
}
export function prepareChromeSocketDirectory() {
  const directory = join(
    "/tmp",
    `opencode-connected-chrome-${process.getuid()}`
  );
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new Error("Unsafe Connected Chrome socket directory.");
  chmodSync(directory, 0o700);
}
export function forwardConnectedChrome(
  payload,
  socketPath = chromeSocketPath()
) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        socketPath,
        path: "/action",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        let length = 0;
        res.on("data", (chunk) => {
          length += chunk.length;
          if (length > 9 * 1024 * 1024) {
            res.destroy();
            reject(new Error("Chrome response too large."));
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200)
              reject(new Error(result.error || "Chrome request rejected."));
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(90000, () =>
      req.destroy(new Error("Chrome approval/action timed out."))
    );
    req.on("error", () =>
      reject(
        new Error(
          "Connected Chrome is unavailable or timed out. Start the host chrome command; do not retry mutations blindly."
        )
      )
    );
    req.end(body);
  });
}
