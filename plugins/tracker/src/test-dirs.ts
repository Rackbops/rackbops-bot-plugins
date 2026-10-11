import { rmSync } from "node:fs";

/**
 * Removes a test's temp directory (rackbops-bot-plugins#232). Test-only: imported by the tracker's
 * test files and web/harness.ts, never by index.ts, so the bundle never carries it.
 *
 * Windows refuses to delete a file that is still open -- the SQLite database, its `-wal` and its
 * `-shm` -- where Linux does not care, so a test closes what it opened (a plugin's `dispose()`, a
 * `Database`'s `close()`) before removing its directory. This is only the backstop: a directory
 * still busy is tried again, `RETRIES` more times `RETRY_MS` apart (bun 1.4.2's `rmSync` ignores its
 * own `maxRetries`). One busy after the last try is left behind with a warning naming it and the
 * code, never a failure: a passing test stays green, and the line points at a handle someone forgot
 * to close. Any other error is thrown.
 */

/** The codes a Windows file still open answers with. */
const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
export const RETRIES = 5;
export const RETRY_MS = 100;

export type Rm = (dir: string, options: { recursive: boolean; force: boolean }) => void;

export function removeDir(dir: string, opts: { rm?: Rm } = {}): void {
  const rm = opts.rm ?? rmSync;
  for (let attempt = 0; ; attempt++) {
    try {
      rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !BUSY.has(code)) throw err;
      if (attempt === RETRIES) {
        console.warn(`removeDir: left ${dir} behind (${code} after ${RETRIES + 1} tries): close what the test opened in it first`);
        return;
      }
      Bun.sleepSync(RETRY_MS);
    }
  }
}
