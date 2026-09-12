import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { loopbackHealth } from "../loopback-health.mjs";
import { recordProjectHelper } from "../workspace-registry.mjs";
import { withHelperStartLock } from "./helper-start-lock.mjs";

export function createHelperSupervisor(context) {
  const {
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
  } = context;

  function stopOwnedHelper(pidFile, helperScript) {
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) {
      throw new Error(`Invalid helper PID file: ${pidFile}`);
    }
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      unlinkSync(pidFile);
      return;
    }
    const expected = resolve(helperScript);
    if (!command.includes(expected)) {
      throw new Error(
        `Refusing to stop PID ${pid}: it is not the registered ${expected} helper.`
      );
    }
    process.kill(pid, "SIGTERM");
    unlinkSync(pidFile);
  }

  function helperMatches(payload, service) {
    return (
      payload?.ok === true &&
      payload?.service === service &&
      payload?.projectId === projectId &&
      payload?.workspaceHash === workspaceHash
    );
  }

  function registerHelper(name, pidFile, port) {
    const pid = existsSync(pidFile)
      ? Number(readFileSync(pidFile, "utf8").trim())
      : null;
    recordProjectHelper({
      registryPath: hostRegistryFile,
      projectId,
      launchId,
      helper: name,
      pid: Number.isInteger(pid) ? pid : null,
      port,
      workspaceHash
    });
  }

  async function galleryServerHealthy() {
    try {
      const response = await loopbackHealth(
        `http://127.0.0.1:${GALLERY_PORT}/health`
      );
      return response.ok && helperMatches(response.payload, "lab-gallery");
    } catch {
      return false;
    }
  }

  async function ensureGalleryServer(workspace) {
    mkdirSync(qualityDirectory, { recursive: true });
    if (await galleryServerHealthy()) {
      registerHelper("gallery", galleryPidFile, GALLERY_PORT);
      return;
    }
    stopOwnedHelper(galleryPidFile, "scripts/artifacts/gallery-server.mjs");
    const output = openSync(galleryLogFile, "a");
    const child = spawn(
      process.execPath,
      [resolve("scripts/artifacts/gallery-server.mjs")],
      {
        cwd: resolve("."),
        env: safeHostEnvironment({
          OPENCODE_WORKSPACE: workspace,
          OPENCODE_GALLERY_PORT: String(GALLERY_PORT),
          OPENCODE_GALLERY_HOST: "127.0.0.1",
          OPENCODE_PROJECT_ID: projectId,
          OPENCODE_WORKSPACE_HASH: workspaceHash
        }),
        detached: true,
        stdio: ["ignore", output, output]
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(galleryPidFile, `${child.pid}\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await galleryServerHealthy()) {
        registerHelper("gallery", galleryPidFile, GALLERY_PORT);
        console.log(`Lab gallery: http://127.0.0.1:${GALLERY_PORT}`);
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    console.warn(`Lab gallery did not start. See ${galleryLogFile}.`);
  }

  async function browserRelayHealthy() {
    try {
      const response = await loopbackHealth(
        `http://127.0.0.1:${BROWSER_RELAY_PORT}/health`
      );
      return (
        response.ok && helperMatches(response.payload, "lab-browser-verify")
      );
    } catch {
      return false;
    }
  }

  async function ensureBrowserVerifyRelay(workspace, token) {
    mkdirSync(qualityDirectory, { recursive: true });
    if (await browserRelayHealthy()) {
      registerHelper("browser-verify", browserRelayPidFile, BROWSER_RELAY_PORT);
      return;
    }
    stopOwnedHelper(
      browserRelayPidFile,
      "scripts/lab/browser-verify-relay.mjs"
    );
    const output = openSync(browserRelayLogFile, "a");
    const child = spawn(
      process.execPath,
      [
        resolve("scripts/lab/seatbelt-run.mjs"),
        "--",
        process.execPath,
        resolve("scripts/lab/browser-verify-relay.mjs")
      ],
      {
        cwd: resolve("."),
        env: safeHostEnvironment({
          OPENCODE_WORKSPACE: workspace,
          LAB_BROWSER_PORT: String(BROWSER_RELAY_PORT),
          LAB_BROWSER_HOST: "127.0.0.1",
          LAB_BROWSER_VERIFY_RELAY_TOKEN: token,
          OPENCODE_PROJECT_ID: projectId,
          OPENCODE_WORKSPACE_HASH: workspaceHash
        }),
        detached: true,
        stdio: ["ignore", output, output]
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(browserRelayPidFile, `${child.pid}\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await browserRelayHealthy()) {
        registerHelper(
          "browser-verify",
          browserRelayPidFile,
          BROWSER_RELAY_PORT
        );
        console.log(
          `Lab browser verify relay: http://127.0.0.1:${BROWSER_RELAY_PORT}`
        );
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    console.warn(
      `Lab browser verify relay did not start. See ${browserRelayLogFile}.`
    );
  }

  async function browserSessionHealthy() {
    try {
      const response = await loopbackHealth(
        `http://127.0.0.1:${BROWSER_SESSION_PORT}/health`
      );
      return (
        response.ok &&
        response.payload.connectedChrome === 1 &&
        helperMatches(response.payload, "lab-browser-session")
      );
    } catch {
      return false;
    }
  }

  async function ensureBrowserSessionRelay(workspace, token) {
    mkdirSync(qualityDirectory, { recursive: true });
    if (await browserSessionHealthy()) {
      registerHelper(
        "browser-session",
        browserSessionPidFile,
        BROWSER_SESSION_PORT
      );
      return;
    }
    stopOwnedHelper(
      browserSessionPidFile,
      "scripts/lab/browser-session-relay.mjs"
    );
    const output = openSync(browserSessionLogFile, "a");
    const child = spawn(
      process.execPath,
      [
        resolve("scripts/lab/seatbelt-run.mjs"),
        "--",
        process.execPath,
        resolve("scripts/lab/browser-session-relay.mjs")
      ],
      {
        cwd: resolve("."),
        env: safeHostEnvironment({
          OPENCODE_WORKSPACE: workspace,
          LAB_BROWSER_SESSION_PORT: String(BROWSER_SESSION_PORT),
          LAB_BROWSER_SESSION_HOST: "127.0.0.1",
          LAB_BROWSER_SESSION_RELAY_TOKEN: token,
          OPENCODE_PROJECT_ID: projectId,
          OPENCODE_WORKSPACE_HASH: workspaceHash
        }),
        detached: true,
        stdio: ["ignore", output, output]
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(browserSessionPidFile, `${child.pid}\n`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await browserSessionHealthy()) {
        registerHelper(
          "browser-session",
          browserSessionPidFile,
          BROWSER_SESSION_PORT
        );
        console.log(
          `Lab browser session relay: http://127.0.0.1:${BROWSER_SESSION_PORT}`
        );
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    console.warn(
      `Lab browser session relay did not start. See ${browserSessionLogFile}.`
    );
  }

  function startOptionalHostServices(
    workspace,
    childEnvironment,
    browserVerifyToken,
    browserSessionToken
  ) {
    Object.assign(childEnvironment, {
      LAB_BROWSER_VERIFY_RELAY_URL: `http://host.docker.internal:${BROWSER_RELAY_PORT}`,
      LAB_BROWSER_VERIFY_RELAY_TOKEN: browserVerifyToken,
      LAB_BROWSER_SESSION_RELAY_URL: `http://host.docker.internal:${BROWSER_SESSION_PORT}`,
      LAB_BROWSER_SESSION_RELAY_TOKEN: browserSessionToken
    });
    const services = [
      ["gallery", () => ensureGalleryServer(workspace)],
      [
        "browser verify relay",
        () => ensureBrowserVerifyRelay(workspace, browserVerifyToken)
      ],
      [
        "browser session relay",
        () => ensureBrowserSessionRelay(workspace, browserSessionToken)
      ]
    ];
    for (const [label, start] of services) {
      void Promise.resolve()
        .then(start)
        .catch((error) => {
          console.warn(
            `Optional ${label} did not start: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    }
  }

  async function qualityServerHealthy(registrationToken) {
    try {
      const response = await loopbackHealth("http://127.0.0.1:8793/health", {
        headers: { "x-lab-registration-token": registrationToken }
      });
      return response.ok && helperMatches(response.payload, "quality");
    } catch {
      return false;
    }
  }

  async function ensureQualityServer(environment, registrationToken) {
    mkdirSync(qualityDirectory, { recursive: true });
    return withHelperStartLock(
      resolve(qualityDirectory, "quality-start.lock"),
      () => startQualityServer(environment, registrationToken)
    );
  }

  async function startQualityServer(environment, registrationToken) {
    if (await qualityServerHealthy(registrationToken)) {
      registerHelper("quality", qualityPidFile, 8793);
      return;
    }
    if (existsSync(qualityPidFile)) {
      const pid = Number(readFileSync(qualityPidFile, "utf8").trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      if (alive)
        throw new Error(
          `Quality service PID ${pid} is running but is not ready for this registration. Check ${qualityLogFile}; it was not restarted because other runs may depend on it.`
        );
    }
    const output = openSync(qualityLogFile, "a");
    let child;
    try {
      child = spawn(
        process.execPath,
        [resolve("scripts/quality-mcp/server.mjs")],
        {
          cwd: resolve("."),
          env: environment,
          detached: true,
          stdio: ["ignore", output, output]
        }
      );
      closeSync(output);
      child.unref();
      writeFileSync(qualityPidFile, `${child.pid}\n`, { mode: 0o600 });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await qualityServerHealthy(registrationToken)) {
          registerHelper("quality", qualityPidFile, 8793);
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error(`Quality service did not start. See ${qualityLogFile}.`);
    } catch (error) {
      if (Number.isInteger(child?.pid) && child.pid > 1) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // The failed child may already have exited.
        }
        try {
          if (
            existsSync(qualityPidFile) &&
            Number(readFileSync(qualityPidFile, "utf8").trim()) === child.pid
          ) {
            unlinkSync(qualityPidFile);
          }
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            console.warn(
              `Could not remove failed Quality PID file: ${cleanupError.message}`
            );
          }
        }
      }
      throw error;
    }
  }

  async function waitForGitHubRelay(port) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await loopbackHealth(
          `http://127.0.0.1:${port}/health`,
          {
            timeoutMs: 500
          }
        );
        if (
          response.ok &&
          helperMatches(response.payload, "github-publish-relay")
        )
          return;
      } catch {
        // The host relay may still be binding its loopback socket.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(
      `GitHub publish relay did not start. See ${githubRelayLogFile}.`
    );
  }

  async function startGitHubRelay(token, capabilityEnvironment) {
    mkdirSync(qualityDirectory, { recursive: true });
    stopGitHubRelay();
    const port = Number(process.env.GITHUB_PUBLISH_RELAY_PORT || 8794);
    const output = openSync(githubRelayLogFile, "a");
    const child = spawn(
      process.execPath,
      [resolve("scripts/github/publish-relay.mjs")],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", output, output],
        env: safeHostEnvironment({
          GITHUB_PUBLISH_RELAY_HOST: "127.0.0.1",
          GITHUB_PUBLISH_RELAY_PORT: String(port),
          GITHUB_PUBLISH_RELAY_TOKEN: token,
          GITHUB_PUBLISH_WORKSPACE: workspacePath,
          ...capabilityEnvironment
        })
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(githubRelayPidFile, `${child.pid}\n`, { mode: 0o600 });
    const relayEnvironment = {
      GITHUB_PUBLISH_RELAY_URL: `http://host.docker.internal:${port}`,
      GITHUB_PUBLISH_RELAY_TOKEN: token
    };
    await waitForGitHubRelay(port);
    registerHelper("github-publish", githubRelayPidFile, port);
    return relayEnvironment;
  }

  function stopGitHubRelay() {
    stopOwnedHelper(githubRelayPidFile, "scripts/github/publish-relay.mjs");
  }

  async function waitForOpenPetsRelay(port) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const response = await loopbackHealth(
          `http://127.0.0.1:${port}/health`,
          {
            timeoutMs: 500
          }
        );
        if (response.ok && helperMatches(response.payload, "openpets-relay"))
          return;
      } catch {
        // The optional desktop companion may still be starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(
      `OpenPets relay did not start. See ${openPetsRelayLogFile}.`
    );
  }

  async function startOpenPetsRelay(token) {
    mkdirSync(qualityDirectory, { recursive: true });
    stopOpenPetsRelay();
    const port = Number(process.env.OPENPETS_RELAY_PORT || 8795);
    const output = openSync(openPetsRelayLogFile, "a");
    const child = spawn(
      process.execPath,
      [resolve("scripts/openpets/relay.mjs")],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", output, output],
        env: safeHostEnvironment({
          OPENPETS_RELAY_HOST: "127.0.0.1",
          OPENPETS_RELAY_PORT: String(port),
          OPENPETS_RELAY_TOKEN: token,
          OPENCODE_PROJECT_ID: projectId,
          OPENCODE_WORKSPACE_HASH: workspaceHash
        })
      }
    );
    closeSync(output);
    child.unref();
    writeFileSync(openPetsRelayPidFile, `${child.pid}\n`, { mode: 0o600 });
    await waitForOpenPetsRelay(port);
    registerHelper("openpets", openPetsRelayPidFile, port);
    return {
      OPENPETS_RELAY_URL: `http://host.docker.internal:${port}`,
      OPENPETS_RELAY_TOKEN: token
    };
  }

  async function prepareGatewayHostServices(
    childEnvironment,
    qualityEnvironment,
    githubRelayToken,
    openPetsRelayToken,
    capabilityEnvironment
  ) {
    const openPetsPromise = startOpenPetsRelay(openPetsRelayToken).catch(
      (error) => {
        stopOpenPetsRelay();
        console.warn(
          `Optional OpenPets relay did not start: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {};
      }
    );
    const [, githubRelayEnvironment, openPetsEnvironment] = await Promise.all([
      ensureQualityServer(qualityEnvironment, launchRegistrationToken),
      startGitHubRelay(githubRelayToken, capabilityEnvironment),
      openPetsPromise
    ]);
    Object.assign(
      childEnvironment,
      githubRelayEnvironment,
      openPetsEnvironment
    );
  }

  function stopOpenPetsRelay() {
    stopOwnedHelper(openPetsRelayPidFile, "scripts/openpets/relay.mjs");
  }

  function stopForegroundRelays() {
    if (!isForegroundLaunch) return;
    stopGitHubRelay();
    stopOpenPetsRelay();
  }

  return {
    ensureQualityServer,
    prepareGatewayHostServices,
    startOptionalHostServices,
    stopForegroundRelays
  };
}
