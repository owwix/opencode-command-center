import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { assertNoMaintenance } from "../state-volumes.mjs";
import {
  registerBackgroundLaunch,
  registerForegroundLaunch,
  unregisterBackgroundLaunch,
  unregisterForegroundLaunch
} from "../workspace-registry.mjs";

export function createWorkspaceOwnership(context) {
  const {
    canonicalWorkspacePath,
    hostRegistryFile,
    launchId,
    launchRegistrationToken,
    launchRunId,
    launchSessionId,
    projectId,
    packSet,
    launchSpec,
    selectedLaunchProfile,
    workspaceHash
  } = context;

  async function foregroundConflictAction(existing) {
    console.error(
      `OpenCode Command Center already has a foreground workspace:\n  ${existing.canonicalPath}\n  PID ${existing.pid} · ${existing.profile}`
    );
    const configured = process.env.LAB_FOREGROUND_ACTION?.trim().toLowerCase();
    if (["stop", "resume"].includes(configured)) return configured;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Another foreground workspace is active. Resume it explicitly or stop it before launching this workspace."
      );
    }
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      const answer = (
        await prompt.question(
          "[r]esume the existing workspace or [s]top it and open this one? [r] "
        )
      )
        .trim()
        .toLowerCase();
      return answer === "s" || answer === "stop" ? "stop" : "resume";
    } finally {
      prompt.close();
    }
  }

  function stopRegisteredForeground(pid) {
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      throw new Error(`Registered foreground PID ${pid} is no longer running.`);
    }
    const expected = resolve("scripts/opencode.mjs");
    if (!command.includes(expected)) {
      throw new Error(
        `Refusing to stop PID ${pid}: it is not the registered ${expected} launcher.`
      );
    }
    process.kill(pid, "SIGTERM");
  }

  async function claimForegroundWorkspace() {
    const registration = {
      registryPath: hostRegistryFile,
      identity: {
        canonicalPath: canonicalWorkspacePath,
        workspaceHash,
        projectId
      },
      launchId,
      sessionId: launchSessionId,
      runId: launchRunId,
      profile: selectedLaunchProfile(),
      packRoots: packSet?.packs.map(({ root }) => root) ?? [],
      registrationToken: launchRegistrationToken
    };
    const first = registerForegroundLaunch(registration);
    if (first.registered) {
      try {
        assertNoMaintenance(resolve(hostRegistryFile, "..", "updates"));
      } catch (error) {
        releaseForegroundWorkspace();
        throw error;
      }
      return true;
    }
    const action = await foregroundConflictAction(first.existing);
    if (action === "resume") {
      console.log(
        `Existing workspace remains active: ${first.existing.canonicalPath}`
      );
      return false;
    }
    const replacement = registerForegroundLaunch(
      {
        ...registration,
        conflictAction: "stop"
      },
      { stop: stopRegisteredForeground }
    );
    if (!replacement.registered) {
      throw new Error("Could not replace the existing foreground workspace.");
    }
    try {
      assertNoMaintenance(resolve(hostRegistryFile, "..", "updates"));
    } catch (error) {
      releaseForegroundWorkspace();
      throw error;
    }
    return true;
  }

  function releaseForegroundWorkspace() {
    try {
      unregisterForegroundLaunch({
        registryPath: hostRegistryFile,
        launchId,
        registrationToken: launchRegistrationToken
      });
    } catch (error) {
      console.warn(
        `Could not release foreground registration: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  function registerBackgroundWorkspace() {
    registerBackgroundLaunch({
      resources: {
        composeProject: launchSpec.composeProject,
        stateNamespace: launchSpec.stateNamespace,
        attemptId: launchSpec.attemptId
      },
      registryPath: hostRegistryFile,
      identity: {
        canonicalPath: canonicalWorkspacePath,
        workspaceHash,
        projectId
      },
      launchId,
      sessionId: launchSessionId,
      runId: launchRunId,
      profile: selectedLaunchProfile(),
      packRoots: packSet?.packs.map(({ root }) => root) ?? [],
      registrationToken: launchRegistrationToken
    });
    process.once("exit", () => {
      try {
        unregisterBackgroundLaunch({
          registryPath: hostRegistryFile,
          projectId,
          sessionId: launchSessionId,
          registrationToken: launchRegistrationToken
        });
      } catch (error) {
        console.warn(
          `Could not release background registration: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    assertNoMaintenance(resolve(hostRegistryFile, "..", "updates"));
  }

  return {
    claimForegroundWorkspace,
    registerBackgroundWorkspace,
    releaseForegroundWorkspace
  };
}
