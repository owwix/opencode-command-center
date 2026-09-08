/**
 * Recovery, migration, archival, and cleanup operations for durable runs.
 * Core record persistence and attempt tracking live in run-service-core.mjs.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  controllerPath,
  createDurableRun,
  listDurableRuns,
  nowIso,
  phaseForState,
  readDurableRun,
  readJson,
  readLegacyJson,
  syncControllerRun,
  updateDurableRun
} from "./run-service-core.mjs";

export * from "./run-service-core.mjs";

function terminalStateFromLegacy(record) {
  if (record.state) return record.state;
  if (typeof record.exitCode === "number")
    return record.exitCode === 0 ? "completed" : "failed";
  return record.finishedAt ? "completed" : "running";
}

function fleetStateFromLegacy(record) {
  const jobs = record.jobs ?? [];
  if (!jobs.length) return record.finishedAt ? "passed" : "queued";
  const failed = jobs.some(
    (job) =>
      ["failed", "cancelled", "abandoned"].includes(job.state) ||
      (typeof job.exitCode === "number" && job.exitCode !== 0)
  );
  if (record.finishedAt) return failed ? "failed" : "passed";
  return jobs.some((job) => job.state === "running") ? "running" : "queued";
}

export function migrateLegacyRunState({ root }) {
  const stateRoot = resolve(root);
  const migrated = [];
  const backgroundRoot = join(stateRoot, "background");
  if (existsSync(backgroundRoot)) {
    for (const name of readdirSync(backgroundRoot).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const sourcePath = join(backgroundRoot, name);
      const legacy = readLegacyJson(sourcePath);
      if (!legacy?.id) continue;
      const id = legacy.runId ?? `background_${legacy.id}`;
      const current = readDurableRun({ root: stateRoot, runId: id });
      if (
        current?.kind === "background" &&
        current.payload?.migratedFrom === sourcePath
      ) {
        migrated.push({ kind: "background", id, sourcePath });
        continue;
      }
      if (!current) {
        createDurableRun({
          root: stateRoot,
          id,
          kind: "background",
          state: terminalStateFromLegacy(legacy),
          task: legacy.prompt ?? "Migrated background task",
          agent: legacy.agent ?? null,
          source: legacy.workspace ?? null,
          controllerRunId: legacy.runId ?? null,
          payload: { background: legacy, migratedFrom: sourcePath },
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt ?? legacy.finishedAt
        });
      } else {
        updateDurableRun({
          root: stateRoot,
          runId: id,
          update(record) {
            record.kind = "background";
            record.payload = {
              ...record.payload,
              background: {
                ...(record.payload?.background ?? {}),
                ...legacy
              },
              migratedFrom: record.payload?.migratedFrom ?? sourcePath
            };
            return record;
          }
        });
      }
      migrated.push({ kind: "background", id, sourcePath });
    }
  }
  const fleetRoot = join(stateRoot, "fleet");
  if (existsSync(fleetRoot)) {
    for (const name of readdirSync(fleetRoot).filter((entry) =>
      entry.endsWith(".json")
    )) {
      const sourcePath = join(fleetRoot, name);
      const legacy = readLegacyJson(sourcePath);
      const id = legacy?.id ?? name.slice(0, -5);
      if (!legacy || !id) continue;
      const current = readDurableRun({ root: stateRoot, runId: id });
      const memberIds = (legacy.jobs ?? [])
        .map((job) => job.runId)
        .filter(Boolean);
      if (
        current?.kind === "fleet" &&
        current.payload?.migratedFrom === sourcePath
      ) {
        migrated.push({ kind: "fleet", id, sourcePath });
        continue;
      }
      if (!current) {
        createDurableRun({
          root: stateRoot,
          id,
          kind: "fleet",
          state: fleetStateFromLegacy(legacy),
          task: `Migrated fleet with ${(legacy.jobs ?? []).length} jobs`,
          source: legacy.workspace ?? null,
          controllerRunId: null,
          memberIds,
          payload: { fleet: legacy, migratedFrom: sourcePath },
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt ?? legacy.finishedAt
        });
      } else {
        updateDurableRun({
          root: stateRoot,
          runId: id,
          update(record) {
            record.kind = "fleet";
            record.memberIds = [
              ...new Set([...record.memberIds, ...memberIds])
            ];
            record.payload = {
              ...record.payload,
              fleet: record.payload?.fleet ?? legacy,
              migratedFrom: record.payload?.migratedFrom ?? sourcePath
            };
            return record;
          }
        });
      }
      migrated.push({ kind: "fleet", id, sourcePath });
    }
  }
  return migrated;
}

export function reconcileDurableRuns({
  root,
  now = Date.now(),
  isAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
} = {}) {
  migrateLegacyRunState({ root });
  const rows = listDurableRuns({ root });
  return rows.map((existing) => {
    let record = existing;
    const controller = record.controllerRunId
      ? readJson(controllerPath(root, record.controllerRunId))
      : null;
    if (controller) record = syncControllerRun({ root, run: controller });
    const heartbeat = record.heartbeat;
    const expired =
      heartbeat?.leaseExpiresAt &&
      new Date(heartbeat.leaseExpiresAt).getTime() <= now;
    if (
      ACTIVE_STATES.has(record.state) &&
      heartbeat?.status === "running" &&
      expired &&
      !isAlive(heartbeat.workerPid)
    ) {
      return updateDurableRun({
        root,
        runId: record.id,
        update(current) {
          const attempt = [...current.attempts]
            .reverse()
            .find(
              (item) =>
                item.leaseId === heartbeat.leaseId && item.status === "running"
            );
          if (attempt) {
            attempt.status = "interrupted";
            attempt.finishedAt = nowIso(now);
            attempt.error =
              "Worker heartbeat expired during startup reconciliation.";
          } else {
            current.attempts.push({
              number: current.attempts.length + 1,
              leaseId: heartbeat.leaseId,
              workerPid: heartbeat.workerPid ?? null,
              operation: "recovered-worker",
              status: "interrupted",
              startedAt: heartbeat.heartbeatAt ?? null,
              heartbeatAt: heartbeat.heartbeatAt ?? null,
              leaseExpiresAt: heartbeat.leaseExpiresAt ?? null,
              finishedAt: nowIso(now),
              error: "Worker heartbeat expired during startup reconciliation."
            });
          }
          current.heartbeat = { ...heartbeat, status: "stale" };
          current.payload.reconciledLeases = [
            ...new Set([
              ...(current.payload.reconciledLeases ?? []),
              heartbeat.leaseId
            ])
          ];
          current.state =
            current.attempts.length < current.maxAttempts ? "queued" : "failed";
          current.phase = phaseForState(current.state);
          return current;
        }
      });
    }
    const background = record.payload?.background;
    const launchIsStale =
      background?.launchedAt &&
      now - new Date(background.launchedAt).getTime() > 30_000;
    if (
      record.kind === "background" &&
      ACTIVE_STATES.has(record.state) &&
      !heartbeat &&
      launchIsStale &&
      !background.reconciledAt &&
      !isAlive(background.pid)
    ) {
      return updateDurableRun({
        root,
        runId: record.id,
        update(current) {
          current.attempts.push({
            number: current.attempts.length + 1,
            leaseId: null,
            workerPid: background.pid ?? null,
            operation: "background-launch",
            status: "interrupted",
            startedAt: background.launchedAt,
            heartbeatAt: null,
            leaseExpiresAt: null,
            finishedAt: nowIso(now),
            error: "Detached worker exited before establishing a heartbeat."
          });
          current.payload.background.reconciledAt = nowIso(now);
          current.state =
            current.attempts.length < current.maxAttempts ? "queued" : "failed";
          current.phase = phaseForState(current.state);
          return current;
        }
      });
    }
    return record;
  });
}

export function hasUnpublishedChanges(record) {
  const git = record.git ?? {};
  const changed =
    Boolean(git.changedFiles?.length) ||
    Boolean(git.baseSha && git.headSha && git.baseSha !== git.headSha);
  if (!changed) return false;
  const publishedHead = record.externalActions?.preparePr?.receipt?.headSha;
  const adoptedHead = record.externalActions?.adopt?.receipt?.headSha;
  return ![publishedHead, adoptedHead].includes(git.headSha);
}

export function assertDurableCleanupSafe(record) {
  if (!TERMINAL_STATES.has(record.state)) {
    throw new Error("Only terminal durable runs can be cleaned up.");
  }
  if (record.git?.clean === false) {
    throw new Error(
      "Run has uncommitted changes; recovery worktree must be preserved."
    );
  }
  if (hasUnpublishedChanges(record)) {
    throw new Error(
      "Run has unpublished commits; adopt or prepare a PR before cleanup."
    );
  }
  return true;
}

export function archiveDurableRun({ root, runId }) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      if (!TERMINAL_STATES.has(record.state))
        throw new Error("Only terminal durable runs can be archived.");
      record.state = "archived";
      record.phase = "terminal";
      record.archivedAt = record.archivedAt ?? nowIso();
      return record;
    }
  });
}

export function markDurableRunCleaned({ root, runId }) {
  return updateDurableRun({
    root,
    runId,
    update(record) {
      assertDurableCleanupSafe(record);
      record.cleanedAt = record.cleanedAt ?? nowIso();
      return record;
    }
  });
}
