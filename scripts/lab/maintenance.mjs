import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync
} from "node:fs";
import { join } from "node:path";
import { assertNoMaintenance } from "./state-volumes.mjs";

export function withMaintenance(paths, operation) {
  mkdirSync(paths.updatesRoot, { recursive: true });
  const path = join(paths.updatesRoot, "maintenance.lock");
  assertNoMaintenance(paths.updatesRoot);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another update/rollback owns the maintenance lock. Do not remove it while that process is active."
      );
    throw error;
  }
  try {
    writeFileSync(fd, String(process.pid));
    const registryPath = join(paths.stateRoot, "host-registry.json");
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      const sessions = [
        registry.foreground,
        ...Object.values(registry.projects ?? {}).flatMap((project) =>
          Object.values(project.sessions ?? {})
        )
      ].filter(Boolean);
      for (const session of sessions) {
        if (!Number.isInteger(session.pid) || session.pid < 2) continue;
        let alive = true;
        try {
          process.kill(session.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
          else throw error;
        }
        if (alive)
          throw new Error(
            `Stop the active Lab session (PID ${session.pid}) before update/rollback.`
          );
      }
    }
    const runsRoot = join(paths.stateRoot, "runs");
    if (existsSync(runsRoot))
      for (const name of readdirSync(runsRoot)) {
        const runPath = join(runsRoot, name, "run.json");
        if (!existsSync(runPath)) continue;
        const run = JSON.parse(readFileSync(runPath, "utf8"));
        const pid = run.worker?.pid;
        if (
          run.worker?.status !== "running" ||
          !Number.isInteger(pid) ||
          pid < 2
        )
          continue;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") continue;
          throw error;
        }
        throw new Error(`Stop managed run ${name} before update/rollback.`);
      }
    return operation();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
