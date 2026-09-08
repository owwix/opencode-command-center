/** Trusted Docker launcher. Workspace ownership, scoped capabilities and
 * credential isolation are documented in docs/architecture.md. */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, delimiter, join, resolve } from "node:path";
import { parseTaskInvocation, routeTask } from "./opencode-routing.mjs";
import {
  applyAutoApproveArgs,
  readLabPreferences
} from "./opencode-preferences.mjs";
import {
  agentArgument,
  parseLauncherFlags,
  selectTooling
} from "./opencode-tooling.mjs";
import { buildLaunchCapabilityScope } from "./lab/launcher/capability-scope.mjs";
import { createDockerRuntime } from "./lab/launcher/docker-runtime.mjs";
import { createLaunchSpec } from "./lab/launcher/launch-spec.mjs";
import { createHelperSupervisor } from "./lab/launcher/helper-supervisor.mjs";
import {
  readGlobalGitConfig,
  startOAuthRelay
} from "./lab/launcher/oauth-relay.mjs";
import { createRuntimeConfig } from "./lab/launcher/runtime-config.mjs";
import { createWorkspaceOwnership } from "./lab/launcher/workspace-ownership.mjs";
import {
  selectWorkspace,
  withoutWorkspaceArgument
} from "./lab/launcher/workspace-selection.mjs";
import { readImageBuildDefinition } from "./lab/launch-snapshot.mjs";
import {
  adoptLegacyHostFile,
  labHostPaths,
  projectHostState
} from "./lab/host-state.mjs";
import {
  contractSummary,
  loadProjectContract
} from "./lab/project-contract.mjs";
import {
  collectProjectPreflight,
  preflightLines
} from "./lab/project-preflight.mjs";
import { createLeaseSession } from "./lab/launcher/lease-session.mjs";
import {
  assertNoMaintenance,
  volumeEnvironment
} from "./lab/state-volumes.mjs";
import { readActiveRelease } from "./lab/update-manager.mjs";
import {
  configuredPackRoots,
  loadPackSet,
  packUiSummary,
  selectPackSet
} from "./lab/pack-loader.mjs";
import { projectIdentity } from "./lab/workspace-registry.mjs";

const envFile = resolve("opencode.env");
const rawArgs = process.argv.slice(2);
const packageManifest = JSON.parse(
  readFileSync(resolve("package.json"), "utf8")
);
const imageBuild = readImageBuildDefinition({ root: resolve(".") });
const labVersion = packageManifest.labPackApiVersion ?? packageManifest.version;
let configuredPackSet;
try {
  configuredPackSet = loadPackSet({
    roots: configuredPackRoots({ envFile }),
    labVersion
  });
} catch (error) {
  console.error(
    `OpenCode Command Center pack configuration is invalid: ${error.message}`
  );
  process.exit(1);
}

