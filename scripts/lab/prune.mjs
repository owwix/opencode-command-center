import { execFileSync } from "node:child_process";
import { isLegacyLabVolume } from "./launch-snapshot.mjs";

function docker(args, { env = process.env } = {}) {
  return execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function legacyVolumes(volumeNames) {
  return [...new Set(volumeNames.filter(isLegacyLabVolume))].sort();
}

export function prunePlan({ volumeNames, apply = false } = {}) {
  const volumes = legacyVolumes(volumeNames ?? []);
  return {
    volumes,
    apply,
    message: volumes.length
      ? apply
        ? `Deleting ${volumes.length} explicitly selected legacy Lab volume(s).`
        : `No volumes deleted. Re-run with \`occtl prune --apply\` to delete exactly these legacy Lab volumes.`
      : "No recognized legacy Lab volumes found. Unrelated Docker volumes are intentionally ignored."
  };
}

export function runPrune({
  apply = false,
  runDocker = docker,
  env = process.env
} = {}) {
  const names = runDocker(["volume", "ls", "--format", "{{.Name}}"], { env })
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
  const plan = prunePlan({ volumeNames: names, apply });
  if (!apply || plan.volumes.length === 0) return plan;

  // Re-list immediately before deletion. This prevents a stale dry-run list
  // from widening the target set, and each exact name still passes the
  // conservative legacy-harness predicate.
  const current = new Set(
    runDocker(["volume", "ls", "--format", "{{.Name}}"], { env })
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const targets = plan.volumes.filter(
    (name) => current.has(name) && isLegacyLabVolume(name)
  );
  if (targets.length) runDocker(["volume", "rm", "--", ...targets], { env });
  return { ...plan, volumes: targets };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--help", "-h"].includes(arg))) {
    throw new Error("Usage: occtl prune [--apply]");
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: occtl prune [--apply]\n\nReports recognized legacy Lab volumes. It deletes nothing unless --apply is supplied."
    );
    return;
  }
  const plan = runPrune({ apply: args.includes("--apply") });
  for (const volume of plan.volumes) console.log(`- ${volume}`);
  console.log(plan.message);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
