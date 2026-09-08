import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { lookupRegistration } from "../lab/workspace-registry.mjs";
import { labStateRoot } from "../lab/host-state.mjs";
import { reconcileDurableRuns } from "../quality/run-service.mjs";
import { buildRunView } from "../quality/run-view.mjs";
import { buildRunArtifactIndex } from "../quality/run-artifacts.mjs";
import {
  listProjectNotifications,
  syncRunNotifications
} from "../quality/run-notifications.mjs";
import {
  controllerDetails,
  controllerSync,
  hostRegistryPath,
  jsonTool,
  limitsSchema,
  listRunViews,
  operateRun,
  requireRegisteredRun,
  registeredPolicy,
  startManagedRun,
  startParallelRuns,
  stateRoot
} from "./run-operations.mjs";

void labStateRoot;

export {
  listRunViews,
  operateRun,
  parseJsonOutput,
  resolveAllowedWorkspace,
  startManagedRun,
  startParallelRuns,
  validateParallelRequest
} from "./run-operations.mjs";

function getServer(registrationToken) {
  const { registration, packSet, profiles } =
    registeredPolicy(registrationToken);
  const managedKinds = Object.keys(profiles);
  const managedKindSchema = z.enum(managedKinds);
  reconcileDurableRuns({ root: stateRoot });
  const server = new McpServer({ name: "quality", version: "1.0.0" });
  server.registerTool(
    "list_managed_run_kinds",
    {
      description:
        "List generic and loaded-pack managed-run kinds available in this Lab launch."
    },
    async () =>
      jsonTool({
        kinds: managedKinds.map((kind) => ({ kind, agent: profiles[kind] })),
        packs: packSet.packs.map(({ id, label, version }) => ({
          id,
          label,
          version
        }))
      })
  );
  server.registerTool(
    "start_managed_run",
    {
      description:
        "Start an isolated host-managed OpenCode run with verification and independent review. Supported kinds come from core and loaded packs.",
      inputSchema: {
        kind: managedKindSchema,
        task: z.string().min(4).max(4000),
        workspace: z.string().min(1),
        release: z.boolean().optional(),
        idempotency_key: z.string().min(8).max(200).optional(),
        limits: limitsSchema
      }
    },
    async (input) => jsonTool(startManagedRun(input, { registrationToken }))
  );
  server.registerTool(
    "start_parallel_runs",
    {
      description:
        "Start 2-4 independent managed runs for one Git workspace. Each run receives its own worktree, limits, verification, and review. The batch is duplicate-suppressed for five minutes.",
      inputSchema: {
        workspace: z.string().min(1),
        runs: z
          .array(
            z.object({
              kind: managedKindSchema,
              task: z.string().min(4).max(4000),
              release: z.boolean().optional(),
              limits: limitsSchema
            })
          )
          .min(2)
          .max(4)
      }
    },
    async (input) => jsonTool(startParallelRuns(input, { registrationToken }))
  );
  server.registerTool(
    "cancel_run",
    {
      description:
        "Cancel a managed run and terminate its active process group. Safe to retry for an already-cancelled run.",
      inputSchema: {
        run_id: z.string().min(8),
        reason: z.string().min(1).max(500).optional()
      }
    },
    async ({ run_id, reason }) => {
      requireRegisteredRun(run_id, registration);
      const args = ["cancel", "--run", run_id];
      if (reason) args.push("--reason", reason);
      return jsonTool(controllerSync(args));
    }
  );
  server.registerTool(
    "get_run_status",
    {
      description: "Read one managed quality run and its evidence state.",
      inputSchema: { run_id: z.string().min(8) }
    },
    async ({ run_id }) => {
      requireRegisteredRun(run_id, registration);
      return jsonTool(controllerSync(["status", "--run", run_id]));
    }
  );
  server.registerTool(
    "list_runs",
    {
      description: "List managed quality runs. Read-only.",
      inputSchema: {}
    },
    async () => jsonTool(listRunViews(registration))
  );
  return server;
}

function authorized(request, token) {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function requestRegistration(registrationToken) {
  if (!registrationToken) return null;
  try {
    return lookupRegistration(
      process.env.OPENCODE_LAB_REGISTRY_PATH ?? hostRegistryPath,
      registrationToken
    );
  } catch {
    return null;
  }
}

export async function handleQualityMcp(request, token) {
  const url = new URL(request.url);
  const registrationToken = request.headers.get("x-lab-registration-token");
  const registration = requestRegistration(registrationToken);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      service: "quality",
      projectId: registration?.projectId ?? null,
      workspaceHash: registration?.workspaceHash ?? null
    });
  }
  if (!token || !authorized(request, token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!registration) {
    return new Response("Launch registration is invalid.", { status: 401 });
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    try {
      return Response.json({ runs: listRunViews(registration) });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
  if (request.method === "GET" && url.pathname === "/notifications") {
    return Response.json({
      notifications: listProjectNotifications({
        root: stateRoot,
        projectId: registration.projectId
      })
    });
  }
  const runMatch = url.pathname.match(
    /^\/runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,159})$/u
  );
  if (request.method === "GET" && runMatch) {
    try {
      const record = requireRegisteredRun(runMatch[1], registration);
      const controller = controllerDetails(record);
      const artifactIndex = buildRunArtifactIndex({
        root: stateRoot,
        durable: record,
        controller
      });
      syncRunNotifications({
        root: stateRoot,
        durable: record,
        controller,
        artifactIndex
      });
      return Response.json(
        buildRunView({
          durable: record,
          controller,
          artifactIndex,
          notifications: listProjectNotifications({
            root: stateRoot,
            projectId: registration.projectId,
            runId: record.id
          }),
          root: stateRoot
        })
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 404 }
      );
    }
  }
  const artifactMatch = url.pathname.match(
    /^\/runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,159})\/artifacts$/u
  );
  if (request.method === "GET" && artifactMatch) {
    try {
      const record = requireRegisteredRun(artifactMatch[1], registration);
      return Response.json(
        buildRunArtifactIndex({
          root: stateRoot,
          durable: record,
          controller: controllerDetails(record)
        })
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 404 }
      );
    }
  }
  const actionMatch = url.pathname.match(
    /^\/runs\/([A-Za-z0-9][A-Za-z0-9_.-]{0,159})\/actions\/([a-z-]+)$/u
  );
  if (request.method === "POST" && actionMatch) {
    try {
      const input = await request.json().catch(() => ({}));
      return Response.json(
        operateRun({
          runId: actionMatch[1],
          action: actionMatch[2],
          input,
          registration
        })
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 409 }
      );
    }
  }
  if (url.pathname !== "/mcp" || request.method === "GET") {
    return new Response("Not found", { status: 404 });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = getServer(registrationToken);
  await server.connect(transport);
  return transport.handleRequest(request);
}
