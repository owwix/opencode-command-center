import { execFileSync } from "node:child_process";
import {
  accessSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { projectHostState } from "./host-state.mjs";

export const LAB_VOLUME_SUFFIXES = Object.freeze([
  "open-design-state",
  "hound-state",
  "opencode-state",
  "opencode-user-config",
  "opencode-package-cache",
  "opencode-tmp",
  "notion-publisher-state"
]);

export function labVolumeNames(projectId) {
  return LAB_VOLUME_SUFFIXES.map(
    (suffix) => `opencode-lab-${projectId}-${suffix}`
  );
}

const LEGACY_VOLUME_PREFIXES = Object.freeze([
  "cf-coding-agent_",
  "cf-coding-agent-"
]);

function firstMatch(source, expression) {
  return source.match(expression)?.[1] ?? null;
}

function commandResult(command, args, { cwd, env } = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    return {
      ok: false,
      output: String(error?.stdout ?? error?.stderr ?? "").trim(),
      error: error?.code ?? error?.message ?? "unavailable"
    };
  }
}

export function readImageBuildDefinition({ root, readFile = readFileSync }) {
  const dockerfilePath = resolve(root, "Dockerfile.opencode");
  const composePath = resolve(root, "docker-compose.opencode.yml");
  const dockerfile = readFile(dockerfilePath, "utf8");
  const compose = readFile(composePath, "utf8");
  const openDesignPin = firstMatch(
    dockerfile,
    /^FROM ghcr\.io\/nexu-io\/od@(sha256:[a-f0-9]{64}) AS open-design-runtime$/mu
  );
  const opencodePin = firstMatch(
    dockerfile,
    /^FROM ghcr\.io\/anomalyco\/opencode@(sha256:[a-f0-9]{64})$/mu
  );
  const composeOpenDesignPin = firstMatch(
    compose,
    /^\s*image: ghcr\.io\/nexu-io\/od@(sha256:[a-f0-9]{64})$/mu
  );
  const fingerprint = createHash("sha256")
    .update(dockerfile)
    .update("\nopen-design=")
    .update(openDesignPin ?? "missing")
    .digest("hex");
  return {
    dockerfilePath,
    composePath,
    fingerprint,
    openDesignPin,
    composeOpenDesignPin,
    opencodePin,
    openDesignPinMatchesCompose:
      Boolean(openDesignPin) && openDesignPin === composeOpenDesignPin
  };
}

export function defaultProfileIsMinimal(compose) {
  const block = (service) => {
    const start = compose.indexOf(`\n  ${service}:`);
    if (start < 0) return "";
    const remainder = compose.slice(start + 1);
    const next = remainder.search(/\n  [^\s]/u);
    return remainder.slice(0, next < 0 ? undefined : next);
  };
  const optionalServices = [
    "open-design",
    "hound-firewall",
    "hound",
    "hound-relay"
  ];
  const optionalProfiles = optionalServices.every((service) =>
    /^\s*profiles: \["(?:design|research)"\]/mu.test(block(service))
  );
  const requiredBlocks = `${block("agent-gateway")}\n${block("opencode")}`;
  return {
    ok: optionalProfiles && !/\b(?:hound|open-design):/u.test(requiredBlocks),
    optionalServices
  };
}

