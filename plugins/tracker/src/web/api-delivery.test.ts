import { afterEach, describe, expect, it } from "bun:test";
import type { Delivery, Occurrence, User } from "@rackbops/docket-core";
import type { Plugin } from "../../../../packages/api/contract.js";
import { deliveryView, type RunDelivery } from "../history.js";
import { api, cleanup, LARRY, makeToken, people, signIn, slash, world } from "./harness.js";

/** Delivery state per run in `GET /tasks/<id>`'s history (rackbops-bot-plugins#369). */

afterEach(cleanup);

const tick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, token };
}

async function runs(w: Awaited<ReturnType<typeof setup>>, id: string): Promise<{ status: string; delivery: RunDelivery }[]> {
  const res = await api(w.plugin, "GET", `/tasks/${id}`, { token: w.token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { history: { runs: { status: string; delivery: RunDelivery }[] } }).history.runs;
}

describe("GET /tasks/<id> delivery state", () => {
  it("says a reminder that reached its owner was delivered, and one that could not reach them failed, with why", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day", when: "9am" } });
    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    w.delivery.unreachable.add(LARRY);
    w.clock.set("2026-10-02T13:00:00.000Z");
    await tick(w.plugin);
    const [first, second] = await runs(w, "t1");
    expect(first?.delivery).toEqual({ state: "delivered", reason: null, sends: [{ to: "Larry", status: "sent", error: null }] });
    expect(second?.delivery).toMatchObject({ state: "failed", reason: "recipient cannot be messaged" });
    expect(second?.delivery.sends).toEqual([{ to: "Larry", status: "failed", error: "recipient cannot be messaged" }]);
  });
});

describe("deliveryView", () => {
  const owner = { id: "u1", displayName: "Larry", timeZone: "UTC" } as unknown as User;
  const curly = { id: "u2", displayName: "Curly", timeZone: "UTC" } as unknown as User;
  const names = new Map([
    [owner.id, owner],
    [curly.id, curly],
  ]);
  const run = (over: Partial<Occurrence> = {}) => ({ id: "o1", status: "done", record: { at: "x" }, ...over }) as unknown as Occurrence;
  const row = (userId: string, status: Delivery["status"], over: Partial<Delivery> = {}) =>
    ({ occurrenceId: "o1", userId, status, error: null, retryAt: null, attempts: 0, deferrals: 0, messageId: null, createdAt: "", claimedAt: null, settledAt: null, ...over }) as Delivery;

  it("tells a run with nothing to send from one not run yet", () => {
    expect(deliveryView(run(), [], names, owner, true).state).toBe("nothing_to_send");
    expect(deliveryView(run({ status: "queued", record: null }), [], names, owner, true).state).toBe("not_run");
  });

  it("ranks a final failure over an unconfirmed send over one still owed, and a retried failure is still sending", () => {
    const failed = row("u2", "failed", { error: "recipient cannot be messaged" });
    const unsure = row("u1", "unconfirmed", { error: "timed out" });
    const retry = row("u1", "failed", { error: "flaky", retryAt: "2026-10-01T00:00:00Z" });
    expect(deliveryView(run(), [unsure, failed], names, owner, true)).toMatchObject({ state: "failed", reason: "recipient cannot be messaged" });
    expect(deliveryView(run(), [retry, unsure], names, owner, true)).toMatchObject({ state: "unconfirmed", reason: "timed out" });
    expect(deliveryView(run(), [row("u2", "sent"), retry], names, owner, true)).toMatchObject({ state: "sending", reason: null });
    expect(deliveryView(run(), [row("u2", "sent"), row("u1", "claimed")], names, owner, true).state).toBe("sending");
  });

  it("shows a recipient only their own copy, never another's failure (#273)", () => {
    const rows = [row("u1", "failed", { error: "recipient u1 cannot be messaged" }), row("u2", "sent")];
    expect(deliveryView(run(), rows, names, curly, false)).toEqual({ state: "delivered", reason: null, sends: [{ to: "Curly", status: "sent", error: null }] });
    expect(deliveryView(run(), rows, names, owner, true).state).toBe("failed");
  });
});
