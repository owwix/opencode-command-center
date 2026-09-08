import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decidePreviewLaunch } from "./preview-launch-policy.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function launcherSource() {
  return [
    read("scripts/lab/launcher/capability-scope.mjs"),
    read("scripts/lab/launcher/launch-spec.mjs"),
    read("scripts/lab/launcher/lease-session.mjs"),
    read("scripts/lab/launcher/docker-runtime.mjs"),
    read("scripts/lab/launcher/helper-supervisor.mjs"),
    read("scripts/lab/launcher/oauth-relay.mjs"),
    read("scripts/lab/launcher/runtime-config.mjs"),
    read("scripts/lab/launcher/workspace-ownership.mjs"),
    read("scripts/lab/launcher/workspace-selection.mjs"),
    read("scripts/opencode.mjs")
  ].join("\n");
}

test("Compose identity is stable and volumes are scoped by project ID", () => {
  const compose = read("docker-compose.opencode.yml");
  assert.match(compose, /^name: opencode-lab$/mu);
  for (const volume of [
    "open-design-state",
    "hound-state",
    "opencode-state",
    "opencode-user-config",
    "opencode-package-cache",
    "opencode-tmp",
    "notion-publisher-state"
  ]) {
    assert.match(
      compose,
      new RegExp(
        `^  ${volume}:\\n    name: \\$\\{OPENCODE_VOLUME_${volume.replaceAll("-", "_").toUpperCase()}:-opencode-lab-\\$\\{OPENCODE_STATE_NAMESPACE:-\\$\\{OPENCODE_PROJECT_ID:-unscoped\\}\\}-${volume}\\}$`,
        "mu"
      )
    );
  }
  assert.doesNotMatch(compose, /name: cf-coding-agent/u);
  const launcher = launcherSource();
  assert.match(launcher, /opencode-lab-opencode-auth-/u);
  assert.doesNotMatch(launcher, /cf-coding-agent-opencode-preview-1/u);
  assert.match(
    launcher,
    /runDockerCompose\(\["rm", "-s", "-f", "opencode-preview"\]/u
  );
});

test("preview launch reuses the Lab relay before treating its ports as external", () => {
  let portProbes = 0;
  assert.equal(
    decidePreviewLaunch({
      isOwnPreviewRunning: () => true,
      isHostPortListening: () => {
        portProbes += 1;
        return true;
      }
    }),
    "reuse"
  );
  assert.equal(portProbes, 0);

  assert.equal(
    decidePreviewLaunch({
      isOwnPreviewRunning: () => false,
      isHostPortListening: (port) => port === 3100
    }),
    "skip-external"
  );
  assert.equal(
    decidePreviewLaunch({
      isOwnPreviewRunning: () => false,
      isHostPortListening: () => false
    }),
    "start"
  );

  const launcher = launcherSource();
  const previewStartup = launcher.slice(
    launcher.indexOf("async function ensureOpencodePreview"),
    launcher.indexOf("function initializeOpenCodeVolumes")
  );
  assert.match(
    previewStartup,
    /dockerComposeServiceRunning\(\n\s+"opencode-preview",\n\s+environment,?\n\s+\)/u
  );
  assert.match(previewStartup, /dockerComposeServiceIdentityMatches/u);
  assert.match(
    previewStartup,
    /if \(action === "reuse"\)[\s\S]*return;[\s\S]*if \(action === "skip-external"\)[\s\S]*runDockerCompose\(\["rm", "-s", "-f", "opencode-preview"\]/u
  );
  assert.match(previewStartup, /printHostPortListeners\(\);/u);
  assert.match(
    launcher,
    /COMMAND=\$\{listener\.command\} PID=\$\{listener\.pid\}/u
  );
});

test("package manager caches persist without exposing a host directory", () => {
  const compose = read("docker-compose.opencode.yml");
  assert.match(compose, /opencode-package-cache:\/home\/opencode\/\.cache/u);
  assert.match(compose, /NPM_CONFIG_CACHE: \/home\/opencode\/\.cache\/npm/u);
  assert.match(
    compose,
    /npm_config_store_dir: \/home\/opencode\/\.cache\/pnpm\/store/u
  );
  assert.match(compose, /YARN_CACHE_FOLDER: \/home\/opencode\/\.cache\/yarn/u);
  assert.match(
    compose,
    /BUN_INSTALL_CACHE_DIR: \/home\/opencode\/\.cache\/bun/u
  );
  assert.doesNotMatch(compose, /\$\{HOME\}.*opencode-package-cache/u);
});

test("warm launcher builds missing or stale core images and does not force every rebuild", () => {
  const launcher = launcherSource();
  const normalRun = launcher.slice(
    launcher.lastIndexOf("const child = spawn("),
    launcher.indexOf('child.once("spawn"')
  );
  assert.ok(normalRun.length > 0);
  assert.doesNotMatch(normalRun, /"--build"/u);
  assert.match(normalRun, /"--no-deps"/u);
  assert.match(launcher, /ensureRequestedLocalImages\(childEnvironment\)/u);
  assert.match(launcher, /dockerImageAvailable\(image, environment\)/u);
  assert.match(
    launcher,
    /dockerImageMatchesCurrentBuild\(image, environment\)/u
  );
  assert.match(launcher, /Building missing or stale Lab images/u);
  assert.match(launcher, /launcherOptions\.rebuild/u);
  assert.match(launcher, /Rebuilding requested Lab images/u);
  assert.match(
    launcher,
    /runDockerComposeAsync\(\["up", "-d", "opencode-preview"\]/u
  );
  assert.doesNotMatch(
    launcher,
    /\["up", "-d", "--build", "opencode-preview"\]/u
  );
});

test("default coding keeps optional tool stacks off the required path", () => {
  const launcher = launcherSource();
  assert.match(
    launcher,
    /function startOptionalHostServices\(\n\s+workspace,\n\s+childEnvironment,\n\s+browserVerifyToken,\n\s+browserSessionToken,?\n\s*\)/u
  );
  assert.match(launcher, /\.then\(start\)\n\s+\.catch/u);
  assert.match(launcher, /ensureRequestedLocalImages\(childEnvironment\)/u);
  assert.match(launcher, /refreshAgentGateway\(childEnvironment\)/u);
  assert.match(
    launcher,
    /\[\n\s+"up",\n\s+"-d",\n\s+"--no-build",\n\s+"--wait",\n\s+"--wait-timeout",\n\s+"30",\n\s+"agent-gateway",?\n\s+\]/u
  );
  assert.match(launcher, /configuredPackRoots\(\{ envFile \}\)/u);
  assert.match(launcher, /materializePackConfig\(\{/u);
  assert.match(launcher, /OPENCODE_CONFIG_DIR_HOST: configDirectory/u);
  assert.match(launcher, /OPENCODE_CONFIG_IGNORE_HOST: configIgnorePath/u);
  assert.match(launcher, /function ensureConfigIgnoreFile\(\)/u);
  assert.doesNotMatch(launcher, /OPENCODE_PACK_COMMAND_OVERLAY/u);
  assert.match(launcher, /startRequestedToolServices\(childEnvironment\)/u);
  assert.match(
    launcher,
    /await Promise\.all\(\[\n\s+initializeOpenCodeVolumes\(childEnvironment\),\n\s+refreshAgentGateway\(childEnvironment\),\n\s+startRequestedToolServices\(childEnvironment\),?\n\s+\]\)/u
  );
  assert.match(
    launcher,
    /child\.once\("spawn"[\s\S]*ensureOpencodePreview\(childEnvironment\)/u
  );

  const compose = read("docker-compose.opencode.yml");
  assert.match(
    compose,
    /\$\{OPENCODE_CONFIG_DIR_HOST:-\.\/\.opencode\}:\/opencode-config\/\.opencode:ro/u
  );
  assert.match(
    compose,
    /\$\{OPENCODE_CONFIG_IGNORE_HOST:\?Project-scoped config ignore file is required\}:\/opencode-config\/\.opencode\/\.gitignore:rw/u
  );
  const gateway = compose
    .split("\n  agent-gateway:")[1]
    .split("\n  notion-publisher-state-init:")[0];
  const opencode = compose
    .split("\n  opencode:")[1]
    .split("\n  opencode-preview:")[0];
  assert.doesNotMatch(gateway, /open-design:/u);
  assert.match(opencode, /agent-gateway:\n\s+condition: service_healthy/u);
  assert.match(
    opencode,
    /opencode-state-init:\n\s+condition: service_completed_successfully/u
  );
  assert.doesNotMatch(opencode, /hound-relay:/u);
  assert.match(compose, /open-design:\n\s+profiles: \["design"\]/u);
  for (const service of ["hound-firewall", "hound", "hound-relay"]) {
    assert.match(
      compose,
      new RegExp(`${service}:\\n\\s+profiles: \\["research"\\]`, "u")
    );
  }
  assert.match(
    compose,
    /\$\{OPENCODE_RUNTIME_CONFIG:-\.\/opencode\.json\}:\/opencode-config\/opencode\.json:ro/u
  );
  assert.match(launcher, /opencode-runtime-\\d\+-\[0-9a-f\]\{12\}/u);
  assert.match(launcher, /runtimeConfigMaxAgeMs = 24 \* 60 \* 60 \* 1000/u);
  assert.match(launcher, /stats\.isFile\(\).*stats\.mtimeMs/su);
});

test("occtl entrypoint exposes lifecycle commands and preserves v0.x aliases", () => {
  const entry = read("scripts/opencode-entry.mjs");
  for (const command of [
    "open [path]",
    "new [path]",
    "recent",
    "status",
    "stop",
    "resume [project]",
    "init [path] [--pack id] [--yes]",
    "doctor [path]",
    "prune [--apply]"
  ]) {
    assert.match(
      entry,
      new RegExp(
        `occtl ${command.replaceAll("[", "\\[").replaceAll("]", "\\]")}`,
        "u"
      )
    );
  }
  assert.match(entry, /opencode-command-center/u);
  assert.match(entry, /Compatibility aliases:[\s\S]*lab[\s\S]*opencode-lab/u);
  assert.match(entry, /status === null \? runLauncher\(args\) : status/u);
  assert.match(entry, /if \(args\.includes\("--setup"\)\)/u);
  assert.match(entry, /Project contract preview \(\$\{loaded\.source\}\)/u);
  assert.match(entry, /approveProjectContract\(loaded\.path\)/u);
  assert.match(entry, /Unavailable pack ID/u);
  assert.match(
    entry,
    /quit and relaunch with \\`occtl open --with-research\\` or\n\\`occtl open --with-design\\`/u
  );
});

test("project contracts own pack selection without changing product version", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.name, "opencode-command-center");
  assert.equal(manifest.bin.occtl, "scripts/opencode-entry.mjs");
  assert.equal(
    manifest.bin["opencode-command-center"],
    "scripts/opencode-entry.mjs"
  );
  assert.equal(manifest.bin.lab, "scripts/opencode-entry.mjs");
  assert.equal(manifest.bin["opencode-lab"], "scripts/opencode-entry.mjs");
  assert.equal(manifest.version, "0.0.0-private");
  assert.equal(manifest.labPackApiVersion, "1.0.0");
  const launcher = launcherSource();
  assert.match(launcher, /packageManifest\.labPackApiVersion/u);
  assert.match(
    launcher,
    /loadProjectContract\(canonicalWorkspacePath, \{\n\s+enabledPacks: \[\]/u
  );
  assert.match(
    launcher,
    /selectPackSet\(\n\s+configuredPackSet,\n\s+projectContract\.contract\.enabledPacks/u
  );
});

test("launch state and credential masks never create project placeholders", () => {
  const launcher = launcherSource();
  const compose = read("docker-compose.opencode.yml");
  assert.match(launcher, /const qualityDirectory = hostPaths\.stateRoot/u);
  assert.match(
    launcher,
    /projectStateDirectory = projectHostState\(projectId\)/u
  );
  assert.match(launcher, /workspaceMaskEnvironment/u);
  assert.doesNotMatch(launcher, /ensureWorkspaceMaskTargets/u);
  assert.doesNotMatch(launcher, /openSync\(target, "wx", 0o600\)/u);
  for (const target of [
    "OPENCODE_MASK_DEV_VARS_TARGET",
    "OPENCODE_MASK_ENV_TARGET",
    "OPENCODE_MASK_DOCKER_ENV_TARGET",
    "OPENCODE_MASK_OPENCODE_ENV_TARGET",
    "OPENCODE_MASK_NPMRC_TARGET",
    "OPENCODE_MASK_NETRC_TARGET"
  ]) {
    assert.match(compose, new RegExp(`\\$\\{${target}`, "u"));
  }
  assert.match(compose, /OPENCODE_USER_CONFIG_HOST/u);
  assert.doesNotMatch(compose, /\.\/\.opencode-user:/u);
  const entry = read("scripts/opencode-entry.mjs");
  assert.match(entry, /const registryPath = hostPaths\.registryPath/u);
  assert.doesNotMatch(
    entry,
    /const registryPath = resolve\(packageRoot, "\.quality\/host-registry\.json"\)/u
  );
  for (const file of [
    "scripts/quality-controller.mjs",
    "scripts/quality-mcp/handler.mjs",
    "scripts/quality-alerts.mjs",
    "scripts/lab/background-ship.mjs",
    "scripts/lab/background-ship-worker.mjs",
    "scripts/lab/fleet.mjs"
  ]) {
    const source =
      file === "scripts/quality-controller.mjs"
        ? `${read(file)}\n${read("scripts/quality/controller-runtime.mjs")}`
        : read(file);
    assert.match(source, /labStateRoot/u);
    assert.doesNotMatch(source, /harnessRoot, ["']\.quality/u);
  }
});

test("state init performs recursive ownership repair only for migrations", () => {
  const init = read("scripts/opencode-state-init.sh");
  assert.match(init, /OPENCODE_STATE_INIT_VERSION/u);
  assert.match(init, /\.opencode-lab-ownership/u);
  assert.match(init, /marker_value.*desired_ownership/su);
  assert.match(init, /find \/package-cache -exec chown/u);
  assert.match(init, /rm -rf \/state\/state\/opencode\/locks/u);
  assert.match(init, /OPENCODE_TUI_INIT_VERSION/u);
  assert.match(init, /\.opencode-lab-tui/u);
  assert.match(init, /node \/init\/opencode-tui-merge\.mjs/u);
  const launcher = launcherSource();
  assert.doesNotMatch(launcher, /mergeClipboardFriendlyTui/u);
  assert.match(launcher, /async function initializeOpenCodeVolumes/u);
  assert.match(
    launcher,
    /runDockerComposeAsync\(\n\s+\["run", "--rm", "--no-deps", "opencode-state-init"\]/u
  );
  const compose = read("docker-compose.opencode.yml");
  assert.match(
    compose,
    /opencode-state-init:[\s\S]*image: \$\{OPENCODE_LAB_OPENCODE_IMAGE:-opencode-lab-opencode:local\}/u
  );
  assert.match(
    compose,
    /scripts\/opencode-tui-merge\.mjs:\/init\/opencode-tui-merge\.mjs:ro/u
  );
  assert.ok(
    init.indexOf('if [ "$marker_value" != "$desired_ownership" ]') <
      init.indexOf("find /state"),
    "recursive traversal must remain inside the marker guard"
  );
});

test("startup failures clean up launcher-owned helper processes", () => {
  const launcher = launcherSource();
  assert.match(
    launcher,
    /function stopForegroundRelays\(\) \{\n\s+if \(!isForegroundLaunch\) return;/u
  );
  const qualityStart = launcher.slice(
    launcher.indexOf("async function ensureQualityServer"),
    launcher.indexOf("async function waitForGitHubRelay")
  );
  assert.match(qualityStart, /process\.kill\(child\.pid, "SIGTERM"\)/u);
  assert.match(
    qualityStart,
    /Number\(readFileSync\(qualityPidFile,[\s\S]*=== child\.pid[\s\S]*unlinkSync\(qualityPidFile\)/u
  );
  const startup = launcher.slice(
    launcher.indexOf("  try {\n    if (isForegroundLaunch)"),
    launcher.indexOf("const launchArgs =")
  );
  assert.match(
    startup,
    /catch \(error\) \{\n    stopForegroundRelays\(\);\n    await stopManagedServices\(childEnvironment\)[\s\S]*removeRuntimeConfig\(\);/u
  );
  assert.match(
    launcher,
    /startOpenPetsRelay\(openPetsRelayToken\)\.catch\(\n\s+\(error\) => \{\n\s+stopOpenPetsRelay\(\);/u
  );
});

test("loopback relays retain internal auth while validating launch leases", () => {
  const launcher = launcherSource();
  assert.match(
    launcher,
    /const githubRelayToken = ensureEnvSecret\("GITHUB_PUBLISH_RELAY_TOKEN"\)/u
  );
  assert.match(
    launcher,
    /const openPetsRelayToken = ensureEnvSecret\("OPENPETS_RELAY_TOKEN"\)/u
  );
  assert.match(launcher, /LAB_BROWSER_VERIFY_RELAY_TOKEN/u);
  assert.match(launcher, /LAB_BROWSER_SESSION_RELAY_TOKEN/u);
  assert.match(
    launcher,
    /prepareGatewayHostServices\([\s\S]*githubRelayToken,[\s\S]*openPetsRelayToken/u
  );

  const githubRelayStart = launcher.slice(
    launcher.indexOf("async function startGitHubRelay"),
    launcher.indexOf("function stopGitHubRelay")
  );
  assert.match(
    githubRelayStart,
    /async function startGitHubRelay\(token, capabilityEnvironment\)/u
  );
  assert.doesNotMatch(githubRelayStart, /randomBytes/u);
  assert.match(githubRelayStart, /\.\.\.capabilityEnvironment/u);

  const openPetsRelayStart = launcher.slice(
    launcher.indexOf("async function startOpenPetsRelay"),
    launcher.indexOf("async function prepareGatewayHostServices")
  );
  assert.match(
    openPetsRelayStart,
    /async function startOpenPetsRelay\(token\)/u
  );
  assert.doesNotMatch(openPetsRelayStart, /randomBytes/u);
  assert.match(launcher, /createCapabilityLease\(/u);
  assert.match(
    launcher,
    /const agentGatewaySigningKey = ensureEnvSecret\("AGENT_GATEWAY_SIGNING_KEY"\)/u
  );
});

test("launcher health checks use core loopback HTTP instead of Undici", () => {
  const launcher = launcherSource();
  const health = read("scripts/lab/loopback-health.mjs");
  assert.match(launcher, /import \{ loopbackHealth \}/u);
  assert.doesNotMatch(launcher, /function loopbackHealth\(/u);
  assert.match(health, /request as httpRequest/u);
  assert.match(health, /function loopbackHealth\(/u);
  assert.doesNotMatch(launcher, /await fetch\(`http:\/\/127\.0\.0\.1:/u);
  assert.match(health, /Health checks must target loopback HTTP/u);
});

test("workspace ownership uses a launch registry instead of a global pointer", () => {
  const launcher = launcherSource();
  const quality = read("scripts/quality-mcp/handler.mjs");
  const compose = read("docker-compose.opencode.yml");
  assert.doesNotMatch(`${launcher}\n${quality}`, /current-workspace\.json/u);
  assert.match(launcher, /host-registry\.json/u);
  assert.match(launcher, /claimForegroundWorkspace/u);
  assert.match(launcher, /LAB_FOREGROUND_ACTION/u);
  assert.match(launcher, /registerBackgroundWorkspace/u);
  assert.match(launcher, /composeProjectName = launchSpec.composeProject/u);
  assert.match(
    launcher,
    /const child = spawn\(\n    "docker",\n    dockerComposeArguments\(\[/u
  );
  assert.match(launcher, /const isForegroundLaunch = launchSpec.foreground/u);
  assert.match(launcher, /if \(!isForegroundLaunch\) return;/u);
  assert.match(launcher, /dockerComposeServiceIdentityMatches/u);
  assert.match(launcher, /Refusing to stop PID/u);
  assert.match(
    launcher,
    /const child = spawn\([\s\S]*const forwardSigterm = \(\) => forwardSignal\("SIGTERM"\)/u
  );
  assert.match(quality, /x-lab-registration-token/u);
  assert.match(compose, /QUALITY_REGISTRATION_TOKEN:/u);
  const opencodeService = compose
    .split("\n  opencode:")[1]
    .split("\n  opencode-preview:")[0];
  assert.doesNotMatch(opencodeService, /QUALITY_REGISTRATION_TOKEN/u);
});

test("entrypoints bootstrap the pinned Node runtime without shell startup files", () => {
  const entry = read("scripts/opencode-entry.mjs");
  const desktop = read("launch-opencode.command");
  assert.match(entry, /requiredNodeVersion/u);
  assert.match(entry, /\.nvm[\s\S]*versions[\s\S]*node/u);
  assert.match(desktop, /node_binary=.*\.nvm\/versions\/node/u);
  assert.doesNotMatch(desktop, /source "\$HOME\/\.zshrc"/u);
  assert.doesNotMatch(desktop, /exec npm run opencode/u);
});
