/**
 * Project contract v1 loader, detector, validator, and atomic writer.
 *
 * A project may describe bounded argv-based install/verify/development plans,
 * preview ports, artifact roots, risk, and enabled pack IDs. The contract is
 * untrusted metadata: it cannot grant credentials, approval policy, network
 * routes, or host authority. Unknown fields/versions, symlink escapes,
 * traversal, unbounded values, and overwrite attempts fail closed. Detection
 * is read-only; writing requires explicit approval. Reference:
 * docs/project-contract.md.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

export const PROJECT_CONTRACT_SCHEMA_VERSION = 1;
export const PROJECT_CONTRACT_RELATIVE_PATH = ".opencode-lab/project.json";
export const PROJECT_CONTRACT_SCHEMA_URL =
  "https://raw.githubusercontent.com/owwix/opencode-lab/main/schemas/project-v1.schema.json";

const allowedRiskLevels = new Set(["low", "standard", "high"]);
const commandKeys = new Set(["name", "argv", "cwd", "env"]);
const contractKeys = new Set([
  "$schema",
  "schemaVersion",
  "install",
  "verify",
  "development",
  "previewPorts",
  "artifactRoots",
  "riskLevel",
  "enabledPacks"
]);
const previewMappings = new Map([
  [3000, 3100],
  [3001, 3101]
]);
const credentialNamePattern =
  /(?:API[_-]?KEY|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)/iu;

function fail(message) {
  throw new Error(
    `Invalid OpenCode Command Center project contract: ${message}`
  );
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}.`);
  }
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    fail(`${label} must be a non-empty relative path.`);
  }
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.split("/").some((segment) => ["", ".", ".."].includes(segment))
  ) {
    fail(`${label} must stay within the project.`);
  }
  return value;
}

function validateCommand(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  assertExactKeys(value, commandKeys, label);
  if (
    typeof value.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/u.test(value.name)
  ) {
    fail(`${label}.name must be a lowercase identifier.`);
  }
  if (
    !Array.isArray(value.argv) ||
    value.argv.length === 0 ||
    value.argv.length > 32 ||
    value.argv.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.length > 500 ||
        part.includes("\0") ||
        part.includes("\r") ||
        part.includes("\n")
    )
  ) {
    fail(`${label}.argv must contain 1-32 bounded arguments.`);
  }
  if (!/^[a-z0-9][a-z0-9._+-]{0,79}$/iu.test(value.argv[0])) {
    fail(`${label}.argv[0] must be a portable executable name.`);
  }
  if (value.cwd !== undefined) safeRelativePath(value.cwd, `${label}.cwd`);
  if (value.env !== undefined) {
    if (
      !value.env ||
      typeof value.env !== "object" ||
      Array.isArray(value.env)
    ) {
      fail(`${label}.env must be an object.`);
    }
    const entries = Object.entries(value.env);
    if (entries.length > 32) fail(`${label}.env has too many entries.`);
    for (const [name, envValue] of entries) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(name)) {
        fail(`${label}.env contains an invalid variable name.`);
      }
      if (credentialNamePattern.test(name)) {
        fail(`${label}.env cannot contain credential-shaped variables.`);
      }
      if (
        typeof envValue !== "string" ||
        envValue.length > 500 ||
        envValue.includes("\0") ||
        envValue.includes("\r") ||
        envValue.includes("\n")
      ) {
        fail(`${label}.env.${name} must be a bounded single-line string.`);
      }
    }
  }
  return structuredClone(value);
}

function validateCommandList(value, label) {
  if (!Array.isArray(value) || value.length > 20) {
    fail(`${label} must be an array with at most 20 commands.`);
  }
  const names = new Set();
  return value.map((command, index) => {
    const validated = validateCommand(command, `${label}[${index}]`);
    if (names.has(validated.name))
      fail(`${label} command names must be unique.`);
    names.add(validated.name);
    return validated;
  });
}

export function validateProjectContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("root must be an object.");
  }
  assertExactKeys(value, contractKeys, "root");
  if (
    value.$schema !== undefined &&
    value.$schema !== PROJECT_CONTRACT_SCHEMA_URL
  ) {
    fail(`$schema must be ${PROJECT_CONTRACT_SCHEMA_URL}.`);
  }
  if (value.schemaVersion !== PROJECT_CONTRACT_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${PROJECT_CONTRACT_SCHEMA_VERSION}.`);
  }

  const contract = {
    ...(value.$schema ? { $schema: value.$schema } : {}),
    schemaVersion: value.schemaVersion,
    install: validateCommandList(value.install, "install"),
    verify: validateCommandList(value.verify, "verify"),
    development: validateCommandList(value.development, "development")
  };

  if (!Array.isArray(value.previewPorts) || value.previewPorts.length > 2) {
    fail("previewPorts must contain at most two mappings.");
  }
  const previewNames = new Set();
  const previewTargets = new Set();
  contract.previewPorts = value.previewPorts.map((mapping, index) => {
    const label = `previewPorts[${index}]`;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      fail(`${label} must be an object.`);
    }
    assertExactKeys(mapping, new Set(["name", "container", "host"]), label);
    if (
      typeof mapping.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/u.test(mapping.name)
    ) {
      fail(`${label}.name must be a lowercase identifier.`);
    }
    if (previewNames.has(mapping.name))
      fail("preview port names must be unique.");
    previewNames.add(mapping.name);
    if (previewMappings.get(mapping.container) !== mapping.host) {
      fail(`${label} must map container 3000/3001 to host 3100/3101.`);
    }
    if (previewTargets.has(mapping.container)) {
      fail("preview container ports must be unique.");
    }
    previewTargets.add(mapping.container);
    return structuredClone(mapping);
  });

  if (!Array.isArray(value.artifactRoots) || value.artifactRoots.length > 20) {
    fail("artifactRoots must contain at most 20 paths.");
  }
  contract.artifactRoots = value.artifactRoots.map((path, index) =>
    safeRelativePath(path, `artifactRoots[${index}]`)
  );
  if (new Set(contract.artifactRoots).size !== contract.artifactRoots.length) {
    fail("artifactRoots must be unique.");
  }

  if (!allowedRiskLevels.has(value.riskLevel)) {
    fail("riskLevel must be low, standard, or high.");
  }
  contract.riskLevel = value.riskLevel;

  if (!Array.isArray(value.enabledPacks) || value.enabledPacks.length > 20) {
    fail("enabledPacks must contain at most 20 pack IDs.");
  }
  contract.enabledPacks = value.enabledPacks.map((pack, index) => {
    if (typeof pack !== "string" || !/^[a-z][a-z0-9-]{1,63}$/u.test(pack)) {
      fail(`enabledPacks[${index}] must be a lowercase pack ID.`);
    }
    return pack;
  });
  if (new Set(contract.enabledPacks).size !== contract.enabledPacks.length) {
    fail("enabledPacks must be unique.");
  }
  return contract;
}

function canonicalWorkspace(workspace) {
  const requested = resolve(workspace);
  if (!existsSync(requested))
    throw new Error(`Workspace does not exist: ${requested}`);
  const stats = lstatSync(requested);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workspace must be a real directory: ${requested}`);
  }
  return realpathSync(requested);
}

function rootEntries(workspace) {
  return new Map(
    readdirSync(workspace, { withFileTypes: true }).map((entry) => [
      entry.name,
      entry
    ])
  );
}

function readRegularJson(path, maximumBytes = 1024 * 1024) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Configuration must be a regular file: ${path}`);
  }
  if (stats.size > maximumBytes)
    throw new Error(`Configuration is too large: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageManager(entries) {
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("bun.lock") || entries.has("bun.lockb")) return "bun";
  return "npm";
}

function packageScriptCommand(manager, script) {
  if (manager === "yarn") return ["yarn", script];
  if (manager === "pnpm") return ["pnpm", "run", script];
  if (manager === "bun") return ["bun", "run", script];
  return ["npm", "run", script];
}

function nodeContract(workspace, entries) {
  if (!entries.has("package.json")) return null;
  const packageJson = readRegularJson(join(workspace, "package.json"));
  const scripts =
    packageJson?.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts
      : {};
  const manager = packageManager(entries);
  const installArgv =
    manager === "pnpm"
      ? ["pnpm", "install", "--frozen-lockfile"]
      : manager === "yarn"
        ? ["yarn", "install", "--immutable"]
        : manager === "bun"
          ? ["bun", "install", "--frozen-lockfile"]
          : entries.has("package-lock.json")
            ? ["npm", "ci"]
            : ["npm", "install"];
  const hasScript = (name) =>
    typeof scripts[name] === "string" && scripts[name].trim().length > 0;
  const verifyNames = hasScript("check")
    ? ["check"]
    : ["typecheck", "lint", "test", "build"].filter(hasScript);
  const developmentName = hasScript("dev")
    ? "dev"
    : hasScript("start")
      ? "start"
      : null;
  return {
    install: [{ name: manager, argv: installArgv }],
    verify: verifyNames.map((name) => ({
      name,
      argv: packageScriptCommand(manager, name)
    })),
    development: developmentName
      ? [
          {
            name: "app",
            argv: packageScriptCommand(manager, developmentName),
            env: { HOST: "0.0.0.0", PORT: "3000" }
          }
        ]
      : []
  };
}

function pythonContract(entries) {
  const install = [];
  if (entries.has("uv.lock")) {
    install.push({ name: "python", argv: ["uv", "sync", "--frozen"] });
  } else if (entries.has("poetry.lock")) {
    install.push({ name: "python", argv: ["poetry", "install"] });
  } else if (entries.has("requirements.txt")) {
    install.push({
      name: "python",
      argv: ["python", "-m", "pip", "install", "-r", "requirements.txt"]
    });
  }
  const pythonProject =
    entries.has("pyproject.toml") ||
    entries.has("requirements.txt") ||
    entries.has("setup.py");
  return {
    install,
    verify:
      pythonProject && entries.get("tests")?.isDirectory()
        ? [{ name: "python-test", argv: ["python", "-m", "pytest"] }]
        : [],
    development: []
  };
}

function detectedRiskLevel(entries) {
  const highRiskNames = [
    "migrations",
    "terraform",
    "infra",
    "infrastructure",
    "payments",
    "auth"
  ];
  return highRiskNames.some((name) => entries.has(name)) ? "high" : "standard";
}

export function detectProjectContract(workspace, { enabledPacks = [] } = {}) {
  const canonical = canonicalWorkspace(workspace);
  const entries = rootEntries(canonical);
  const node = nodeContract(canonical, entries);
  const python = pythonContract(entries);
  const artifactCandidates = [
    "artifacts",
    "dist",
    "build",
    "coverage",
    "reports"
  ];
  const existingArtifactRoots = artifactCandidates.filter((name) =>
    entries.get(name)?.isDirectory()
  );
  const development = [...(node?.development ?? []), ...python.development];
  return validateProjectContract({
    $schema: PROJECT_CONTRACT_SCHEMA_URL,
    schemaVersion: PROJECT_CONTRACT_SCHEMA_VERSION,
    install: [...(node?.install ?? []), ...python.install],
    verify: [...(node?.verify ?? []), ...python.verify],
    development,
    previewPorts:
      development.length > 0
        ? [{ name: "primary", container: 3000, host: 3100 }]
        : [],
    artifactRoots:
      existingArtifactRoots.length > 0 ? existingArtifactRoots : ["artifacts"],
    riskLevel: detectedRiskLevel(entries),
    enabledPacks
  });
}

function assertContractDirectory(canonical, { create = false } = {}) {
  const directory = join(canonical, dirname(PROJECT_CONTRACT_RELATIVE_PATH));
  if (!existsSync(directory)) {
    if (!create) return directory;
    mkdirSync(directory, { mode: 0o755 });
  }
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Project contract directory must be a real directory: ${directory}`
    );
  }
  if (realpathSync(directory) !== directory) {
    throw new Error(
      `Project contract directory escapes the workspace: ${directory}`
    );
  }
  return directory;
}

export function loadProjectContract(workspace, { enabledPacks = [] } = {}) {
  const canonical = canonicalWorkspace(workspace);
  const directory = assertContractDirectory(canonical);
  const path = join(directory, basename(PROJECT_CONTRACT_RELATIVE_PATH));
  if (!existsSync(path)) {
    return {
      source: "detected",
      path,
      contract: detectProjectContract(canonical, { enabledPacks })
    };
  }
  return {
    source: "declared",
    path,
    contract: validateProjectContract(readRegularJson(path))
  };
}

export function writeProjectContract(
  workspace,
  contract,
  { approved = false } = {}
) {
  if (!approved)
    throw new Error("Writing the project contract requires approval.");
  const canonical = canonicalWorkspace(workspace);
  const validated = validateProjectContract(contract);
  const directory = assertContractDirectory(canonical, { create: true });
  const path = join(directory, basename(PROJECT_CONTRACT_RELATIVE_PATH));
  if (existsSync(path))
    throw new Error(`Project contract already exists: ${path}`);
  const temporary = join(
    directory,
    `.project.json.tmp-${process.pid}-${Date.now()}`
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`);
    closeSync(descriptor);
    renameSync(temporary, path);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor may already be closed.
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already have been renamed or removed.
    }
    throw error;
  }
  return { path, contract: validated };
}

export function contractSummary(
  workspace,
  loaded = loadProjectContract(workspace)
) {
  const canonical = canonicalWorkspace(workspace);
  return {
    project: basename(canonical),
    workspace: canonical,
    source: loaded.source,
    path: relative(canonical, loaded.path),
    installCommands: loaded.contract.install.length,
    verificationCommands: loaded.contract.verify.length,
    developmentCommands: loaded.contract.development.length,
    riskLevel: loaded.contract.riskLevel,
    enabledPacks: [...loaded.contract.enabledPacks]
  };
}
