import { createServer } from "node:http";
import {
  commentOnGitHubThread,
  createGitHubIssue,
  listGitHubIssues,
  listGitHubPullRequests,
  preparePullRequest,
  publishStatus,
  pushReviewedBranch,
  redactPublishOutput,
  viewGitHubIssue,
  viewGitHubPullRequest
} from "./publish-boundary.mjs";
import {
  assertCapabilityScope,
  verifyCapabilityLease
} from "../../docker/agent-gateway/capability-lease.mjs";

const HOST = process.env.GITHUB_PUBLISH_RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.GITHUB_PUBLISH_RELAY_PORT || 8794);
const TOKEN = process.env.GITHUB_PUBLISH_RELAY_TOKEN?.trim();
const WORKSPACE = process.env.GITHUB_PUBLISH_WORKSPACE?.trim();
const CAPABILITY_KEY = process.env.AGENT_GATEWAY_SIGNING_KEY?.trim();
const WORKSPACE_HASH = process.env.OPENCODE_WORKSPACE_HASH?.trim();
const PROJECT_ID = process.env.OPENCODE_PROJECT_ID?.trim();
const SESSION_ID = process.env.OPENCODE_LAUNCH_SESSION_ID?.trim();
const RUN_ID = process.env.OPENCODE_RUN_ID?.trim();
const MAX_BODY_BYTES = 32 * 1024;

if (!TOKEN || TOKEN.length < 32) {
  throw new Error("GITHUB_PUBLISH_RELAY_TOKEN must be at least 32 characters.");
}
if (!WORKSPACE) throw new Error("GITHUB_PUBLISH_WORKSPACE is required.");
if (
  !CAPABILITY_KEY ||
  !WORKSPACE_HASH ||
  !PROJECT_ID ||
  !SESSION_ID ||
  !RUN_ID
) {
  throw new Error("GitHub relay capability validation is not configured.");
}

const workspace = WORKSPACE;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function authorized(req) {
  const header = req.headers.authorization || "";
  return header === `Bearer ${TOKEN}`;
}

function authorizedCapability(req, action) {
  const lease = String(req.headers["x-opencode-capability-lease"] ?? "");
  const claims = verifyCapabilityLease(lease, {
    key: CAPABILITY_KEY,
    workspaceHash: WORKSPACE_HASH,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID
  });
  return assertCapabilityScope(claims, {
    route: "github-publish",
    action
  });
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function createHandler() {
  return async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, {
        ok: true,
        service: "github-publish-relay",
        projectId: PROJECT_ID,
        workspaceHash: WORKSPACE_HASH
      });
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/")) {
      json(res, 404, { error: "Not found" });
      return;
    }
    if (!authorized(req)) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const action = req.url.slice("/v1/".length);
      authorizedCapability(req, action);
      if (req.url === "/v1/status") {
        json(res, 200, publishStatus({ workspace }));
        return;
      }
      const body = await readJson(req);
      if (req.url === "/v1/pulls") {
        json(res, 200, listGitHubPullRequests({ workspace }));
        return;
      }
      if (req.url === "/v1/pull") {
        json(
          res,
          200,
          viewGitHubPullRequest({ workspace, number: body.number })
        );
        return;
      }
      if (req.url === "/v1/issues") {
        json(res, 200, listGitHubIssues({ workspace }));
        return;
      }
      if (req.url === "/v1/issue") {
        json(res, 200, viewGitHubIssue({ workspace, number: body.number }));
        return;
      }
      if (req.url === "/v1/issue-create") {
        json(
          res,
          200,
          createGitHubIssue({ workspace, title: body.title, body: body.body })
        );
        return;
      }
      if (req.url === "/v1/comment") {
        json(
          res,
          200,
          commentOnGitHubThread({
            workspace,
            kind: body.kind,
            number: body.number,
            body: body.body
          })
        );
        return;
      }
      if (req.url === "/v1/push") {
        json(
          res,
          200,
          pushReviewedBranch({
            workspace,
            expectedBranch: body.expectedBranch,
            expectedHeadSha: body.expectedHeadSha
          })
        );
        return;
      }
      if (req.url === "/v1/pr") {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const description =
          typeof body.body === "string" ? body.body.trim() : "";
        const base =
          typeof body.base === "string" && body.base.trim()
            ? body.base.trim()
            : "main";
        if (!title || title.length > 200)
          throw new Error("A PR title up to 200 characters is required.");
        if (description.length > 20_000)
          throw new Error("PR body is too long.");
        if (base !== "main")
          throw new Error("PRs may only target main through this relay.");
        json(
          res,
          200,
          preparePullRequest({
            workspace,
            title,
            body: description,
            base,
            expectedBranch: body.expectedBranch,
            expectedHeadSha: body.expectedHeadSha
          })
        );
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      const capabilityFailure = /Capability lease/iu.test(
        error instanceof Error ? error.message : String(error)
      );
      json(res, capabilityFailure ? 403 : 400, {
        error: redactPublishOutput(
          error instanceof Error ? error.message : String(error)
        )
      });
    }
  };
}

const server = createServer(createHandler());
server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ok: true, host: HOST, port: PORT }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
