import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir, type Rm } from "./test-dirs.js";

/**
 * The tests' temp-directory remover (rackbops-bot-plugins#232): a busy directory -- Windows' answer
 * while a file in it is still open -- is tried again, one still busy after the last try is a warning
 * and not a failure, and any other error still fails. Linux never answers a remove with EBUSY, so
 * the busy answers come from an injected `rm`.
 */

const DIR = "/no/such/tracker-busy";

function failing(code: string) {
  return Object.assign(new Error(`${code}: resource busy or locked, rm '${DIR}'`), { code });
}

/** An `rm` that throws `code` its first `times` calls (every call when `times` is Infinity), then succeeds. */
function rmThat(code: string, times: number) {
  const calls: string[] = [];
  const rm: Rm = (dir) => {
    calls.push(dir);
    if (calls.length <= times) throw failing(code);
  };
  return { rm, calls };
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

  it("retries a busy directory and then removes it", () => {
    const { rm, calls } = rmThat("EBUSY", 2);
    expect(warnings(() => removeDir(DIR, { rm }))).toEqual([]);
    expect(calls).toEqual([DIR, DIR, DIR]);
  });

  it("gives up on a directory that stays busy with a warning, not a failure", () => {
    const { rm, calls } = rmThat("EBUSY", Number.POSITIVE_INFINITY);
    const said = warnings(() => removeDir(DIR, { rm }));
    expect(calls).toHaveLength(6);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(DIR);
    expect(said[0]).toContain("EBUSY");
  });

  it("throws any other error", () => {
    const { rm, calls } = rmThat("EACCES", Number.POSITIVE_INFINITY);
    expect(warnings(() => expect(() => removeDir(DIR, { rm })).toThrow("EACCES"))).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
