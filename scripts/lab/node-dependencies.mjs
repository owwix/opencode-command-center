import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labStateRoot } from "./host-state.mjs";
import { projectIdentity } from "./workspace-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const image = JSON.parse(readFileSync(join(root, "versions.lock"), "utf8"))
  .runtimes.node.image;
export function dependencyFingerprint(workspace) {
  const hash = createHash("sha256").update(image);
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(workspace, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error(`Expected a regular ${name}.`);
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}
const recordPath = (id) =>
  join(labStateRoot(), "projects", id, "node-dependencies.json");
export function dependencyMountArgs(projectId, workspaceHash) {
  if (!/^project_[a-f0-9]{24}$/u.test(projectId ?? "")) return [];
  const path = recordPath(projectId);
  if (!existsSync(path)) return [];
  const record = JSON.parse(readFileSync(path, "utf8"));
  const identity = projectIdentity(record.workspace);
  if (
    identity.projectId !== projectId ||
    identity.workspaceHash !== workspaceHash ||
    !/^opencode-lab-deps-[a-f0-9]{32}$/u.test(record.volume)
  )
    throw new Error("Dependency volume identity mismatch.");
  if (dependencyFingerprint(record.workspace) !== record.fingerprint)
    throw new Error(
      `Node dependency lock changed. Run node scripts/lab/node-dependencies.mjs ${record.workspace} from the harness before reopening.`
    );
  return ["--volume", `${record.volume}:/workspace/node_modules:ro`];
}
export function prepareNodeDependencies(workspace) {
  const identity = projectIdentity(workspace);
  const fingerprint = dependencyFingerprint(identity.canonicalPath);
  const lock = JSON.parse(
    readFileSync(join(identity.canonicalPath, "package-lock.json"), "utf8")
  );
  for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
    if (!name) continue;
    if (pkg.link || !pkg.resolved || !pkg.integrity)
      throw new Error(
        `Only integrity-pinned registry dependencies are supported: ${name}`
      );
    const url = new URL(pkg.resolved);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error(`Dependency is outside the public npm registry: ${name}`);
  }
  const suffix = createHash("sha256")
    .update(identity.projectId + fingerprint + randomUUID())
    .digest("hex")
    .slice(0, 32);
  const volume = `opencode-lab-deps-${suffix}`;
  const docker = (args) =>
    execFileSync("docker", args, { stdio: "inherit", timeout: 600000 });
  docker([
    "volume",
    "create",
    "--label",
    `org.opencode-lab.project=${identity.projectId}`,
    volume
  ]);
  // Only manifests enter the networked installer. No source, .npmrc, host
  // credentials or lifecycle scripts cross this boundary.
  docker([
    "run",
    "--rm",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "2g",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--tmpfs",
    "/work:rw,nosuid,nodev,size=32m",
    "--workdir",
    "/work",
    "--mount",
    `type=bind,source=${join(identity.canonicalPath, "package.json")},target=/manifests/package.json,readonly`,
    "--mount",
    `type=bind,source=${join(identity.canonicalPath, "package-lock.json")},target=/manifests/package-lock.json,readonly`,
    "--mount",
    `type=volume,source=${volume},target=/work/node_modules`,
    "--env",
    "npm_config_cache=/tmp/npm",
    "--env",
    "npm_config_registry=https://registry.npmjs.org",
    image,
    "sh",
    "-ec",
    "cp /manifests/package.json /manifests/package-lock.json /work/; npm ci --ignore-scripts --no-audit --no-fund; chmod -R a+rX /work/node_modules"
  ]);
  const target = recordPath(identity.projectId);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({
      workspace: identity.canonicalPath,
      fingerprint,
      volume,
      image
    }),
    { mode: 0o600 }
  );
  console.log(
    `Prepared read-only Linux dependencies for ${identity.canonicalPath}. Re-run after lock changes. Lifecycle scripts were not executed.`
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/lab/node-dependencies.mjs /absolute/workspace"
    );
  prepareNodeDependencies(resolve(process.argv[2]));
}
