import { agentArgument } from "../../opencode-tooling.mjs";
import { packAgentConfig } from "../pack-loader.mjs";

export function buildLaunchCapabilityScope(context) {
  const {
    args,
    envValue,
    isForegroundLaunch,
    isNotionStart,
    packSet,
    taskRoute,
    tooling
  } = context;
  const routes = ["chat", "quality"];
  const actions = ["chat:invoke", "quality:mcp"];
  if (isForegroundLaunch) {
    routes.push(
      "browser-session",
      "browser-verify",
      "github-publish",
      "openpets"
    );
    actions.push(
      "quality:read",
      "quality:operate",
      "browser-session:control",
      "browser-verify:verify",
      "github-publish:status",
      "github-publish:pulls",
      "github-publish:pull",
      "github-publish:issues",
      "github-publish:issue",
      "github-publish:issue-create",
      "github-publish:comment",
      "openpets:react"
    );
  }
  if (envValue("OPENAI_API_KEY")) {
    routes.push("openai-chat");
    actions.push("openai-chat:invoke");
  }
  if (envValue("GOOGLE_CLOUD_PROJECT")) {
    routes.push("vertex-chat");
    actions.push("vertex-chat:invoke");
  }
  if (tooling.design) {
    routes.push("open-design");
    actions.push("open-design:mcp");
  }
  const contributed = packAgentConfig(
    packSet,
    taskRoute?.agent ?? agentArgument(args)
  );
  if (contributed?.capabilities.includes("image")) {
    routes.push("image");
    actions.push("image:generate");
  }
  if (isNotionStart) {
    routes.push("notion-publish");
    actions.push("notion-publish:publish");
  }
  if (envValue("ARTIFACT_DOWNLOAD_ALLOWLIST")) {
    routes.push("artifact");
    actions.push("artifact:download");
  }
  return { routes, actions };
}