const launcherOptions = parseLauncherFlags(withoutWorkspaceArgument(rawArgs));
const args = launcherOptions.args;
const authContainerName = `opencode-lab-opencode-auth-${process.pid}`;
const workspacePath = selectWorkspace(rawArgs);
if (!workspacePath) {
  console.log("No workspace selected. OpenCode was not started.");
  process.exit(0);
}
if (!existsSync(workspacePath) || !lstatSync(workspacePath).isDirectory()) {
  console.error(
    `Workspace folder does not exist or is not a directory: ${workspacePath}`
  );
  process.exit(1);
}
const {
  canonicalPath: canonicalWorkspacePath,
  workspaceHash,
  projectId
} = projectIdentity(workspacePath);
let projectContract;
let packSet;
try {
  projectContract = loadProjectContract(canonicalWorkspacePath, {
    enabledPacks: []
  });
  packSet = selectPackSet(
    configuredPackSet,
    projectContract.contract.enabledPacks,
    {
      labVersion
    }
  );
  const summary = contractSummary(canonicalWorkspacePath, projectContract);
  console.log(
    `Project contract: ${summary.source} · ${summary.riskLevel} risk · ${summary.verificationCommands} verification command${summary.verificationCommands === 1 ? "" : "s"} · ${summary.enabledPacks.length} pack${summary.enabledPacks.length === 1 ? "" : "s"}`
  );
  const preflight = collectProjectPreflight({
    workspace: canonicalWorkspacePath,
    contract: projectContract.contract,
    contractSource: projectContract.source
  });
  for (const line of preflightLines(preflight)) console.log(line);
  if (!preflight.healthy) {
    throw new Error(
      "Project preflight failed. Resolve the FAIL diagnostics above before launching."
    );
  }
} catch (error) {
  console.error(
    `OpenCode Command Center project setup is invalid: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
const isTask = args[0] === "task";
let taskRoute;
if (isTask) {
  try {
    taskRoute = routeTask(parseTaskInvocation(args, { packSet }), undefined, {
      packSet
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const isRemoteTui = args[0] === "remote-tui";
const isNotionStart = args[0] === "notion:start";
const isMcpAuth = args[0] === "mcp" && args[1] === "auth";
const launchSpec = createLaunchSpec(args);
const isForegroundLaunch = launchSpec.foreground;
const tooling = selectTooling({
  requested: launcherOptions.requested,
  agent: taskRoute?.agent ?? agentArgument(args),
  packSet
});
const launchId = `launch_${randomUUID().replaceAll("-", "")}`;
const launchSessionId = launchSpec.sessionId;
const launchRunId = launchSpec.runId;
const launchRegistrationToken = randomBytes(32).toString("hex");
const hostPaths = labHostPaths();
assertNoMaintenance(hostPaths.updatesRoot);
adoptLegacyHostFile(
  resolve(".opencode-user/preferences.json"),
  hostPaths.preferencesPath
);
const qualityDirectory = hostPaths.stateRoot;
const hostRegistryFile = resolve(qualityDirectory, "host-registry.json");
const projectStateDirectory = projectHostState(projectId);
const qualityPidFile = resolve(qualityDirectory, "quality-mcp.pid");
const qualityLogFile = resolve(qualityDirectory, "quality-mcp.log");
const galleryPidFile = resolve(qualityDirectory, "gallery.pid");
const galleryLogFile = resolve(qualityDirectory, "gallery.log");
const GALLERY_PORT = 3110;
const browserRelayPidFile = resolve(qualityDirectory, "browser-verify.pid");
const browserRelayLogFile = resolve(qualityDirectory, "browser-verify.log");
const BROWSER_RELAY_PORT = 3111;
const browserSessionPidFile = resolve(qualityDirectory, "browser-session.pid");
const browserSessionLogFile = resolve(qualityDirectory, "browser-session.log");
const BROWSER_SESSION_PORT = 3112;
const githubRelayPidFile = resolve(
  qualityDirectory,
  "github-publish-relay.pid"
);
const githubRelayLogFile = resolve(
  qualityDirectory,
  "github-publish-relay.log"
);
const openPetsRelayPidFile = resolve(qualityDirectory, "openpets-relay.pid");
const openPetsRelayLogFile = resolve(qualityDirectory, "openpets-relay.log");
for (const legacyPid of [
  "quality-mcp.pid",
  "gallery.pid",
  "browser-verify.pid",
  "browser-session.pid",
  "github-publish-relay.pid",
  "openpets-relay.pid"
]) {
  adoptLegacyHostFile(
    resolve(".quality", legacyPid),
    resolve(qualityDirectory, legacyPid)
  );
}
const runtimeConfigFile = resolve(
  projectStateDirectory,
  `opencode-runtime-${process.pid}-${randomBytes(6).toString("hex")}.json`
);
const configIgnoreFile = resolve(
  projectStateDirectory,
  "opencode-config.gitignore"
);
const workspaceMasks = Object.freeze([
  ["OPENCODE_MASK_DEV_VARS_TARGET", ".dev.vars", "dev-vars"],
  ["OPENCODE_MASK_ENV_TARGET", ".env", "env"],
  ["OPENCODE_MASK_DOCKER_ENV_TARGET", "docker.env", "docker-env"],
  ["OPENCODE_MASK_OPENCODE_ENV_TARGET", "opencode.env", "opencode-env"],
  ["OPENCODE_MASK_NPMRC_TARGET", ".npmrc", "npmrc"],
  ["OPENCODE_MASK_NETRC_TARGET", ".netrc", "netrc"]
]);
const baseLocalImages = new Map([
  [
    "agent-gateway",
    process.env.OPENCODE_LAB_GATEWAY_IMAGE ?? "opencode-lab-agent-gateway:local"
  ],
  [
    "opencode",
    process.env.OPENCODE_LAB_OPENCODE_IMAGE ?? "opencode-lab-opencode:local"
  ]
]);
const researchLocalImages = new Map([
  [
    "hound-firewall",
    process.env.OPENCODE_LAB_HOUND_FIREWALL_IMAGE ??
      "opencode-lab-hound-firewall:local"
  ],
  [
    "hound",
    process.env.OPENCODE_LAB_HOUND_IMAGE ?? "opencode-lab-hound:13.1.2"
  ],
  [
    "hound-relay",
    process.env.OPENCODE_LAB_HOUND_RELAY_IMAGE ??
      "opencode-lab-hound-relay:local"
  ]
]);
const runtimeConfigMaxAgeMs = 24 * 60 * 60 * 1000;

const {
  ensureConfigIgnoreFile,
  ensureEnvSecret,
  envValue,
  preparePackConfig,
  removePackConfig,
  removeRuntimeConfig,
  requiredEnvValue,
  safeHostEnvironment,
  selectedLaunchProfile,
  workspaceMaskEnvironment,
  writeRuntimeConfig,
  managedGitEnvironment
} = createRuntimeConfig({
  configIgnoreFile,
  envFile,
  packSet,
  projectStateDirectory,
  runtimeConfigFile,
  runtimeConfigMaxAgeMs,
  tooling,
  workspaceMasks,
  workspacePath
});

const {
  claimForegroundWorkspace,
  registerBackgroundWorkspace,
  releaseForegroundWorkspace
} = createWorkspaceOwnership({
  packSet,
  launchSpec,
  canonicalWorkspacePath,
  hostRegistryFile,
  launchId,
  launchRegistrationToken,
  launchRunId,
  launchSessionId,
  projectId,
  selectedLaunchProfile,
  workspaceHash
});

function launchCapabilityScope() {
  return buildLaunchCapabilityScope({
    args,
    envValue,
    isForegroundLaunch,
    isNotionStart,
    packSet,
    taskRoute,
    tooling
  });
}

const {
  dockerComposeArguments,
  ensureOpencodePreview,
  ensureRequestedLocalImages,
  initializeOpenCodeVolumes,
  refreshAgentGateway,
  runDockerCompose,
  stopManagedServices,
  startRequestedToolServices
} = createDockerRuntime({
  baseLocalImages,
  envFile,
  hostRegistryFile,
  imageBuild,
  launchSpec,
  launchId,
  launchRunId,
  launcherOptions,
  projectId,
  researchLocalImages,
  tooling,
  workspaceHash
});
const {
  ensureQualityServer,
  prepareGatewayHostServices,
  startOptionalHostServices,
  stopForegroundRelays
} = createHelperSupervisor({
  BROWSER_RELAY_PORT,
  BROWSER_SESSION_PORT,
  GALLERY_PORT,
  browserRelayLogFile,
  browserRelayPidFile,
  browserSessionLogFile,
  browserSessionPidFile,
  galleryLogFile,
  galleryPidFile,
  githubRelayLogFile,
  githubRelayPidFile,
  hostRegistryFile,
  isForegroundLaunch,
  launchId,
  launchRegistrationToken,
  openPetsRelayLogFile,
  openPetsRelayPidFile,
  projectId,
  qualityDirectory,
  qualityLogFile,
  qualityPidFile,
  safeHostEnvironment,
  workspaceHash,
  workspacePath
});

const gitUserName =
  process.env.OPENCODE_GIT_USER_NAME?.trim() ||
  readGlobalGitConfig("user.name");
const gitUserEmail =
  process.env.OPENCODE_GIT_USER_EMAIL?.trim() ||
  readGlobalGitConfig("user.email");

if (!gitUserName || !gitUserEmail) {
  console.error(
    "Git identity is not configured. Set user.name and user.email globally, or provide OPENCODE_GIT_USER_NAME and OPENCODE_GIT_USER_EMAIL."
  );
  process.exitCode = 1;
} else if (!existsSync(envFile)) {
  console.error(
    "OpenCode is not configured. Copy opencode.env.example to opencode.env and add your Cloudflare account ID and Workers AI token."
  );
  process.exitCode = 1;
} else {
  if (isForegroundLaunch) {
    try {
      if (!(await claimForegroundWorkspace())) process.exit(0);
      process.once("exit", releaseForegroundWorkspace);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (launchSpec.managed) {
    registerBackgroundWorkspace();
  }
  mkdirSync(hostPaths.configRoot, { recursive: true });
  const cloudflareAccountId = requiredEnvValue("CLOUDFLARE_ACCOUNT_ID");
  const cloudflareApiToken = requiredEnvValue("CLOUDFLARE_API_TOKEN");
  const openDesignToken = ensureEnvSecret("OD_API_TOKEN");
  const qualityMcpToken = ensureEnvSecret("QUALITY_MCP_TOKEN");
  const agentGatewaySigningKey = ensureEnvSecret("AGENT_GATEWAY_SIGNING_KEY");
  const githubRelayToken = ensureEnvSecret("GITHUB_PUBLISH_RELAY_TOKEN");
  const openPetsRelayToken = ensureEnvSecret("OPENPETS_RELAY_TOKEN");
  const browserVerifyRelayToken = ensureEnvSecret(
    "LAB_BROWSER_VERIFY_RELAY_TOKEN"
  );
  const browserSessionRelayToken = ensureEnvSecret(
    "LAB_BROWSER_SESSION_RELAY_TOKEN"
  );
  const remoteTuiToken = isRemoteTui
    ? ensureEnvSecret("REMOTE_TUI_TOKEN")
    : null;
  const notionPublisherToken = isNotionStart
    ? ensureEnvSecret("NOTION_PUBLISHER_TOKEN")
    : null;
  // Validate the real gateway credentials without copying them into any child
  // process other than Compose's fixed agent-gateway service.
  void cloudflareAccountId;
  void cloudflareApiToken;
  void openDesignToken;
  const capabilityScope = launchCapabilityScope();
  const leaseSession = createLeaseSession({
    root: projectStateDirectory,
    key: agentGatewaySigningKey,
    claims: {
      workspaceHash,
      projectId,
      sessionId: launchSessionId,
      runId: launchRunId,
      routes: capabilityScope.routes,
      actions: capabilityScope.actions
    }
  });
  process.once("exit", () => leaseSession.stop());
  const capabilityContext = {
    OPENCODE_WORKSPACE_HASH: workspaceHash,
    OPENCODE_PROJECT_ID: projectId,
    OPENCODE_LAUNCH_SESSION_ID: launchSessionId,
    OPENCODE_RUN_ID: launchRunId,
    OPENCODE_STATE_NAMESPACE: launchSpec.stateNamespace ?? projectId,
    LAB_ATTEMPT_ID: launchSpec.attemptId,
    LAB_REQUEST_ID: process.env.LAB_REQUEST_ID ?? launchRunId,
    LAB_CORRELATION_ID: process.env.LAB_CORRELATION_ID ?? launchRunId
  };
  const projectSkillsPath = join(workspacePath, ".opencode", "skills");
  const emptySkillsPath = resolve("docker/empty-skills");
  const configDirectory = preparePackConfig();
  const configIgnorePath = ensureConfigIgnoreFile();
  process.once("exit", removePackConfig);
  const childEnvironment = safeHostEnvironment({
    ...managedGitEnvironment(launchSpec.managed),
    ...volumeEnvironment(
      launchSpec.stateNamespace ?? projectId,
      readActiveRelease(hostPaths)?.stateVolumes
    ),
    ...capabilityContext,
    AGENT_TRANSPORT_TOKEN: leaseSession.transportToken,
    AGENT_LEASE_DIRECTORY: leaseSession.directory,
    QUALITY_REGISTRATION_TOKEN: launchRegistrationToken,
    // Cached clients hold only this launch's fixed-purpose transport credential.
    AGENT_GATEWAY_TOKEN: leaseSession.transportToken,
    OPENCODE_GIT_USER_NAME: gitUserName,
    OPENCODE_GIT_USER_EMAIL: gitUserEmail,
    OPENCODE_UID: String(process.getuid?.() ?? 1000),
    OPENCODE_GID: String(process.getgid?.() ?? 1000),
    OPENCODE_LAB_IMAGE_FINGERPRINT: imageBuild.fingerprint,
    OPENCODE_WORKSPACE_NAME: basename(workspacePath),
    OPENCODE_WORKSPACE: workspacePath,
    OPENCODE_LAB_STATE_ROOT: hostPaths.stateRoot,
    OPENCODE_LAB_CONFIG_ROOT: hostPaths.configRoot,
    OPENCODE_USER_CONFIG_HOST: hostPaths.configRoot,
    ...workspaceMaskEnvironment(),
    OPENCODE_CONFIG_DIR_HOST: configDirectory,
    OPENCODE_CONFIG_IGNORE_HOST: configIgnorePath,
    OPENCODE_LAB_PACKS_JSON: packUiSummary(packSet),
    OPENCODE_LAB_PACKS: packSet.packs.map(({ root }) => root).join(delimiter),
    OPENCODE_PROJECT_SKILLS: existsSync(projectSkillsPath)
      ? projectSkillsPath
      : emptySkillsPath,
    // Docker Desktop cannot reliably overlay protected files inside a bind mount
    // targeted at a host-absolute path. A fixed in-container path makes the
    // secret masks deterministic while the Quality MCP maps it to the host root.
    OPENCODE_WORKSPACE_CONTAINER: "/workspace"
  });
  const qualityWorkspaceRoots = [
    workspacePath,
    ...(process.env.QUALITY_WORKSPACE_ROOTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ].filter((value, index, all) => all.indexOf(value) === index);
  const qualityEnvironment = safeHostEnvironment({
    QUALITY_MCP_TOKEN: qualityMcpToken,
    QUALITY_STATE_ROOT: hostPaths.stateRoot,
    OPENCODE_LAB_STATE_ROOT: hostPaths.stateRoot,
    OPENCODE_LAB_CONFIG_ROOT: hostPaths.configRoot,
    OPENCODE_LAB_PACKS: packSet.packs.map(({ root }) => root).join(delimiter),
    QUALITY_WORKSPACE_ROOTS: qualityWorkspaceRoots.join(","),
    ...(process.env.QUALITY_MCP_PORT
      ? { QUALITY_MCP_PORT: process.env.QUALITY_MCP_PORT }
      : {})
  });

  if (isRemoteTui) {
    const remote = spawn(
      process.execPath,
      [
        resolve("scripts/remote-tui-server.mjs"),
        "--workspace",
        workspacePath,
        "--harness-root",
        resolve("."),
        ...args.slice(1)
      ],
      {
        stdio: "inherit",
        env: safeHostEnvironment({
          REMOTE_TUI_TOKEN: remoteTuiToken,
          OPENCODE_WORKSPACE_NAME: basename(workspacePath)
        })
      }
    );
    remote.on("error", (error) => {
      console.error(`Could not start remote console: ${error.message}`);
      process.exitCode = 1;
    });
    await new Promise((resolveRemote) => {
      remote.on("exit", (code) => {
        process.exitCode = code ?? 1;
        resolveRemote();
      });
    });
    process.exit();
  }

  if (isNotionStart) {
    try {
      requiredEnvValue("NOTION_API_TOKEN");
      requiredEnvValue("NOTION_PUBLISH_TARGETS_JSON");
      void notionPublisherToken;
      runDockerCompose(
        [
          "--profile",
          "notion",
          "up",
          "-d",
          "--build",
          "notion-publisher",
          "agent-gateway"
        ],
        childEnvironment
      );
      console.log(
        "Restricted Notion publisher is ready. Publishing remains approval-gated in OpenCode."
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    process.exit();
  }

  Object.assign(childEnvironment, {
    OPENCODE_RUNTIME_CONFIG: writeRuntimeConfig()
  });
  process.once("exit", removeRuntimeConfig);
  const enabledTools = [
    ...(tooling.research ? ["research"] : []),
    ...(tooling.design ? ["design"] : [])
  ];
  console.log(
    `Tool profile: ${enabledTools.length ? enabledTools.join(" + ") : "fast coding"}`
  );

  try {
    if (isForegroundLaunch) {
      startOptionalHostServices(
        workspacePath,
        childEnvironment,
        browserVerifyRelayToken,
        browserSessionRelayToken
      );
    }
    await Promise.all([
      ensureRequestedLocalImages(childEnvironment),
      isForegroundLaunch
        ? prepareGatewayHostServices(
            childEnvironment,
            qualityEnvironment,
            githubRelayToken,
            openPetsRelayToken,
            {
              ...capabilityContext,
              AGENT_GATEWAY_SIGNING_KEY: agentGatewaySigningKey
            }
          )
        : ensureQualityServer(qualityEnvironment, launchRegistrationToken)
    ]);
    await Promise.all([
      initializeOpenCodeVolumes(childEnvironment),
      refreshAgentGateway(childEnvironment),
      startRequestedToolServices(childEnvironment)
    ]);
  } catch (error) {
    stopForegroundRelays();
    await stopManagedServices(childEnvironment).catch((failure) =>
      console.warn(failure.message)
    );
    removeRuntimeConfig();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const preferenceOptions = { path: hostPaths.preferencesPath };
  const launchArgs = isTask
    ? [
        "run",
        "--agent",
        taskRoute.agent,
        "--model",
        taskRoute.model,
        taskRoute.task
      ]
    : applyAutoApproveArgs(args, preferenceOptions);
  if (
    !isTask &&
    readLabPreferences(hostPaths.preferencesPath).approvalMode === "broad-auto"
  ) {
    console.log(
      "Broad auto-approval is on (hard denies and protected boundaries still apply). Pass --no-auto to switch to ask mode."
    );
  }
  if (isTask) {
    if (taskRoute.auto) {
      // Task --auto also sticks for later interactive Lab launches.
      applyAutoApproveArgs(["--auto"], preferenceOptions);
    }
    console.log(
      `Task route: ${taskRoute.agent} · ${taskRoute.lane ?? "unclassified"} · ${taskRoute.model}`
    );
    console.log(`Routing reason: ${taskRoute.reason}`);
    console.log(
      "Model is fixed for this task; start a new task to route again."
    );
  }

  const relay = isMcpAuth
    ? await startOAuthRelay({ authContainerName, safeHostEnvironment })
    : undefined;
  const child = spawn(
    "docker",
    dockerComposeArguments([
      "run",
      "--rm",
      "--no-deps",
      "--use-aliases",
      ...launchSpec.dockerRunArguments,
      ...(isMcpAuth ? ["--name", authContainerName] : []),
      "opencode",
      ...launchArgs
    ]),
    {
      stdio: "inherit",
      env: childEnvironment
    }
  );
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardSigterm = () => forwardSignal("SIGTERM");
  const forwardSigint = () => forwardSignal("SIGINT");
  process.once("SIGTERM", forwardSigterm);
  process.once("SIGINT", forwardSigint);

  child.once("spawn", () => {
    // Preview, gallery, and browser helpers are useful but must not delay the
    // coding TUI. The relay remains loopback-only and on the restricted network.
    if (!isForegroundLaunch) return;
    void ensureOpencodePreview(childEnvironment).catch((error) => {
      console.warn(
        `Optional preview relay did not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  });

  child.on("error", async (error) => {
    console.error(`Could not start Docker: ${error.message}`);
    relay?.close();
    stopForegroundRelays();
    await stopManagedServices(childEnvironment).catch((failure) =>
      console.warn(failure.message)
    );
    removeRuntimeConfig();
    removePackConfig();
    process.exitCode = 1;
  });
  child.on("exit", async (code) => {
    process.off("SIGTERM", forwardSigterm);
    process.off("SIGINT", forwardSigint);
    relay?.close();
    stopForegroundRelays();
    await stopManagedServices(childEnvironment).catch((error) =>
      console.warn(error.message)
    );
    removeRuntimeConfig();
    removePackConfig();
    process.exitCode = code ?? 1;
  });
}
