import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { RUN_NOW_PER_DAY } from "../run-now.js";
import { api, cleanup, LARRY, makeToken, people, signIn, slash, world } from "./harness.js";

/** `POST /tasks/<id>/run` (rackbops-bot-plugins#369): one extra run now, off the schedule. */

afterEach(cleanup);

const tick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, token };
}

type Answer = { status: number; code?: string; message?: string; nextAt?: string | null };

async function run(w: Awaited<ReturnType<typeof setup>>, id: string, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await api(w.plugin, "POST", `/tasks/${id}/run`, { token: w.token, body: {}, headers });
  const body = (await res.json()) as { error?: { code: string; message: string }; message?: string; task?: { nextAt: string | null } };
  return { status: res.status, code: body.error?.code, message: body.error?.message ?? body.message, nextAt: body.task?.nextAt };
}

const pills = (w: Awaited<ReturnType<typeof setup>>) => slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day", when: "9am" } });
const remindersSent = (w: Awaited<ReturnType<typeof setup>>) => w.sent.filter((s) => String((s.message as { content?: unknown }).content ?? "").includes("pills")).length;
const nextOf = async (w: Awaited<ReturnType<typeof setup>>) =>
  ((await (await api(w.plugin, "GET", "/tasks/t1", { token: w.token })).json()) as { task: { nextAt: string | null } }).task.nextAt;

describe("POST /tasks/<id>/run", () => {
  it("sends a daily reminder once on the next tick, and leaves its next scheduled run where it was", async () => {
    const w = await setup();
    await pills(w);
    const scheduled = await nextOf(w);
    const before = remindersSent(w);
    const answer = await run(w, "t1");
    expect(answer).toMatchObject({ status: 202 });
    expect(answer.message).toContain("Running `t1` now");
    await tick(w.plugin);
    expect(remindersSent(w)).toBe(before + 1);
    await tick(w.plugin);
    expect(remindersSent(w)).toBe(before + 1);
    expect(await nextOf(w)).toBe(scheduled);
  });

  it("with the same Idempotency-Key twice, queues one run", async () => {
    const w = await setup();
    await pills(w);
    const before = remindersSent(w);
    const key = { "idempotency-key": "run-now-key-0001" };
    expect((await run(w, "t1", key)).status).toBe(202);
    expect((await run(w, "t1", key)).status).toBe(202);
    await tick(w.plugin);
    expect(remindersSent(w)).toBe(before + 1);
  });

  it("refuses what cannot run now, each in a stable code, and a second run while one is still due", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "once only", when: "tomorrow 9am" } });
    expect(await run(w, "t1")).toMatchObject({ status: 409, code: "cannot_run_now", message: "That task cannot run now: a one-off runs once, at its own time; change its time instead." });
    const renewal = { type: "renewal", name: "Domain", amount: 12, currency: "USD", renews: "2026-12-01" };
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: renewal })).status).toBe(201);
    expect(await run(w, "t2")).toMatchObject({ status: 409, code: "cannot_run_now", message: "That task cannot run now: a renewal asks about its own date, at its own time." });
    await pills(w);
    expect((await run(w, "t3")).status).toBe(202);
    expect(await run(w, "t3")).toMatchObject({ status: 409, code: "cannot_run_now" });
    expect((await api(w.plugin, "POST", "/tasks/t3/pause", { token: w.token, body: {} })).status).toBe(200);
    expect(await run(w, "t3")).toMatchObject({ status: 409, code: "conflict" });
    expect(await run(w, "t9")).toMatchObject({ status: 404, code: "not_found" });
    const res = await api(w.plugin, "POST", "/tasks/t3/run", { token: w.token, body: { now: true } });
    expect(res.status).toBe(400);
  });

  it(`allows ${RUN_NOW_PER_DAY} runs now a day per person, then refuses until a day has passed`, async () => {
    const w = await setup();
    await pills(w);
    for (let n = 0; n < RUN_NOW_PER_DAY; n++) {
      expect((await run(w, "t1")).status).toBe(202);
      await tick(w.plugin);
    }
    expect(await run(w, "t1")).toMatchObject({ status: 409, code: "limit_reached" });
    w.clock.set(new Date(w.clock.now().getTime() + 24 * 3_600_000 + 60_000).toISOString());
    await tick(w.plugin);
    expect((await run(w, "t1")).status).toBe(202);
  });
});
