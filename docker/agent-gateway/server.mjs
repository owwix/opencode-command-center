import { createAgentGateway } from "./gateway.mjs";
import { createLeaseTransport } from "./lease-transport.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const port = Number(process.env.AGENT_GATEWAY_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("AGENT_GATEWAY_PORT must be a valid TCP port.");
}

const capabilities = [
  "chat",
  ...(process.env.OPENAI_API_KEY?.trim() ? ["openai-chat"] : []),
  ...(process.env.GOOGLE_CLOUD_PROJECT?.trim() ? ["vertex-chat"] : []),
  "image",
  "quality",
  "open-design",
  ...(process.env.NOTION_PUBLISHER_TOKEN?.trim() ? ["notion-publish"] : []),
  ...(process.env.GITHUB_PUBLISH_RELAY_TOKEN?.trim() &&
  process.env.GITHUB_PUBLISH_RELAY_URL?.trim()
    ? ["github-publish"]
    : []),
  ...(process.env.OPENPETS_RELAY_TOKEN?.trim() &&
  process.env.OPENPETS_RELAY_URL?.trim()
    ? ["openpets"]
    : []),
  ...(process.env.LAB_BROWSER_VERIFY_RELAY_TOKEN?.trim() &&
  process.env.LAB_BROWSER_VERIFY_RELAY_URL?.trim()
    ? ["browser-verify"]
    : []),
  ...(process.env.LAB_BROWSER_SESSION_RELAY_TOKEN?.trim() &&
  process.env.LAB_BROWSER_SESSION_RELAY_URL?.trim()
    ? ["browser-session"]
    : []),
  ...(process.env.ARTIFACT_DOWNLOAD_ALLOWLIST?.trim() ? ["artifact"] : [])
];

const server = createAgentGateway(
  {
    gatewaySigningKey: required("AGENT_GATEWAY_SIGNING_KEY"),
    expectedWorkspaceHash: required("OPENCODE_WORKSPACE_HASH"),
    expectedProjectId: required("OPENCODE_PROJECT_ID"),
    expectedSessionId: required("OPENCODE_LAUNCH_SESSION_ID"),
    expectedRunId: required("OPENCODE_RUN_ID"),
    cloudflareAccountId: required("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareApiToken: required("CLOUDFLARE_API_TOKEN"),
    ...(process.env.OPENAI_API_KEY?.trim()
      ? { openaiApiKey: required("OPENAI_API_KEY") }
      : {}),
    ...(process.env.GOOGLE_CLOUD_PROJECT?.trim()
      ? { googleCloudProject: required("GOOGLE_CLOUD_PROJECT") }
      : {}),
    qualityMcpToken: required("QUALITY_MCP_TOKEN"),
    qualityRegistrationToken: required("QUALITY_REGISTRATION_TOKEN"),
    openDesignToken: required("OD_API_TOKEN"),
    ...(process.env.NOTION_PUBLISHER_TOKEN?.trim()
      ? {
          notionPublisherToken: required("NOTION_PUBLISHER_TOKEN"),
          notionPublisherUrl:
            process.env.NOTION_PUBLISHER_URL?.trim() ??
            "http://notion-publisher:8796"
        }
      : {}),
    ...(process.env.GITHUB_PUBLISH_RELAY_TOKEN?.trim() &&
    process.env.GITHUB_PUBLISH_RELAY_URL?.trim()
      ? {
          githubRelayToken: process.env.GITHUB_PUBLISH_RELAY_TOKEN.trim(),
          githubRelayUrl: process.env.GITHUB_PUBLISH_RELAY_URL.trim()
        }
      : {}),
    ...(process.env.OPENPETS_RELAY_TOKEN?.trim() &&
    process.env.OPENPETS_RELAY_URL?.trim()
      ? {
          openPetsRelayToken: process.env.OPENPETS_RELAY_TOKEN.trim(),
          openPetsRelayUrl: process.env.OPENPETS_RELAY_URL.trim()
        }
      : {}),
    ...(process.env.LAB_BROWSER_VERIFY_RELAY_TOKEN?.trim() &&
    process.env.LAB_BROWSER_VERIFY_RELAY_URL?.trim()
      ? {
          browserVerifyRelayToken:
            process.env.LAB_BROWSER_VERIFY_RELAY_TOKEN.trim(),
          browserVerifyRelayUrl: process.env.LAB_BROWSER_VERIFY_RELAY_URL.trim()
        }
      : {}),
    ...(process.env.LAB_BROWSER_SESSION_RELAY_TOKEN?.trim() &&
    process.env.LAB_BROWSER_SESSION_RELAY_URL?.trim()
      ? {
          browserSessionRelayToken:
            process.env.LAB_BROWSER_SESSION_RELAY_TOKEN.trim(),
          browserSessionRelayUrl:
            process.env.LAB_BROWSER_SESSION_RELAY_URL.trim()
        }
      : {}),
    ...(process.env.ARTIFACT_DOWNLOAD_ALLOWLIST?.trim()
      ? { artifactAllowlist: process.env.ARTIFACT_DOWNLOAD_ALLOWLIST.trim() }
      : {})
  },
  { capabilities }
);

const transportEnabled = Boolean(process.env.AGENT_TRANSPORT_TOKEN);
const authorityPort = transportEnabled ? port + 1 : port;
const transport = transportEnabled
  ? createLeaseTransport({
      token: required("AGENT_TRANSPORT_TOKEN"),
      leasePath: "/run/lease/lease.json",
      upstreamPort: authorityPort
    })
  : null;
server.listen(
  authorityPort,
  transportEnabled ? "127.0.0.1" : process.env.AGENT_GATEWAY_HOST || "0.0.0.0",
  () => console.log(`Agent credential gateway listening on port ${port}`)
);
transport?.listen(port, process.env.AGENT_GATEWAY_HOST || "0.0.0.0");

function shutdown() {
  transport?.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
