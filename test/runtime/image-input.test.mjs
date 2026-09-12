import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

function pngFixture() {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test(
  "real OpenCode delivers PNG bytes to an image-capable provider",
  { skip: process.env.LAB_RUNTIME_TESTS !== "1", timeout: 120000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "lab-image-test-"));
    const suffix = randomUUID().replaceAll("-", "");
    const network = `lab-image-${suffix}`;
    const provider = `lab-image-provider-${suffix}`;
    const client = `lab-image-client-${suffix}`;
    const image =
      process.env.LAB_RUNTIME_IMAGE ?? "opencode-lab-opencode:local";
    const docker = (args) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 100000,
        stdio: ["ignore", "pipe", "pipe"]
      });
    try {
      writeFileSync(join(root, "input.png"), pngFixture());
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          model: "fixture/vision",
          small_model: "fixture/vision",
          plugin: [],
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: "http://fixture:8799/v1",
                apiKey: "fixture-only"
              },
              models: {
                vision: {
                  name: "Vision fixture",
                  attachment: true,
                  modalities: { input: ["text", "image"], output: ["text"] },
                  limit: { context: 32768, output: 4096 }
                }
              }
            }
          }
        })
      );
      docker(["network", "create", "--internal", network]);
      docker([
        "run",
        "-d",
        "--name",
        provider,
        "--network",
        network,
        "--network-alias",
        "fixture",
        "--mount",
        `type=bind,src=${resolve("test/runtime/model-server.mjs")},dst=/fixture.mjs,readonly`,
        "--entrypoint",
        "node",
        image,
        "/fixture.mjs"
      ]);
      const output = docker([
        "run",
        "--rm",
        "--name",
        client,
        "--network",
        network,
        "--read-only",
        "--user",
        "0:0",
        "--tmpfs",
        "/tmp:exec",
        "--tmpfs",
        "/home/opencode",
        "--mount",
        `type=bind,src=${root},dst=/workspace`,
        "--workdir",
        "/workspace",
        "--env",
        "OPENCODE_CONFIG=/workspace/config.json",
        "--entrypoint",
        "opencode",
        image,
        "run",
        "IMAGE_FIXTURE inspect the attached image",
        "--file",
        "/workspace/input.png",
        "--model",
        "fixture/vision",
        "--format",
        "json"
      ]);
      assert.match(output, /IMAGE_BYTES_RECEIVED/);
      assert.doesNotMatch(output, /IMAGE_MISSING/);
    } finally {
      for (const name of [client, provider]) {
        try {
          docker(["rm", "-f", name]);
        } catch {}
      }
      try {
        docker(["network", "rm", network]);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }
);
