import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir, type Rm } from "./test-dirs.js";

/**
 * The tests' temp-directory remover (rackbops-bot-plugins#232): a busy directory -- Windows' answer
 * while a file in it is still open -- is tried again, 100 ms apart, one still busy after the last try
 * is a warning and not a failure, and any other error still fails. Linux never answers a remove with
 * EBUSY, so the busy answers come from an injected `rm`, and the waits go to an injected `sleep`.
 */

const DIR = "/no/such/tracker-busy";

/** What Node's own errors say for each code. */
const SAYS: Record<string, string> = {
  EBUSY: "resource busy or locked",
  EPERM: "operation not permitted",
  ENOTEMPTY: "directory not empty",
  EACCES: "permission denied",
};

function failing(code: string) {
  return Object.assign(new Error(`${code}: ${SAYS[code] ?? "failed"}, rm '${DIR}'`), { code });
}

/**
 * An `rm` that throws `code` its first `times` calls (every call when `times` is Infinity), then
 * succeeds; `sleep` notes each wait between tries instead of waiting.
 */
function rmThat(code: string, times: number) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const rm: Rm = (dir) => {
    calls.push(dir);
    if (calls.length <= times) throw failing(code);
  };
  return { rm, calls, sleeps, sleep: (ms: number) => void sleeps.push(ms) };
}

/** Runs `fn` with `console.warn` captured; answers what it warned. */
function warnings(fn: () => void): string[] {
  const said: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void said.push(args.map(String).join(" ")));
  try {
    fn();
  } finally {
    warn.mockRestore();
  }
  return said;
}

describe("removeDir", () => {
  it("removes a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-dirs-"));
    writeFileSync(join(dir, "tracker.sqlite"), "x");
    expect(warnings(() => removeDir(dir))).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  // Windows answers a file still open with any of these, depending on what holds it.
  for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
    it(`retries a busy directory and then removes it (${code})`, () => {
      const { rm, calls, sleeps, sleep } = rmThat(code, 2);
      expect(warnings(() => removeDir(DIR, { rm, sleep }))).toEqual([]);
      expect(calls).toEqual([DIR, DIR, DIR]);
      expect(sleeps).toEqual([100, 100]);
    });
  }

  it("gives up on a directory that stays busy with a warning, not a failure", () => {
    const { rm, calls, sleeps, sleep } = rmThat("EBUSY", Number.POSITIVE_INFINITY);
    const said = warnings(() => removeDir(DIR, { rm, sleep }));
    expect(calls).toHaveLength(6);
    expect(sleeps).toEqual([100, 100, 100, 100, 100]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(DIR);
    expect(said[0]).toContain("EBUSY");
  });

  it("throws any other error", () => {
    const { rm, calls, sleeps, sleep } = rmThat("EACCES", Number.POSITIVE_INFINITY);
    expect(warnings(() => expect(() => removeDir(DIR, { rm, sleep })).toThrow("EACCES: permission denied"))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
