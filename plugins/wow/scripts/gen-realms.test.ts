import { describe, expect, test } from "bun:test";

const script = new URL("./gen-realms.ts", import.meta.url).pathname;

/** Runs the script with only the given variables set, so a developer's own environment cannot satisfy it. */
async function run(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn([process.execPath, script], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, stderr };
}

describe("gen-realms.ts inputs", () => {
  test.each([
    ["neither variable", {}],
    ["only BNET_SECRETS", { BNET_SECRETS: "/nowhere/secrets.json" }],
    ["only BNET_CLIENT_DIR", { BNET_CLIENT_DIR: "/nowhere/client" }],
    ["blank values", { BNET_SECRETS: "  ", BNET_CLIENT_DIR: "" }],
  ])("%s: fails naming both variables, before reading anything", async (_name, env) => {
    const r = await run(env);
    expect(r.code).not.toBe(0); // mutation: restoring a default path makes this read a file or call the client
    expect(r.stderr).toContain("BNET_SECRETS");
    expect(r.stderr).toContain("BNET_CLIENT_DIR");
  });

  test("the script no longer names a developer drive layout or a secrets file", async () => {
    const text = await Bun.file(script).text();
    expect(text).not.toMatch(/[A-Z]:[\\/]repos/);
    expect(text).not.toContain("secrets.json");
  });
});