export function isLegacyLabVolume(name) {
  return (
    typeof name === "string" &&
    !name.startsWith("opencode-lab-") &&
    LEGACY_VOLUME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function writableDirectory(path, { access, stat = statSync } = {}) {
  try {
    access(path, constants.W_OK);
    return true;
  } catch {
    // The Codex sandbox can deny a write probe while the macOS owner-mode
    // contract is still valid. Fall back to that contract without creating a
    // diagnostic file or modifying runtime state.
    try {
      const details = stat(path);
      const mode = details.mode;
      const uid = process.getuid?.();
      const groups = new Set(process.getgroups?.() ?? []);
      if (uid !== undefined && details.uid === uid)
        return Boolean(mode & 0o200);
      if (groups.has(details.gid)) return Boolean(mode & 0o020);
      return Boolean(mode & 0o002);
    } catch {
      return false;
    }
  }
}

function nearestExistingDirectory(path, exists = existsSync) {
  let candidate = resolve(path);
  while (!exists(candidate)) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

export function collectLaunchSnapshot({
  root,
  workspace,
  docker = commandResult,
  readFile = readFileSync,
  exists = existsSync,
  access = accessSync,
  env = process.env
} = {}) {
  const resolvedRoot = resolve(root ?? ".");
  const requestedWorkspace = resolve(workspace ?? resolvedRoot);
  let canonicalRoot = requestedWorkspace;
  try {
    canonicalRoot = realpathSync(requestedWorkspace);
  } catch {
    // Setup diagnostics may run before the requested root is created.
  }
  const projectId = `project_${createHash("sha256")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 24)}`;
  const expectedVolumes = labVolumeNames(projectId);
  const build = readImageBuildDefinition({ root: resolvedRoot, readFile });
  const compose = readFile(build.composePath, "utf8");
  const minimalProfile = defaultProfileIsMinimal(compose);
  const dockerVersion = docker(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    {
      cwd: resolvedRoot,
      env
    }
  );
  const volumeResult = dockerVersion.ok
    ? docker("docker", ["volume", "ls", "--format", "{{.Name}}"], {
        cwd: resolvedRoot,
        env
      })
    : { ok: false, output: "" };
  const availableVolumes = new Set(
    volumeResult.output
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const allVolumes = [...availableVolumes];
  const runtimeDirectory = projectHostState(projectId, { env });
  const runtimeConfigWritable = writableDirectory(
    nearestExistingDirectory(runtimeDirectory, exists),
    { access }
  );
  const imageResult = dockerVersion.ok
    ? docker(
        "docker",
        [
          "image",
          "inspect",
          env.OPENCODE_LAB_OPENCODE_IMAGE ?? "opencode-lab-opencode:local"
        ],
        {
          cwd: resolvedRoot,
          env
        }
      )
    : { ok: false, output: "" };
  let image = null;
  if (imageResult.ok) {
    try {
      image = JSON.parse(imageResult.output)[0] ?? null;
    } catch {
      image = null;
    }
  }
  const localFingerprint =
    image?.Config?.Labels?.["io.opencode-lab.build-fingerprint"] ?? null;
  return {
    generatedAt: new Date().toISOString(),
    composeProject: "opencode-lab",
    docker: {
      ok: dockerVersion.ok,
      detail: dockerVersion.ok
        ? dockerVersion.output.trim()
        : dockerVersion.error
    },
    volumes: {
      expected: expectedVolumes.map((name) => ({
        name,
        present: availableVolumes.has(name)
      })),
      legacy: allVolumes.filter(isLegacyLabVolume)
    },
    defaultProfile: minimalProfile,
    runtimeConfig: {
      path: runtimeDirectory,
      writable: runtimeConfigWritable
    },
    image: {
      name: env.OPENCODE_LAB_OPENCODE_IMAGE ?? "opencode-lab-opencode:local",
      localID: image?.Id ?? null,
      localFingerprint,
      expectedFingerprint: build.fingerprint,
      matchesDockerfile: localFingerprint === build.fingerprint,
      dockerfilePin: build.opencodePin,
      openDesignPin: build.openDesignPin,
      openDesignPinMatchesCompose: build.openDesignPinMatchesCompose
    }
  };
}

export function snapshotLines(snapshot) {
  const lines = [
    `Launch snapshot (${snapshot.composeProject})`,
    `Docker: ${snapshot.docker.ok ? `ready (${snapshot.docker.detail || "server"})` : `unavailable (${snapshot.docker.detail || "unknown"})`}`,
    `Default profile: ${snapshot.defaultProfile.ok ? "coding only; Hound/OpenDesign are optional" : "unexpected optional-service dependency"}`,
    `Runtime config: ${snapshot.runtimeConfig.writable ? `writable (${snapshot.runtimeConfig.path})` : `not writable (${snapshot.runtimeConfig.path})`}`,
    `Volumes: ${snapshot.volumes.expected.filter((volume) => volume.present).length}/${snapshot.volumes.expected.length} named opencode-lab-* volumes present`,
    `OpenCode image: ${snapshot.image.localID ? snapshot.image.localID.slice(0, 19) : "not built"}`,
    `Pins: OpenCode ${snapshot.image.dockerfilePin ?? "missing"} · OpenDesign ${snapshot.image.openDesignPin ?? "missing"}${snapshot.image.openDesignPinMatchesCompose ? "" : " (Dockerfile/Compose mismatch)"}`
  ];
  if (!snapshot.image.matchesDockerfile) {
    lines.push(
      "Image is stale or unlabelled for this Dockerfile; run `lab --rebuild` before launch."
    );
  }
  if (snapshot.volumes.legacy.length) {
    lines.push(
      `Legacy Lab volumes: ${snapshot.volumes.legacy.join(", ")}. Inspect with \`occtl prune\`; deletion requires \`occtl prune --apply\`.`
    );
  }
  return lines;
}
