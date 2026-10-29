import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { api, cleanup, LARRY, makeToken, people, signIn, world } from "./harness.js";

/** `POST /tasks/validate` (rackbops-bot-plugins#369): the create's checks, and nothing written. */

afterEach(cleanup);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, token };
}

/** Every row a create or a run would add: tasks, their runs, their events. */
function rows(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return ["tasks", "occurrences", "events"].map((t) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

type Checked = { valid: boolean; checked: string; firstAt: string | null; thenAt: string | null; timeZone: string; cadence: string; message: string };

describe("POST /tasks/validate", () => {
  it("gives a daily reminder's first two runs in the owner's zone across the end of daylight time, and writes nothing", async () => {
    const w = await setup();
    const before = rows(w.dbPath);
    const res = await api(w.plugin, "POST", "/tasks/validate", {
      token: w.token,
      body: { type: "reminder", text: "water the plants", when: "2026-10-31 09:00", repeat: "day" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Checked;
    expect(body).toMatchObject({ valid: true, checked: "full", timeZone: "America/New_York" });
    // 9:00 in New York: 13:00 UTC under EDT on Oct 31, 14:00 UTC under EST on Nov 1.
    expect(body.firstAt).toBe("2026-10-31T13:00:00.000Z");
    expect(body.thenAt).toBe("2026-11-01T14:00:00.000Z");
    expect(body.message).toContain("Nothing was made.");
    expect(rows(w.dbPath)).toEqual(before);
    // The create from the same body runs first at the instant validate said.
    const made = await api(w.plugin, "POST", "/tasks", {
      token: w.token,
      body: { type: "reminder", text: "water the plants", when: "2026-10-31 09:00", repeat: "day" },
    });
    expect(((await made.json()) as { task: { nextAt: string } }).task.nextAt).toBe(body.firstAt as string);
  });

  it("gives a one-off reminder one run and no second", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: { type: "reminder", text: "call mum", when: "2026-10-02 09:00" } });
    expect(await res.json()).toMatchObject({ checked: "full", firstAt: "2026-10-02T13:00:00.000Z", thenAt: null });
  });

  it("refuses what the create refuses, in the create's words, and takes no If-Match", async () => {
    const w = await setup();
    const answer = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body, headers });
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    };
    expect(await answer({ type: "reminder", text: "" })).toEqual([400, "invalid"]);
    expect(await answer({ type: "reminder", text: "x", when: "not a time at all" })).toEqual([400, "invalid"]);
    expect(await answer({ type: "reminder", text: "x", colour: "red" })).toEqual([400, "unknown_field"]);
    expect(await answer({ type: "nope" })).toEqual([400, "invalid"]);
    expect(await answer({ type: "research", question: "why?" })).toEqual([503, "unavailable"]);
    expect(await answer({ type: "reminder", text: "x" }, { "if-match": '"0123456789abcdef"' })).toEqual([400, "if_match_unsupported"]);
  });

  it("checks a price only as far as its fields go, and reads no page", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: { type: "price", url: "https://shop.example/x" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, checked: "fields" });
  });

  it("gives a renewal already within its lead an ask at once", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/tasks/validate", {
      token: w.token,
      body: { type: "renewal", name: "domain", amount: 12, currency: "USD", renews: "2026-10-03" },
    });
    const body = (await res.json()) as Checked;
    expect(res.status).toBe(200);
    expect(body.firstAt).toBe("2026-10-01T12:00:00.000Z");
    expect(body.thenAt).not.toBeNull();
  });
});
