import { execFileSync } from "node:child_process";
import {
  readHostRegistry,
  finishManagedRecovery
} from "./workspace-registry.mjs";
import { processIsAlive } from "../quality/run-control.mjs";

/** Stop orphan containers only when both their host owner is dead and their
 * exact Compose label matches the attempt recorded in the host registry. */
export function reconcileManagedContainers({
  registryPath,
  env = process.env,
  alive = processIsAlive,
  run = (args) =>
    execFileSync("docker", args, {
      env,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
}) {
  const registry = readHostRegistry(registryPath);
  const cleaned = [];
  for (const project of Object.values(registry.projects ?? {})) {
    for (const session of Object.values(project.sessions ?? {})) {
      const name = session.resources?.composeProject;
      if (
        !session.background ||
        alive(session.pid) ||
        !/^opencode-lab-run-[a-f0-9]{24}$/u.test(name ?? "")
      )
        continue;
      const ids = run([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${name}`
      ])
        .split(/\r?\n/u)
        .filter(Boolean);
      for (const id of ids) {
        if (!/^[a-f0-9]{12,64}$/u.test(id))
          throw new Error("Docker returned an invalid container identity.");
        const label = run([
          "inspect",
          "--format",
          '{{index .Config.Labels "com.docker.compose.project"}}',
          id
        ]);
        if (label !== name)
          throw new Error("Refusing orphan cleanup after ownership changed.");
        run(["rm", "-f", id]);
        cleaned.push({ composeProject: name, container: id });
      }
      finishManagedRecovery(registryPath, session.launchId);
    }
  }
  return cleaned;
}
