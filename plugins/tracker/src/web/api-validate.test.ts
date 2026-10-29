import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { User } from "@rackbops/docket-core";
import type { TrackerDeps } from "../actions.js";
import { RESEARCH_OFF } from "../research.js";
import { SCOUT_OFF } from "../scout.js";
import { api, cleanup, LARRY, makeToken, people, signIn, world } from "./harness.js";
import { validateAnswer } from "./api-validate.js";

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
    const before = rows(w.dbPath);
    const answer = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body, headers });
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      return [res.status, error.code, error.message];
    };
    const made = async (body: unknown) => {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body });
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      return [res.status, error.code, error.message];
    };
    for (const body of [
      { type: "reminder", text: "" },
      { type: "reminder", text: "x", when: "not a time at all" },
      { type: "reminder", text: "x", colour: "red" },
      { type: "nope" },
      { type: "research", question: "why?" },
      { type: "scout", interests: "board games" },
    ]) {
      expect(await answer(body)).toEqual(await made(body));
    }
    expect((await answer({ type: "research", question: "why?" }))[2]).toBe(RESEARCH_OFF);
    expect((await answer({ type: "scout", interests: "board games" }))[2]).toBe(SCOUT_OFF);
    expect((await answer({ type: "reminder", text: "x" }, { "if-match": '"0123456789abcdef"' })).slice(0, 2)).toEqual([400, "if_match_unsupported"]);
    expect(rows(w.dbPath)).toEqual(before);
  });

  it("refuses a type this bot does not offer, as its create does", async () => {
    const user = { id: "u1", timeZone: "UTC", preferredHour: 9 } as unknown as User;
    const d = { types: {}, research: null, clock: { now: () => new Date("2026-10-01T12:00:00Z") } } as unknown as TrackerDeps;
    for (const [type, message] of [
      ["reminder", "Reminders are not available on this bot."],
      ["renewal", "Renewals are not available on this bot."],
    ] as const) {
      expect(await validateAnswer(d, user, { type })).toMatchObject({ status: 503, body: { error: { code: "unavailable", message } } });
    }
  });

  it("checks only a price's fields and the live-task cap, and writes nothing", async () => {
    const w = await setup();
    const before = rows(w.dbPath);
    const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: { type: "price", url: "https://shop.example/x" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Checked;
    expect(body).toMatchObject({ valid: true, checked: "fields" });
    expect(body.message).toContain("Nothing was made.");
    expect(rows(w.dbPath)).toEqual(before);
  });

  it("gives a renewal already within its lead an ask at once, at the instant its create stores, and writes nothing", async () => {
    const w = await setup();
    const renewal = { type: "renewal", name: "domain", amount: 12, currency: "USD", renews: "2026-10-03" };
    const before = rows(w.dbPath);
    const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: renewal });
    const body = (await res.json()) as Checked;
    expect(res.status).toBe(200);
    expect(rows(w.dbPath)).toEqual(before);
    // Already due: in the past, and the message says at once.
    expect(Date.parse(body.firstAt as string)).toBeLessThan(Date.parse("2026-10-01T12:00:00.000Z"));
    expect(body.message).toContain("would first run at once");
    expect(Date.parse(body.thenAt as string)).toBeGreaterThan(Date.parse("2026-10-01T12:00:00.000Z"));
    const made = await api(w.plugin, "POST", "/tasks", { token: w.token, body: renewal });
    expect(((await made.json()) as { task: { nextAt: string } }).task.nextAt).toBe(body.firstAt as string);
  });
});
