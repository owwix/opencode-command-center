import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { inspectVisualSemantics } from "../visual-evidence-semantic.mjs";
import { fileDigest, insideDirectory } from "./primitives.mjs";
import {
  MEDIA_EXTENSIONS,
  MEDIA_TYPES_BY_EXTENSION,
  detectMediaType,
  inspectBufferDimensions,
  inspectWithAvailableTool
} from "./media.mjs";

export async function inspectArtifact({
  artifact,
  index,
  workspaceReal,
  contract,
  recorder,
  forceDimensions,
  toolRunner
}) {
  const key = `artifact[${index}]`;
  const artifactId =
    typeof artifact?.id === "string" ? artifact.id : `${key}:invalid`;
  const result = {
    id: artifactId,
    kind: artifact?.kind,
    path: artifact?.path,
    derivedFrom: artifact?.derivedFrom,
    passed: false
  };
  const startCheckIndex = recorder.checks.length;

  const idValid =
    typeof artifact?.id === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/iu.test(artifact.id);
  recorder.check(
    `${key}.id`,
    idValid,
    idValid
      ? "Artifact ID is valid."
      : "Artifact ID must be shell-safe and non-empty.",
    {
      artifactId
    }
  );
  const kindValid =
    typeof artifact?.kind === "string" && artifact.kind.trim().length > 0;
  recorder.check(
    `${key}.kind`,
    kindValid,
    kindValid ? "Artifact kind is present." : "Artifact kind is required.",
    {
      artifactId
    }
  );
  const pathValid =
    typeof artifact?.path === "string" && artifact.path.trim().length > 0;
  recorder.check(
    `${key}.path`,
    pathValid,
    pathValid ? "Artifact path is present." : "Artifact path is required.",
    {
      artifactId
    }
  );
  if (!pathValid) return result;

  const declaredPath = artifact.path.replaceAll("\\", "/");
  const candidate = resolve(workspaceReal, declaredPath);
  const lexicalSafe =
    !isAbsolute(declaredPath) && insideDirectory(workspaceReal, candidate);
  recorder.check(
    `${key}.workspace-boundary`,
    lexicalSafe,
    lexicalSafe
      ? "Artifact path is inside the workspace."
      : "Artifact path escapes the workspace.",
    { artifactId }
  );
  if (!lexicalSafe) return result;

  const extension = extname(declaredPath).toLowerCase();
  const allowed = contract.checks?.allowedExtensions?.[artifact.kind];
  const extensionAllowed =
    !Array.isArray(allowed) || allowed.includes(extension);
  recorder.check(
    `${key}.extension`,
    extensionAllowed,
    extensionAllowed
      ? `Extension ${extension || "(none)"} is allowed for ${artifact.kind}.`
      : `Extension ${extension || "(none)"} is not allowed for ${artifact.kind}.`,
    { artifactId }
  );

  let fileStats;
  let fileReal;
  try {
    [fileStats, fileReal] = await Promise.all([
      stat(candidate),
      realpath(candidate)
    ]);
  } catch (error) {
    recorder.check(
      `${key}.exists`,
      false,
      `Artifact cannot be read: ${error.code ?? error.message}.`,
      {
        artifactId
      }
    );
    return result;
  }
  recorder.check(`${key}.exists`, true, "Artifact exists.", { artifactId });
  const symlinkSafe = insideDirectory(workspaceReal, fileReal);
  recorder.check(
    `${key}.real-workspace-boundary`,
    symlinkSafe,
    symlinkSafe
      ? "Resolved artifact remains inside the workspace."
      : "Artifact resolves outside the workspace.",
    { artifactId }
  );
  const regularFile = fileStats.isFile();
  recorder.check(
    `${key}.regular-file`,
    regularFile,
    regularFile
      ? "Artifact is a regular file."
      : "Artifact is not a regular file.",
    {
      artifactId
    }
  );
  if (!symlinkSafe || !regularFile) return result;

  const minimumBytes =
    contract.checks?.minimumBytesByKind?.[artifact.kind] ??
    contract.checks?.minimumBytes ??
    1;
  const nonEmpty = contract.checks?.nonEmpty !== false;
  const sizeValid =
    (!nonEmpty || fileStats.size > 0) && fileStats.size >= minimumBytes;
  recorder.check(
    `${key}.size`,
    sizeValid,
    sizeValid
      ? `Artifact contains ${fileStats.size} bytes.`
      : `Artifact must contain at least ${minimumBytes} bytes.`,
    { artifactId }
  );

  let buffer;
  try {
    buffer = await readFile(candidate);
  } catch (error) {
    recorder.check(
      `${key}.read`,
      false,
      `Artifact read failed: ${error.code ?? error.message}.`,
      {
        artifactId
      }
    );
    return result;
  }
  result.bytes = fileStats.size;
  result.sha256 = fileDigest(buffer);
  result.extension = extension;
  result.realPath = fileReal;
  Object.defineProperty(result, "buffer", {
    value: buffer,
    enumerable: false
  });

  if (MEDIA_EXTENSIONS.has(extension)) {
    result.mediaType = detectMediaType(buffer);
    const expectedMediaTypes = MEDIA_TYPES_BY_EXTENSION[extension];
    const signatureMatchesExtension = Boolean(
      result.mediaType && expectedMediaTypes?.has(result.mediaType)
    );
    recorder.check(
      `${key}.media-signature`,
      signatureMatchesExtension,
      signatureMatchesExtension
        ? `Artifact signature ${result.mediaType} matches ${extension}.`
        : result.mediaType
          ? `Artifact extension ${extension} does not match detected type ${result.mediaType}.`
          : `Artifact does not have a valid ${extension} media signature.`,
      { artifactId }
    );
  }

  const dimensionRules = contract.checks?.dimensions ?? {};
  const requiredForDimensions = new Set(dimensionRules.requiredFor ?? []);
  const shouldInspect =
    forceDimensions ||
    dimensionRules.enabled ||
    requiredForDimensions.has(artifact.kind);
  if (shouldInspect && MEDIA_EXTENSIONS.has(extension)) {
    result.dimensions =
      inspectBufferDimensions(buffer, extension) ??
      inspectWithAvailableTool(candidate, extension, toolRunner);
    const dimensionsRequired = requiredForDimensions.has(artifact.kind);
    recorder.check(
      `${key}.dimensions`,
      Boolean(result.dimensions) || !dimensionsRequired,
      result.dimensions
        ? `Dimensions were inspected with ${result.dimensions.source}.`
        : dimensionsRequired
          ? "Required dimensions could not be inspected."
          : "Dimensions were unavailable but are optional for this artifact.",
      { artifactId, severity: dimensionsRequired ? "error" : "warning" }
    );

    const minimum = dimensionRules.minimumByKind?.[artifact.kind];
    if (minimum && result.dimensions?.unit === "pixels") {
      const widthValid = result.dimensions.width >= minimum.width;
      const heightValid = result.dimensions.height >= minimum.height;
      recorder.check(
        `${key}.minimum-dimensions`,
        widthValid && heightValid,
        widthValid && heightValid
          ? `Raster dimensions meet the ${minimum.width}x${minimum.height} minimum.`
          : `Raster dimensions must be at least ${minimum.width}x${minimum.height}; found ${result.dimensions.width}x${result.dimensions.height}.`,
        { artifactId }
      );
    } else if (minimum && result.dimensions?.unit === "points") {
      recorder.check(
        `${key}.minimum-dimensions`,
        true,
        "Raster pixel minimum does not apply to PDF dimensions measured in points.",
        { artifactId }
      );
    }
  }

  if (MEDIA_EXTENSIONS.has(extension) && result.mediaType) {
    const visual = inspectVisualSemantics({
      filePath: candidate,
      extension,
      kind: artifact.kind,
      dimensions: result.dimensions,
      rules: contract.checks?.visualInspection,
      runner: toolRunner
    });
    result.semanticMetrics = visual.metrics;
    for (const check of visual.checks) {
      recorder.check(`${key}.${check.id}`, check.passed, check.message, {
        artifactId,
        severity: check.severity
      });
    }
  }

  const artifactChecks = recorder.checks.slice(startCheckIndex);
  result.passed = artifactChecks.every(
    (check) => check.passed || check.severity === "warning"
  );
  return result;
}
