import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export function objectDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function fileDigest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function insideDirectory(root, target) {
  const child = relative(root, target);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export function assertContract(contract) {
  const errors = [];
  if (!isObject(contract)) errors.push("contract must be a JSON object");
  if (typeof contract?.id !== "string" || !contract.id.trim()) {
    errors.push("contract.id must be a non-empty string");
  }
  if (!Array.isArray(contract?.requiredEvidence)) {
    errors.push("contract.requiredEvidence must be an array");
  } else {
    for (const [index, requirement] of contract.requiredEvidence.entries()) {
      if (!isObject(requirement) || typeof requirement.kind !== "string") {
        errors.push(
          `contract.requiredEvidence[${index}].kind must be a string`
        );
      }
      if (
        !Number.isInteger(requirement?.minCount) ||
        requirement.minCount < 1
      ) {
        errors.push(
          `contract.requiredEvidence[${index}].minCount must be a positive integer`
        );
      }
    }
  }
  if (!isObject(contract?.checks))
    errors.push("contract.checks must be an object");
  if (
    !Array.isArray(contract?.completionCriteria) ||
    !contract.completionCriteria.length
  ) {
    errors.push("contract.completionCriteria must be a non-empty array");
  }
  if (errors.length)
    throw new Error(`Invalid quality contract: ${errors.join("; ")}`);
  return contract;
}

export function makeRecorder() {
  const checks = [];
  return {
    checks,
    check(id, passed, message, { artifactId, severity = "error" } = {}) {
      checks.push({
        id,
        passed: Boolean(passed),
        severity,
        ...(artifactId ? { artifactId } : {}),
        message
      });
      return Boolean(passed);
    }
  };
}

export function duplicates(values) {
  return [
    ...new Set(values.filter((value, index) => values.indexOf(value) !== index))
  ];
}

export function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  if (
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length
  ) {
    return false;
  }
  const expected = new Set(right);
  return left.every(
    (value) => typeof value === "string" && expected.has(value)
  );
}
