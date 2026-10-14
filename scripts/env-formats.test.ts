// Every plugin's env[].format is judged by the bot's `ops/bot-ops.sh env-set` as a POSIX ERE in
// bash's `[[ =~ ]]` under LC_ALL=C (rackbops-discord-bot `format_matches`), and pre-checked by the
// admin panel as a JS RegExp. The root README's rule is the common subset of the two: spell the
// characters out. A backslash before an ordinary character (`\S`, `\d`, `\w`, `\s`, `\b`, ...) is
// undefined in POSIX ERE -- glibc and musl read `\S` as non-space, a BSD/macOS regcomp reads it as a
// literal S -- so a format may only use a backslash to escape one of ERE's special characters (#202,
// decision 8). A secret is a printable-ASCII token with no spaces: `[!-~]` in both engines.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface EnvEntry {
  key: string;
  format: string;
  secret?: boolean;
}

const pluginsDir = join(import.meta.dir, "..", "plugins");
const entries: Array<EnvEntry & { plugin: string }> = readdirSync(pluginsDir)
  .filter((name) => existsSync(join(pluginsDir, name, "package.json")))
  .flatMap((plugin) => {
    const pkg = JSON.parse(readFileSync(join(pluginsDir, plugin, "package.json"), "utf8"));
    const env: EnvEntry[] = pkg.botPlugin?.env ?? [];
    return env.map((e) => ({ ...e, plugin }));
  });

// The characters an ERE gives a meaning to; `\` before any of them is a POSIX-defined literal.
const ERE_SPECIAL = new Set([..."^.[]$()|*+?{}\\"]);

function nonPosixEscapes(format: string): string[] {
  const bad: string[] = [];
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "\\") continue;
    const next = format[i + 1] ?? "";
    if (!ERE_SPECIAL.has(next)) bad.push(`\\${next}`);
    i++;
  }
  return bad;
}

const bash = Bun.which("bash");

// env-set's own check: LC_ALL=C, then [[ value =~ format ]]. Exit 0 = match, 1 = no match, 2 = the
// pattern does not compile.
function bashMatch(value: string, format: string): number {
  const proc = Bun.spawnSync([bash!, "-c", 'LC_ALL=C; [[ "$1" =~ $2 ]]', "_", value, format]);
  return proc.exitCode;
}

const token = "aB3-_.~+/=:Zx9" + "Qw7".repeat(20);
const refused = ["has a space " + token, "has\ta tab" + token, token + " ", "café" + token];

describe("plugin env formats", () => {
  test("the scan found the plugins", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.secret)).toBe(true);
  });

  test("use no backslash escape outside POSIX ERE (spell the characters out)", () => {
    const offenders = entries
      .map((e) => ({ at: `${e.plugin} ${e.key}`, escapes: nonPosixEscapes(e.format) }))
      .filter((o) => o.escapes.length > 0);
    expect(offenders).toEqual([]);
  });

  test("compile as a JS RegExp (the admin panel's pre-check)", () => {
    for (const e of entries) expect(() => new RegExp(e.format)).not.toThrow();
  });

  test("a secret takes a printable-ASCII token and refuses whitespace and non-ASCII", () => {
    for (const e of entries.filter((x) => x.secret)) {
      const re = new RegExp(e.format);
      expect({ key: e.key, ok: re.test(token) }).toEqual({ key: e.key, ok: true });
      for (const v of refused) expect({ key: e.key, v, ok: re.test(v) }).toEqual({ key: e.key, v, ok: false });
    }
  });

  test.skipIf(!bash)("env-set's bash [[ =~ ]] in the C locale compiles every format", () => {
    for (const e of entries) {
      expect({ key: e.key, status: bashMatch("", e.format) === 2 ? "bad" : "ok" }).toEqual({ key: e.key, status: "ok" });
    }
  });

  test.skipIf(!bash)("env-set's bash [[ =~ ]] in the C locale agrees on every secret", () => {
    for (const e of entries.filter((x) => x.secret)) {
      expect({ key: e.key, status: bashMatch(token, e.format) }).toEqual({ key: e.key, status: 0 });
      for (const v of refused) expect({ key: e.key, v, status: bashMatch(v, e.format) }).toEqual({ key: e.key, v, status: 1 });
    }
  });
});
