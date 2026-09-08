import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { withToolingConfig } from "../../opencode-tooling.mjs";
import { materializePackConfig } from "../pack-loader.mjs";
import { prepareManagedGitView } from "./git-view.mjs";

export function createRuntimeConfig(context) {
  const {
    configIgnoreFile,
    envFile,
    packSet,
    projectStateDirectory,
    runtimeConfigFile,
    runtimeConfigMaxAgeMs,
    tooling,
    workspaceMasks,
    workspacePath
  } = context;
  let generatedPackConfigRoot = null;

  function removeStaleRuntimeConfigs(now = Date.now()) {
    if (!existsSync(projectStateDirectory)) return;
    for (const entry of readdirSync(projectStateDirectory)) {
      if (!/^opencode-runtime-\d+-[0-9a-f]{12}\.json$/u.test(entry)) continue;
      const path = resolve(projectStateDirectory, entry);
      try {
        const stats = lstatSync(path);
        if (stats.isFile() && now - stats.mtimeMs > runtimeConfigMaxAgeMs) {
          unlinkSync(path);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(`Could not remove stale runtime config: ${entry}`);
        }
      }
    }
  }

  function writeRuntimeConfig() {
    mkdirSync(projectStateDirectory, { recursive: true });
    removeStaleRuntimeConfigs();
    const config = withToolingConfig(
      JSON.parse(readFileSync(resolve("opencode.json"), "utf8")),
      tooling
    );
    const descriptor = openSync(runtimeConfigFile, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
    return runtimeConfigFile;
  }

  function ensureConfigIgnoreFile() {
    mkdirSync(projectStateDirectory, { recursive: true });
    if (existsSync(configIgnoreFile)) {
      const details = lstatSync(configIgnoreFile);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error(
          `Refusing to use a non-file OpenCode config ignore path: ${configIgnoreFile}`
        );
      }
      return configIgnoreFile;
    }
    const descriptor = openSync(configIgnoreFile, "wx", 0o600);
    closeSync(descriptor);
    return configIgnoreFile;
  }

  function removeRuntimeConfig() {
    if (existsSync(runtimeConfigFile)) unlinkSync(runtimeConfigFile);
  }

  function preparePackConfig() {
    if (packSet.packs.length === 0) return resolve(".opencode");
    mkdirSync(projectStateDirectory, { recursive: true });
    const parent = mkdtempSync(
      join(projectStateDirectory, "launch-pack-config-")
    );
    generatedPackConfigRoot = parent;
    return materializePackConfig({
      coreConfigRoot: resolve(".opencode"),
      destination: join(parent, ".opencode"),
      packSet
    });
  }

  function removePackConfig() {
    if (!generatedPackConfigRoot) return;
    const expectedParent = `${projectStateDirectory}/`;
    if (!generatedPackConfigRoot.startsWith(expectedParent)) {
      throw new Error(
        "Refusing to remove pack config outside project runtime state."
      );
    }
    rmSync(generatedPackConfigRoot, { recursive: true, force: true });
    generatedPackConfigRoot = null;
  }

  function workspaceMaskEnvironment() {
    return Object.fromEntries(
      workspaceMasks.map(([name, basename, fallback]) => {
        const hostPath = join(workspacePath, basename);
        if (!existsSync(hostPath)) {
          return [name, `/run/opencode-lab/unused-masks/${fallback}`];
        }
        const details = lstatSync(hostPath);
        if (details.isSymbolicLink() || !details.isFile()) {
          throw new Error(
            `Credential mask target must be a regular file: ${hostPath}`
          );
        }
        return [name, `/workspace/${basename}`];
      })
    );
  }

  function safeHostEnvironment(extra = {}) {
    const allowed = [
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TMP",
      "TMPDIR",
      "TEMP",
      "USER",
      "XDG_RUNTIME_DIR"
    ];
    return {
      ...Object.fromEntries(
        allowed
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]])
      ),
      ...extra
    };
  }

  function ensureEnvSecret(name) {
    const contents = readFileSync(envFile, "utf8");
    const tokenPattern = new RegExp(`^${name}=(.*)$`, "m");
    const match = contents.match(tokenPattern);
    if (match?.[1]?.trim()) {
      chmodSync(envFile, 0o600);
      return match[1].trim();
    }

    const token = randomBytes(32).toString("hex");
    const tokenLine = `${name}=${token}`;
    const updated = match
      ? contents.replace(tokenPattern, tokenLine)
      : `${contents.replace(/\s*$/, "")}\n${tokenLine}\n`;
    writeFileSync(envFile, updated, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return token;
  }

  function envValue(name) {
    const contents = readFileSync(envFile, "utf8");
    const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
    let value = match?.[1]?.trim() ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }

  function requiredEnvValue(name) {
    const value = envValue(name);
    if (!value) throw new Error(`${name} is required in opencode.env.`);
    return value;
  }

  function selectedLaunchProfile() {
    if (tooling.research && tooling.design) return "research+design";
    if (tooling.research) return "research";
    if (tooling.design) return "design";
    return "fast";
  }

  return {
    managedGitEnvironment: (managed) =>
      managed
        ? {
            OPENCODE_MANAGED_GIT_HOST: prepareManagedGitView(
              workspacePath,
              projectStateDirectory
            )
          }
        : {},
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
    writeRuntimeConfig
  };
}
