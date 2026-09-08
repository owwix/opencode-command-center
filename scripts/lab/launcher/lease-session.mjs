import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createCapabilityLease } from "../../../docker/agent-gateway/capability-lease.mjs";

/** Host-only renewal. The project never receives the signing key or lease directory.
 * @param {{ root: string, claims: import('../../quality/runtime-contracts.js').CapabilityScope, key: string, active?: () => boolean, now?: () => number, report?: (message: string) => void, automatic?: boolean }} options */
export function createLeaseSession({
  root,
  claims,
  key,
  active = () => true,
  now = Date.now,
  report = console.warn,
  automatic = true
}) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "lease-"));
  chmodSync(directory, 0o755);
  const scope = Object.freeze(structuredClone(claims));
  Object.freeze(scope.routes);
  Object.freeze(scope.actions);
  const transportToken = randomBytes(32).toString("hex");
  let expiresAt = 0;
  let failures = 0;
  let stopped = false;
  function tick() {
    if (stopped || !active()) {
      stopped = true;
      return false;
    }
    if (now() < expiresAt - 5 * 60 * 1000) return false;
    try {
      const issuedAt = now();
      const lease = createCapabilityLease({
        ...scope,
        key,
        now: issuedAt,
        ttlSeconds: 1800
      });
      const temporary = join(directory, "next.json");
      writeFileSync(
        temporary,
        JSON.stringify({ lease, expiresAt: issuedAt + 1800000 }),
        { mode: 0o444 }
      );
      renameSync(temporary, join(directory, "lease.json"));
      expiresAt = issuedAt + 1800000;
      if (failures) report("Gateway lease renewed; connection recovered.");
      failures = 0;
      return true;
    } catch (error) {
      failures++;
      report(
        `Gateway lease renewal failed (${failures}/3); requests fail closed after expiry.`
      );
      if (failures >= 3) stopped = true;
      if (!expiresAt) throw error;
      return false;
    }
  }
  tick();
  const timer = automatic ? setInterval(tick, 30000) : null;
  timer?.unref();
  return {
    directory,
    transportToken,
    tick,
    status: () => ({ expiresAt, failures, stopped }),
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    }
  };
}
