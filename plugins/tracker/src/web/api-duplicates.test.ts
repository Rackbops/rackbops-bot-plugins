import { afterEach, describe, expect, it } from "bun:test";
import { api, cleanup, LARRY, makeToken, people, signIn, world } from "./harness.js";

/** #390: the task API refuses a create that repeats a live task unless it says `allowDuplicate`. */

afterEach(cleanup);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, token };
}

type Refused = { error: { code: string; message: string }; duplicates: { id: string; title: string; status: string; type: string }[] };

const WATCH = { type: "wantlist", name: "Wingspan", source: "ebay" };

describe("duplicate tasks over the task API", () => {
  it("refuses the same watch again with 409 naming the one it repeats, and makes it with allowDuplicate", async () => {
    const w = await setup();
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH })).status).toBe(201);
    const again = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { ...WATCH, name: "  WINGSPAN " } });
    expect(again.status).toBe(409);
    const body = (await again.json()) as Refused;
    expect(body.error.code).toBe("duplicate");
    expect(body.error.message).toContain('t1 "Wingspan" (wantlist, active)');
    expect(body.duplicates).toEqual([{ id: "t1", title: "Wingspan", status: "active", type: "wantlist" }]);
    // Nothing was made: the list still holds one task.
    const list = (await (await api(w.plugin, "GET", "/tasks", { token: w.token })).json()) as { tasks: unknown[] };
    expect(list.tasks).toHaveLength(1);
    const made = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { ...WATCH, allowDuplicate: true } });
    expect(made.status).toBe(201);
  });

  it("makes a watch on another source, and the same watch again once the first is deleted", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH });
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: { ...WATCH, source: "bgg" } })).status).toBe(201);
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token })).status).toBe(200);
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH })).status).toBe(201);
  });

  it("refuses a paused one too", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH });
    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {} })).status).toBe(200);
    const again = await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Refused).duplicates[0]).toMatchObject({ id: "t1", status: "paused" });
  });

  it("validate lists the duplicates without refusing, and an empty list otherwise", async () => {
    const w = await setup();
    const first = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: WATCH });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { duplicates: unknown[] }).duplicates).toEqual([]);
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: WATCH });
    const res = await api(w.plugin, "POST", "/tasks/validate", { token: w.token, body: { ...WATCH, allowDuplicate: true } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; duplicates: { id: string }[]; message: string };
    expect(body.valid).toBe(true);
    expect(body.duplicates.map((d) => d.id)).toEqual(["t1"]);
    expect(body.message).toContain("allowDuplicate: true");
  });

  it("refuses an allowDuplicate that is not true or false", async () => {
    const w = await setup();
    for (const path of ["/tasks", "/tasks/validate"]) {
      const res = await api(w.plugin, "POST", path, { token: w.token, body: { ...WATCH, allowDuplicate: "yes" } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Refused).error).toEqual({ code: "invalid", message: "`allowDuplicate` must be true or false." });
    }
  });
});
