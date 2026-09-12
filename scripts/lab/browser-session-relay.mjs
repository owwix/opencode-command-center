#!/usr/bin/env node
/**
 * Host Playwright session relay for interactive Lab browser MCP.
 * Loopback-only URLs (127.0.0.1 / localhost). Port 3112.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { forwardConnectedChrome } from "./connected-chrome-transport.mjs";

export const SESSION_PORT = Number(
  process.env.LAB_BROWSER_SESSION_PORT ?? "3112"
);
export const SESSION_HOST = process.env.LAB_BROWSER_SESSION_HOST ?? "127.0.0.1";
const PROJECT_ID = process.env.OPENCODE_PROJECT_ID?.trim() ?? null;
const WORKSPACE_HASH = process.env.OPENCODE_WORKSPACE_HASH?.trim() ?? null;

const workspace = resolve(
  process.env.OPENCODE_WORKSPACE || process.env.PWD || process.cwd()
);
const outDir = join(workspace, "artifacts/lab-browser");

/** @type {Map<string, { browser: any, page: any }>} */
const sessions = new Map();

function authorized(header, token) {
  if (!token) return false;
  const actual = Buffer.from(String(header ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertLoopback(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("Only 127.0.0.1 and localhost are allowed.");
  }
  return parsed.toString();
}

async function getPlaywright() {
  return import("playwright");
}

async function ensureSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const playwright = await getPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const session = { browser, page };
  sessions.set(sessionId, session);
  return session;
}

export async function handleAction(body) {
  const action = String(body.action || "");
  const sessionId = String(body.sessionId || "default");

  if (action === "close") {
    const existing = sessions.get(sessionId);
    if (existing) {
      await existing.browser.close().catch(() => {});
      sessions.delete(sessionId);
    }
    return { ok: true, sessionId, closed: true };
  }

  if (action === "navigate") {
    const url = assertLoopback(String(body.url || ""));
    const session = await ensureSession(sessionId);
    const response = await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    return {
      ok: Boolean(response?.ok()),
      sessionId,
      url: session.page.url(),
      title: await session.page.title(),
      status: response?.status() ?? 0
    };
  }

  const session = await ensureSession(sessionId);
  const { page } = session;

  if (action === "snapshot") {
    const title = await page.title();
    const text = await page
      .locator("body")
      .innerText({ timeout: 5000 })
      .catch(() => "");
    return {
      ok: true,
      sessionId,
      url: page.url(),
      title,
      text: text.slice(0, 8000)
    };
  }

  if (action === "click") {
    const selector = String(body.selector || "");
    if (!selector) throw new Error("selector is required");
    await page.click(selector, { timeout: 10_000 });
    return { ok: true, sessionId, url: page.url(), title: await page.title() };
  }

  if (action === "type") {
    const selector = String(body.selector || "");
    const text = String(body.text ?? "");
    if (!selector) throw new Error("selector is required");
    await page.fill(selector, text, { timeout: 10_000 });
    return { ok: true, sessionId, url: page.url() };
  }

  if (action === "press") {
    const key = String(body.key || "");
    if (!key) throw new Error("key is required");
    await page.keyboard.press(key);
    return { ok: true, sessionId, url: page.url() };
  }

  if (action === "screenshot") {
    mkdirSync(outDir, { recursive: true });
    const name = `${sessionId}-${randomUUID().slice(0, 8)}.png`;
    const path = join(outDir, name);
    await page.screenshot({ path, fullPage: Boolean(body.fullPage) });
    return {
      ok: true,
      sessionId,
      path,
      url: page.url(),
      title: await page.title()
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startBrowserSessionRelay({
  host = SESSION_HOST,
  port = SESSION_PORT,
  token = process.env.LAB_BROWSER_SESSION_RELAY_TOKEN?.trim(),
  projectId = PROJECT_ID,
  workspaceHash = WORKSPACE_HASH
} = {}) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            service: "lab-browser-session",
            connectedChrome: 1,
            projectId,
            workspaceHash,
            sessions: sessions.size
          })
        );
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/action")) {
        if (!authorized(req.headers.authorization, token)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Authorization required." }));
          return;
        }
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body." }));
          return;
        }
        let result;
        if (body.action === "chrome") {
          const scope = JSON.parse(
            String(req.headers["x-lab-browser-scope"] || "null")
          );
          if (
            !projectId ||
            !workspaceHash ||
            scope?.projectId !== projectId ||
            scope?.workspaceHash !== workspaceHash
          )
            throw new Error(
              "Connected Chrome requires matching gateway-verified workspace scope."
            );
          result = await forwardConnectedChrome({
            scope,
            requestId: body.requestId,
            input: body.input
          });
        } else result = await handleAction(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found." }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });
  server.listen(port, host);
  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  startBrowserSessionRelay();
  console.log(
    `Lab browser session relay on http://${SESSION_HOST}:${SESSION_PORT}`
  );
}
