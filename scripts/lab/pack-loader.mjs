/**
 * Versioned workflow-pack loader and materializer.
 *
 * Host-approved absolute pack roots may contribute only schema-declared,
 * namespaced resources and bounded managed-run metadata. The loader validates
 * file types, containment, versions, capabilities, services, models,
 * contracts, and collision-free namespaces before copying declared files into
 * fresh project-scoped host configuration. It never exposes pack host paths or
 * lets a pack add credentials, arbitrary services, gateway routes, publishing,
 * or permission-policy authority. Reference: docs/packs.md.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";

export const PACK_SCHEMA_VERSION = 2;
export const SUPPORTED_PACK_SCHEMA_VERSIONS = Object.freeze([1, 2]);
const RESOURCE_ROOTS = new Set([
  "agents",
  "commands",
  "resources",
  "skills",
  "themes"
]);
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "id",
  "label",
  "version",
  "namespace",
  "minimumLabVersion",
  "resources",
  "managedRuns",
  "qualityContracts",
  "contracts",
  "services",
  "permissions",
  "models",
  "verification",
  "artifacts"
]);
const PACK_PERMISSIONS = new Set([
  "browser",
  "design",
  "image",
  "preview",
  "research"
]);
const SERVICE_PROFILES = new Set(["browser", "design", "preview", "research"]);
const ADAPTER_KINDS = new Set(["monorepo", "node", "python"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field))
      throw new Error(`${label} has unknown field: ${field}`);
  }
}

function identifier(value, label) {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(String(value ?? ""))) {
    throw new Error(`${label} must be a lowercase, dash-separated identifier.`);
  }
  return value;
}

function versionTuple(value, label) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) throw new Error(`${label} must be a semantic version.`);
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  const left = versionTuple(actual, "Lab version");
  const right = versionTuple(minimum, "minimumLabVersion");
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function boundedStrings(values, label, allowed = null) {
  if (!Array.isArray(values) || values.length > 32) {
    throw new Error(`${label} must be an array with at most 32 entries.`);
  }
  return [
    ...new Set(
      values.map((value) => {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 128
        ) {
          throw new Error(`${label} entries must be bounded strings.`);
        }
        if (allowed && !allowed.has(value)) {
          throw new Error(`${label} contains unsupported value: ${value}`);
        }
        return value;
      })
    )
  ];
}

function validateWorkflowSurface(manifest, packRoot, id) {
  const namespace =
    manifest.schemaVersion === 1
      ? id
      : identifier(manifest.namespace, `Pack ${id} namespace`);
  const permissions = boundedStrings(
    manifest.permissions ?? [],
    `Pack ${id} permissions`,
    PACK_PERMISSIONS
  );
  const services = {};
  for (const [serviceId, value] of Object.entries(manifest.services ?? {})) {
    identifier(serviceId, `Pack ${id} service`);
    if (!plainObject(value))
      throw new Error(`Pack ${id} service ${serviceId} must be an object.`);
    assertFields(
      value,
      new Set(["profile", "required"]),
      `Pack ${id} service ${serviceId}`
    );
    if (!SERVICE_PROFILES.has(value.profile)) {
      throw new Error(
        `Pack ${id} service ${serviceId} has unsupported profile: ${value.profile}`
      );
    }
    services[serviceId] = {
      profile: value.profile,
      required: Boolean(value.required)
    };
  }
  const models = {};
  for (const [alias, value] of Object.entries(manifest.models ?? {})) {
    identifier(alias, `Pack ${id} model alias`);
    if (!plainObject(value))
      throw new Error(`Pack ${id} model ${alias} must be an object.`);
    assertFields(
      value,
      new Set(["model", "family", "purpose"]),
      `Pack ${id} model ${alias}`
    );
    if (
      ![value.model, value.family, value.purpose].every(
        (entry) =>
          typeof entry === "string" && entry.length > 0 && entry.length <= 200
      )
    ) {
      throw new Error(
        `Pack ${id} model ${alias} needs bounded model, family, and purpose strings.`
      );
    }
    models[alias] = structuredClone(value);
  }
  const verification = manifest.verification ?? {};
  if (!plainObject(verification))
    throw new Error(`Pack ${id} verification must be an object.`);
  assertFields(
    verification,
    new Set(["adapters", "contracts"]),
    `Pack ${id} verification`
  );
  const normalizedVerification = {
    adapters: boundedStrings(
      verification.adapters ?? [],
      `Pack ${id} verification adapters`,
      ADAPTER_KINDS
    ),
    contracts: boundedStrings(
      verification.contracts ?? [],
      `Pack ${id} verification contracts`
    )
  };
  const artifacts = (manifest.artifacts ?? []).map((artifact, index) => {
    if (!plainObject(artifact))
      throw new Error(`Pack ${id} artifact ${index} must be an object.`);
    assertFields(
      artifact,
      new Set(["id", "root", "kinds"]),
      `Pack ${id} artifact ${index}`
    );
    return {
      id: identifier(artifact.id, `Pack ${id} artifact ${index} id`),
      root: safeArtifactRoot(artifact.root, `Pack ${id} artifact ${index}`),
      kinds: boundedStrings(
        artifact.kinds ?? [],
        `Pack ${id} artifact ${index} kinds`
      )
    };
  });
  const artifactIds = artifacts.map(({ id: artifactId }) => artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error(`Pack ${id} artifact IDs must be unique.`);
  }
  void packRoot;
  return {
    namespace,
    permissions,
    services,
    models,
    verification: normalizedVerification,
    artifacts
  };
}

function inside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function safeSource(packRoot, source, label) {
  if (!source || isAbsolute(source))
    throw new Error(`${label} source must be relative.`);
  const lexical = resolve(packRoot, source);
  if (!inside(packRoot, lexical) || !existsSync(lexical)) {
    throw new Error(
      `${label} source is outside the pack or missing: ${source}`
    );
  }
  const resolved = realpathSync(lexical);
  if (!inside(packRoot, resolved) || !lstatSync(lexical).isFile()) {
    throw new Error(
      `${label} source must be a regular file inside the pack: ${source}`
    );
  }
  return resolved;
}

function safeTarget(target, label) {
  if (!target || isAbsolute(target))
    throw new Error(`${label} target must be relative.`);
  const normalized = target.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length < 2 ||
    parts.some((part) => part === "." || part === "..") ||
    !RESOURCE_ROOTS.has(parts[0])
  ) {
    throw new Error(
      `${label} target must stay under an approved pack resource root.`
    );
  }
  return parts.join("/");
}

function safeArtifactRoot(value, label) {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    throw new Error(`${label} must be a relative project artifact root.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must stay within the project.`);
  }
  return parts.join("/");
}

function validateManagedRun(kind, value) {
  identifier(kind, "Managed-run kind");
  if (!plainObject(value))
    throw new Error(`Managed run ${kind} must be an object.`);
  assertFields(
    value,
    new Set([
      "agent",
      "aliases",
      "capabilities",
      "model",
      "qualityContract",
      "taskPatterns",
      "taskPrefix",
      "tooling"
    ]),
    `Managed run ${kind}`
  );
  identifier(value.agent, `Managed run ${kind} agent`);
  if (typeof value.taskPrefix !== "string") {
    throw new Error(`Managed run ${kind} needs a taskPrefix string.`);
  }
  for (const field of ["aliases", "capabilities", "taskPatterns", "tooling"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`Managed run ${kind} ${field} must be an array.`);
    }
  }
  for (const alias of value.aliases ?? []) {
    identifier(alias, `Managed run ${kind} alias`);
  }
  for (const tool of value.tooling ?? []) {
    if (!new Set(["design", "research"]).has(tool)) {
      throw new Error(`Managed run ${kind} has unsupported tooling: ${tool}`);
    }
  }
  for (const capability of value.capabilities ?? []) {
    if (!new Set(["image"]).has(capability)) {
      throw new Error(
        `Managed run ${kind} has unsupported capability: ${capability}`
      );
    }
  }
  for (const pattern of value.taskPatterns ?? []) {
    if (typeof pattern !== "string" || pattern.length > 256) {
      throw new Error(
        `Managed run ${kind} task patterns must be strings of at most 256 characters.`
      );
    }
    new RegExp(pattern, "iu");
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new Error(`Managed run ${kind} model must be a string.`);
  }
  if (value.qualityContract !== undefined) {
    identifier(value.qualityContract, `Managed run ${kind} qualityContract`);
  }
  return {
    agent: value.agent,
    aliases: [...new Set([kind, ...(value.aliases ?? [])])],
    capabilities: value.capabilities ?? [],
    model: value.model ?? null,
    qualityContract: value.qualityContract ?? "coding",
    taskPatterns: value.taskPatterns ?? [],
    taskPrefix: value.taskPrefix,
    tooling: value.tooling ?? []
  };
}

export function splitPackRoots(value = process.env.OPENCODE_LAB_PACKS ?? "") {
  return String(value)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function configuredPackRoots({ env = process.env, envFile } = {}) {
  if (env.OPENCODE_LAB_PACKS !== undefined)
    return splitPackRoots(env.OPENCODE_LAB_PACKS);
  if (!envFile || !existsSync(envFile)) return [];
  const match = readFileSync(envFile, "utf8").match(
    /^OPENCODE_LAB_PACKS=(.*)$/mu
  );
  let value = match?.[1]?.trim() ?? "";
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return splitPackRoots(value);
}

export function loadPackManifest(packRoot, { labVersion = "1.0.0" } = {}) {
  const root = realpathSync(resolve(packRoot));
  const manifestPath = resolve(root, "opencode-lab.pack.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new Error(`Pack manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!plainObject(manifest))
    throw new Error("Pack manifest must be an object.");
  assertFields(manifest, TOP_LEVEL_FIELDS, "Pack manifest");
  if (!SUPPORTED_PACK_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    throw new Error(
      `Unsupported pack schema version: ${manifest.schemaVersion}`
    );
  }
  if (manifest.resources !== undefined && !Array.isArray(manifest.resources)) {
    throw new Error("Pack manifest resources must be an array.");
  }
  for (const field of [
    "managedRuns",
    "qualityContracts",
    "contracts",
    "services",
    "models"
  ]) {
    if (manifest[field] !== undefined && !plainObject(manifest[field])) {
      throw new Error(`Pack manifest ${field} must be an object.`);
    }
  }
  const id = identifier(manifest.id, "Pack id");
  versionTuple(manifest.version, `Pack ${id} version`);
  if (typeof manifest.minimumLabVersion !== "string") {
    throw new Error(`Pack ${id} minimumLabVersion must be a semantic version.`);
  }
  if (!versionAtLeast(labVersion, manifest.minimumLabVersion)) {
    throw new Error(
      `Pack ${id} needs OpenCode Command Center ${manifest.minimumLabVersion} or newer.`
    );
  }
  const resources = (manifest.resources ?? []).map((resource, index) => {
    if (!plainObject(resource))
      throw new Error(`Pack ${id} resource ${index} must be an object.`);
    assertFields(
      resource,
      new Set(["source", "target"]),
      `Pack ${id} resource ${index}`
    );
    return {
      source: safeSource(root, resource.source, `Pack ${id} resource ${index}`),
      target: safeTarget(resource.target, `Pack ${id} resource ${index}`)
    };
  });
  const managedRuns = Object.fromEntries(
    Object.entries(manifest.managedRuns ?? {}).map(([kind, value]) => [
      kind,
      validateManagedRun(kind, value)
    ])
  );
  if (manifest.qualityContracts && manifest.contracts) {
    throw new Error(
      `Pack ${id} cannot declare both qualityContracts and contracts.`
    );
  }
  const qualityContracts = Object.fromEntries(
    Object.entries(manifest.contracts ?? manifest.qualityContracts ?? {}).map(
      ([contract, source]) => [
        identifier(contract, "Quality contract id"),
        safeSource(root, source, `Quality contract ${contract}`)
      ]
    )
  );
  const workflow = validateWorkflowSurface(manifest, root, id);
  const declaredAgents = new Set(
    resources
      .map(({ target }) => target.match(/^agents\/(.+)\.md$/u)?.[1])
      .filter(Boolean)
  );
  for (const [kind, run] of Object.entries(managedRuns)) {
    if (!declaredAgents.has(run.agent)) {
      throw new Error(
        `Managed run ${kind} must declare its agent resource: agents/${run.agent}.md`
      );
    }
    if (
      !new Set(["coding", "research", ...Object.keys(qualityContracts)]).has(
        run.qualityContract
      )
    ) {
      throw new Error(
        `Managed run ${kind} references an undeclared quality contract: ${run.qualityContract}`
      );
    }
  }
  for (const contract of workflow.verification.contracts) {
    if (
      !new Set(["coding", "research", ...Object.keys(qualityContracts)]).has(
        contract
      )
    ) {
      throw new Error(
        `Pack ${id} verification references an undeclared contract: ${contract}`
      );
    }
  }
  return {
    schemaVersion: manifest.schemaVersion,
    id,
    label: String(manifest.label ?? id).trim() || id,
    version: manifest.version,
    minimumLabVersion: manifest.minimumLabVersion,
    root,
    resources,
    managedRuns,
    qualityContracts,
    ...workflow
  };
}

export function loadPackSet({
  roots = splitPackRoots(),
  labVersion = "1.0.0"
} = {}) {
  const packs = roots.map((root) => loadPackManifest(root, { labVersion }));
  const ids = new Set();
  const namespaces = new Set();
  const resourceTargets = new Set();
  const managedRuns = {};
  const qualityContracts = {};
  const services = {};
  const models = {};
  const artifacts = {};
  for (const pack of packs) {
    if (ids.has(pack.id)) throw new Error(`Duplicate pack id: ${pack.id}`);
    ids.add(pack.id);
    if (namespaces.has(pack.namespace)) {
      throw new Error(`Pack namespace conflict: ${pack.namespace}`);
    }
    namespaces.add(pack.namespace);
    for (const resource of pack.resources) {
      if (resourceTargets.has(resource.target)) {
        throw new Error(`Pack resource target conflict: ${resource.target}`);
      }
      resourceTargets.add(resource.target);
    }
    for (const [kind, run] of Object.entries(pack.managedRuns)) {
      if (managedRuns[kind])
        throw new Error(`Managed-run kind conflict: ${kind}`);
      managedRuns[kind] = { ...run, packId: pack.id };
    }
    for (const [id, path] of Object.entries(pack.qualityContracts)) {
      if (qualityContracts[id])
        throw new Error(`Quality contract conflict: ${id}`);
      qualityContracts[id] = path;
    }
    for (const [id, service] of Object.entries(pack.services)) {
      const key = `${pack.namespace}:${id}`;
      if (services[key])
        throw new Error(`Pack service namespace conflict: ${key}`);
      services[key] = { ...service, packId: pack.id };
    }
    for (const [id, model] of Object.entries(pack.models)) {
      const key = `${pack.namespace}:${id}`;
      if (models[key]) throw new Error(`Pack model namespace conflict: ${key}`);
      models[key] = { ...model, packId: pack.id };
    }
    for (const artifact of pack.artifacts) {
      const key = `${pack.namespace}:${artifact.id}`;
      if (artifacts[key])
        throw new Error(`Pack artifact namespace conflict: ${key}`);
      artifacts[key] = { ...artifact, packId: pack.id };
    }
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        packs.map(({ id, version, root }) => ({ id, version, root }))
      )
    )
    .digest("hex");
  return {
    packs,
    managedRuns,
    qualityContracts,
    services,
    models,
    artifacts,
    digest
  };
}

export function selectPackSet(
  packSet,
  enabledIds,
  { labVersion = "1.0.0" } = {}
) {
  if (!Array.isArray(enabledIds)) {
    throw new Error("Enabled pack IDs must be an array.");
  }
  const byId = new Map(packSet.packs.map((pack) => [pack.id, pack]));
  const unknown = enabledIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Project contract enables unavailable packs: ${unknown.join(", ")}`
    );
  }
  return loadPackSet({
    roots: enabledIds.map((id) => byId.get(id).root),
    labVersion
  });
}

export function packAgentConfig(packSet, agent) {
  return (
    Object.values(packSet.managedRuns).find((run) => run.agent === agent) ??
    null
  );
}

export function managedRunProfiles(packSet, builtIns = {}) {
  return { ...builtIns, ...packSet.managedRuns };
}

export function inferPackAgent(packSet, task) {
  for (const run of Object.values(packSet.managedRuns)) {
    if (
      run.taskPatterns.some((pattern) => new RegExp(pattern, "iu").test(task))
    ) {
      return run.agent;
    }
  }
  return null;
}

export function packAgentAlias(packSet, value) {
  const wanted = String(value).toLowerCase();
  for (const run of Object.values(packSet.managedRuns)) {
    if (run.agent === wanted || run.aliases.includes(wanted)) return run.agent;
  }
  return null;
}

export function materializePackConfig({
  coreConfigRoot,
  destination,
  packSet
}) {
  const core = realpathSync(resolve(coreConfigRoot));
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target))
    throw new Error(`Pack config destination already exists: ${target}`);
  cpSync(core, target, { recursive: true, errorOnExist: true });
  const generatedRoot = realpathSync(target);
  for (const pack of packSet.packs) {
    for (const resource of pack.resources) {
      const output = resolve(generatedRoot, ...resource.target.split("/"));
      if (!inside(generatedRoot, output) || existsSync(output)) {
        throw new Error(
          `Pack resource collides with core config: ${resource.target}`
        );
      }
      mkdirSync(dirname(output), { recursive: true });
      if (!inside(generatedRoot, realpathSync(dirname(output)))) {
        throw new Error(
          `Pack resource target resolves outside generated config: ${resource.target}`
        );
      }
      copyFileSync(resource.source, output);
    }
  }
  for (const [id, source] of Object.entries(packSet.qualityContracts)) {
    const output = resolve(
      generatedRoot,
      "resources",
      "contracts",
      `${id}.json`
    );
    if (existsSync(output)) {
      throw new Error(`Pack quality contract collides with config: ${id}`);
    }
    mkdirSync(dirname(output), { recursive: true });
    if (!inside(generatedRoot, realpathSync(dirname(output)))) {
      throw new Error(
        `Pack quality contract target resolves outside generated config: ${id}`
      );
    }
    copyFileSync(source, output);
  }
  return generatedRoot;
}

export function packUiSummary(packSet) {
  return JSON.stringify(
    packSet.packs.map((pack) => ({
      id: pack.id,
      label: pack.label,
      version: pack.version,
      namespace: pack.namespace,
      agents: pack.resources
        .filter(({ target }) => target.startsWith("agents/"))
        .map(({ target }) =>
          target.slice("agents/".length).replace(/\.md$/u, "")
        ),
      commands: pack.resources
        .filter(({ target }) => target.startsWith("commands/"))
        .map(({ target }) =>
          target.slice("commands/".length).replace(/\.md$/u, "")
        ),
      services: Object.keys(pack.services),
      permissions: pack.permissions,
      models: Object.keys(pack.models),
      verification: pack.verification,
      artifacts: pack.artifacts.map(({ id }) => id)
    }))
  );
}

export function qualityContractPath(packSet, id, coreContractRoot) {
  return (
    packSet.qualityContracts[id] ?? resolve(coreContractRoot, `${id}.json`)
  );
}
