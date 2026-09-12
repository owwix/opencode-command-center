import { execFileSync, spawn } from "node:child_process";
import { decidePreviewLaunch } from "../preview-launch-policy.mjs";
import { recordProjectHelper } from "../workspace-registry.mjs";
import { reconcileManagedContainers } from "../managed-resource-recovery.mjs";
import { dependencyMountArgs } from "../node-dependencies.mjs";

export function createDockerRuntime(context, { spawnProcess = spawn } = {}) {
  const {
    baseLocalImages,
    envFile,
    hostRegistryFile,
    imageBuild,
    launchSpec,
    launchId,
    launcherOptions,
    projectId,
    researchLocalImages,
    tooling,
    workspaceHash
  } = context;

  function dockerComposeArguments(composeArgs) {
    if (composeArgs[0] === "run" && composeArgs.includes("opencode")) {
      const index = composeArgs.indexOf("opencode");
      composeArgs = [
        ...composeArgs.slice(0, index),
        ...dependencyMountArgs(projectId, workspaceHash),
        ...composeArgs.slice(index)
      ];
    }
    const composeProjectName = launchSpec.composeProject;
    return [
      "compose",
      "-p",
      composeProjectName,
      "--env-file",
      envFile,
      "-f",
      "docker-compose.opencode.yml",
      ...composeArgs
    ];
  }

  function runDockerCompose(composeArgs, environment) {
    execFileSync("docker", dockerComposeArguments(composeArgs), {
      stdio: "inherit",
      env: environment
    });
  }

  function runDockerComposeAsync(composeArgs, environment) {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawnProcess(
        "docker",
        dockerComposeArguments(composeArgs),
        {
          stdio: "inherit",
          env: environment
        }
      );
      child.once("error", rejectRun);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolveRun();
          return;
        }
        rejectRun(
          new Error(
            `Docker Compose ${composeArgs[0] ?? "command"} failed${
              signal ? ` with signal ${signal}` : ` with status ${code ?? 1}`
            }.`
          )
        );
      });
    });
  }

  async function stopManagedServices(environment) {
    if (!launchSpec.managed) return;
    if (!/^opencode-lab-run-[a-f0-9]{24}$/u.test(launchSpec.composeProject)) {
      throw new Error(
        "Refusing managed cleanup without an exact attempt-owned Compose project."
      );
    }
    // Stop only this attempt's services. Keep volumes, worktrees and evidence.
    await runDockerComposeAsync(["down", "--timeout", "5"], environment);
  }

  function dockerComposeServiceRunning(service, environment) {
    try {
      const runningServices = execFileSync(
        "docker",
        dockerComposeArguments([
          "ps",
          "--status",
          "running",
          "--services",
          service
        ]),
        { encoding: "utf8", env: environment }
      );
      return runningServices
        .split(/\r?\n/u)
        .some((candidate) => candidate.trim() === service);
    } catch {
      return false;
    }
  }

  function dockerComposeServiceContainer(service, environment) {
    try {
      return execFileSync(
        "docker",
        dockerComposeArguments(["ps", "-q", service]),
        { encoding: "utf8", env: environment }
      ).trim();
    } catch {
      return "";
    }
  }

  function dockerComposeServiceIdentityMatches(service, environment) {
    const container = dockerComposeServiceContainer(service, environment);
    if (!container) return false;
    try {
      const configured = JSON.parse(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{json .Config.Env}}", container],
          { encoding: "utf8", env: environment }
        )
      );
      return (
        configured.includes(`OPENCODE_PROJECT_ID=${projectId}`) &&
        configured.includes(`OPENCODE_WORKSPACE_HASH=${workspaceHash}`)
      );
    } catch {
      return false;
    }
  }

  function dockerComposeServicePid(service, environment) {
    const container = dockerComposeServiceContainer(service, environment);
    if (!container) return null;
    try {
      const pid = Number(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Pid}}", container],
          { encoding: "utf8", env: environment }
        ).trim()
      );
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    } catch {
      return null;
    }
  }

  function dockerImageAvailable(image, environment) {
    try {
      execFileSync("docker", ["image", "inspect", image], {
        stdio: "ignore",
        env: environment
      });
      return true;
    } catch {
      return false;
    }
  }

  function dockerImageMatchesCurrentBuild(image, environment) {
    try {
      const fingerprint = execFileSync(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          '{{ index .Config.Labels "io.opencode-lab.build-fingerprint" }}',
          image
        ],
        { encoding: "utf8", env: environment }
      ).trim();
      return fingerprint === imageBuild.fingerprint;
    } catch {
      return false;
    }
  }

  async function ensureRequestedLocalImages(environment) {
    reconcileManagedContainers({
      registryPath: hostRegistryFile,
      env: environment
    });
    const requestedImages = new Map([
      ...baseLocalImages,
      ...(tooling.research ? researchLocalImages : [])
    ]);
    const servicesToBuild = launcherOptions.rebuild
      ? [...requestedImages.keys()]
      : [...requestedImages].flatMap(([service, image]) => {
          if (!dockerImageAvailable(image, environment)) return [service];
          if (service === "agent-gateway") {
            try {
              const protocol = execFileSync(
                "docker",
                [
                  "image",
                  "inspect",
                  "--format",
                  '{{index .Config.Labels "org.opencode-lab.gateway-protocol"}}',
                  image
                ],
                { encoding: "utf8", env: environment }
              ).trim();
              if (protocol !== "renewable-v1") return [service];
            } catch {
              return [service];
            }
          }
          // The OpenCode image includes the pinned runtime and all core tools.
          // Rebuild it automatically when the Dockerfile fingerprint changes;
          // state, themes, and project caches remain in separate volumes.
          if (
            service === "opencode" &&
            !dockerImageMatchesCurrentBuild(image, environment)
          ) {
            return [service];
          }
          return [];
        });
    if (!servicesToBuild.length) return;
    console.log(
      launcherOptions.rebuild
        ? `Rebuilding requested Lab images: ${servicesToBuild.join(", ")}`
        : `Building missing or stale Lab images: ${servicesToBuild.join(", ")}`
    );
    await runDockerComposeAsync(
      [
        ...(tooling.research ? ["--profile", "research"] : []),
        "build",
        ...servicesToBuild
      ],
      environment
    );
  }

  async function refreshAgentGateway(environment) {
    // Session and workspace claims are part of the rendered Compose config, so
    // Compose recreates the gateway whenever a new launch lease is issued.
    await runDockerComposeAsync(
      [
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "30",
        "agent-gateway"
      ],
      environment
    );
  }

  async function startRequestedToolServices(environment) {
    const starts = [];
    if (tooling.research) {
      starts.push(
        runDockerComposeAsync(
          [
            "--profile",
            "research",
            "up",
            "-d",
            "--no-build",
            "--wait",
            "--wait-timeout",
            "90",
            "hound-relay"
          ],
          environment
        )
      );
    }
    if (tooling.design) {
      starts.push(
        runDockerComposeAsync(
          [
            "--profile",
            "design",
            "up",
            "-d",
            "--no-build",
            "--wait",
            "--wait-timeout",
            "60",
            "open-design"
          ],
          environment
        )
      );
    }
    await Promise.all(starts);
  }

  function hostPortListeners(port) {
    try {
      const output = execFileSync(
        "lsof",
        ["-nP", "-Fpc", `-iTCP:${port}`, "-sTCP:LISTEN"],
        { encoding: "utf8" }
      );
      const listeners = [];
      let pid = null;
      let command = null;
      for (const line of output.split(/\r?\n/u)) {
        if (line.startsWith("p")) pid = line.slice(1);
        if (line.startsWith("c")) {
          command = line.slice(1);
          if (pid && command) listeners.push({ command, pid });
        }
      }
      return listeners;
    } catch {
      return [];
    }
  }

  function hostPortListening(port) {
    return hostPortListeners(port).length > 0;
  }

  function printHostPortListeners(ports = [3100, 3101]) {
    for (const port of ports) {
      const listeners = hostPortListeners(port);
      if (!listeners.length) {
        console.log(`Host listener ${port}: none found by lsof.`);
        continue;
      }
      for (const listener of listeners) {
        console.log(
          `Host listener ${port}: COMMAND=${listener.command} PID=${listener.pid}`
        );
      }
    }
  }

  /**
   * Start the Lab preview relay only when 3100/3101 are free.
   * A mounted workspace stack may already publish those ports on the Mac.
   */
  async function ensureOpencodePreview(environment) {
    const previewRunning = dockerComposeServiceRunning(
      "opencode-preview",
      environment
    );
    const previewMatches =
      previewRunning &&
      dockerComposeServiceIdentityMatches("opencode-preview", environment);
    if (previewRunning && !previewMatches) {
      runDockerCompose(["rm", "-s", "-f", "opencode-preview"], environment);
    }
    const action = decidePreviewLaunch({
      isOwnPreviewRunning: () => previewMatches,
      isHostPortListening: hostPortListening
    });
    if (action === "reuse") {
      recordProjectHelper({
        registryPath: hostRegistryFile,
        projectId,
        launchId,
        helper: "preview",
        pid: dockerComposeServicePid("opencode-preview", environment),
        port: 3100,
        workspaceHash
      });
      console.log("Reusing the running opencode-preview relay.");
      return;
    }
    if (action === "skip-external") {
      console.log(
        "Host 3100/3101 already in use (workspace compose). Skipping opencode-preview relay."
      );
      printHostPortListeners();
      console.log("  http://127.0.0.1:3100  <- app primary");
      console.log("  http://127.0.0.1:3101  <- app secondary");
      // Drop any leftover Created/Exited relay that failed an earlier bind.
      try {
        runDockerCompose(["rm", "-s", "-f", "opencode-preview"], environment);
      } catch {
        // No leftover container.
      }
      return;
    }
    if (
      launcherOptions.rebuild ||
      !dockerImageAvailable(
        environment.OPENCODE_LAB_PREVIEW_IMAGE ??
          "opencode-lab-opencode-preview:local",
        environment
      )
    ) {
      await runDockerComposeAsync(["build", "opencode-preview"], environment);
    }
    await runDockerComposeAsync(["up", "-d", "opencode-preview"], environment);
    // Internal-only networks do not publish host ports on Docker Desktop.
    // Fail closed if 3100/3101 never appear so agents do not claim Mac URLs work.
    if (!hostPortListening(3100) && !hostPortListening(3101)) {
      runDockerCompose(["rm", "-s", "-f", "opencode-preview"], environment);
      await runDockerComposeAsync(
        ["up", "-d", "--force-recreate", "opencode-preview"],
        environment
      );
    }
    if (!hostPortListening(3100) && !hostPortListening(3101)) {
      console.warn(
        "opencode-preview started but host 3100/3101 are not listening."
      );
      printHostPortListeners();
      throw new Error(
        "Preview relay did not publish 127.0.0.1:3100/3101. Recreate with a non-internal ingress network."
      );
    }
    recordProjectHelper({
      registryPath: hostRegistryFile,
      projectId,
      launchId,
      helper: "preview",
      pid: dockerComposeServicePid("opencode-preview", environment),
      port: 3100,
      workspaceHash
    });
  }

  async function initializeOpenCodeVolumes(environment) {
    // The launcher starts OpenCode with --no-deps after this explicit check, so
    // state init runs exactly once. The script performs its recursive ownership
    // migration only when its version/UID/GID marker changes.
    await runDockerComposeAsync(
      ["run", "--rm", "--no-deps", "opencode-state-init"],
      environment
    );
  }

  return {
    dockerComposeArguments,
    ensureOpencodePreview,
    ensureRequestedLocalImages,
    initializeOpenCodeVolumes,
    refreshAgentGateway,
    runDockerCompose,
    stopManagedServices,
    startRequestedToolServices
  };
}
