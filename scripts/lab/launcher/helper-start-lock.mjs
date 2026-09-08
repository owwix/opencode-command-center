import { open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Serialize host helper startup without blocking the event loop. Never steal a live owner's lock. */
export async function withHelperStartLock(path, operation, timeoutMs = 15000) {
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(owner);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await readFile(path, "utf8").catch(() => "");
      const pid = Number(previous.split(":")[0]);
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if (
            probe.code === "ESRCH" &&
            (await readFile(path, "utf8").catch(() => "")) === previous
          ) {
            await unlink(path).catch((failure) => {
              if (failure.code !== "ENOENT") throw failure;
            });
            continue;
          }
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Helper startup is locked: ${path}. Retry after the active launcher finishes.`
        );
      await delay(100);
    }
  }
  try {
    return await operation();
  } finally {
    if ((await readFile(path, "utf8").catch(() => "")) === owner)
      await unlink(path);
  }
}
