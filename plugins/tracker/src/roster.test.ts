import { describe, expect, it } from "bun:test";
import { JobRecords } from "./executor.js";
import { admit } from "./people.js";
import { Roster } from "./roster.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * Forget-me's erasure of docket's tables: deliveries (docket's `deleteDeliveries`), charges, budget
 * notices and findings (0.5.0), and the city-hall Executor's Job records of their runs.
 */

const AT = "2026-10-01T12:00:00.000Z";

describe("forget-me and docket's delivery, usage, notice and finding rows, and the Executor's Job records", () => {
  it("erases every delivery row of theirs and every copy of their runs; charges and notices naming them; nobody else's", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db);
    const larry = await admit(store, "111111111111111111", new Date(AT));
    const curly = await admit(store, "222222222222222222", new Date(AT));
    const make = (ownerId: string, title: string) =>
      store.createTask({ ownerId, type: "reminder", title, config: { text: title }, schedule: null, lane: "notify", capabilities: ["notify"], at: AT });
    const his = await make(larry.id, "his");
    const theirs = await make(curly.id, "theirs");
    const hisRun = (await store.createOccurrence({ taskId: his.id, lane: "notify", dueAt: AT, dedupeKey: "a", at: AT }))?.id ?? "";
    const theirRun = (await store.createOccurrence({ taskId: theirs.id, lane: "notify", dueAt: AT, dedupeKey: "b", at: AT }))?.id ?? "";
    // His run went to him and to Curly; Curly's run went to Curly and to him.
    for (const [run, user] of [
      [hisRun, larry.id],
      [hisRun, curly.id],
      [theirRun, curly.id],
      [theirRun, larry.id],
    ] as const) {
      await store.planDelivery(run, user, AT);
    }
    await store.addUsage({ userId: larry.id, taskId: his.id, occurrenceId: hisRun, source: "run", calls: 1, costUsd: 0.1, at: AT });
    await store.addUsage({ userId: curly.id, taskId: theirs.id, occurrenceId: theirRun, source: "run", calls: 1, costUsd: 0.1, at: AT });
    await store.claimNotice(`budget:person:${larry.id}:2026-10-01`, AT);
    await store.claimNotice(`budget:person:${curly.id}:2026-10-01`, AT);
    await store.claimNotice("budget:global:2026-10-01", AT);

    // docket 0.5.0: a finding of each task, and each run's Job record at city-hall.
    await store.addFinding({ taskId: his.id, ownerId: larry.id, occurrenceId: hisRun, key: `${hisRun}:0`, type: "research", text: "his claim", at: AT });
    await store.addFinding({ taskId: theirs.id, ownerId: curly.id, occurrenceId: theirRun, key: `${theirRun}:0`, type: "research", text: "their claim", at: AT });
    const jobs = new JobRecords(db);
    jobs.put(hisRun, hisRun, "remote-his", AT);
    jobs.put(`${hisRun}:1`, hisRun, "remote-his-2", AT);
    jobs.put(theirRun, theirRun, "remote-theirs", AT);

    const erased = new Roster(db).erase(larry.id);

    expect(erased.rows.deliveries).toBe(3);
    expect((await store.listDeliveries()).map((d) => [d.occurrenceId, d.userId])).toEqual([[theirRun, curly.id]]);
    expect(await store.deleteDeliveries(larry.id)).toBe(0);
    expect((await store.listUsage()).map((u) => u.userId)).toEqual([curly.id]);
    const notices = (db.query("SELECT key FROM notices ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    expect(notices).toEqual(["budget:global:2026-10-01", `budget:person:${curly.id}:2026-10-01`]);
    expect(erased.rows.findings).toBe(1);
    expect((await store.listFindings()).map((f) => f.text)).toEqual(["their claim"]);
    expect(erased.rows.executor_jobs).toBe(2);
    expect([jobs.get(hisRun), jobs.get(`${hisRun}:1`), jobs.get(theirRun)]).toEqual([null, null, "remote-theirs"]);
  });
});
