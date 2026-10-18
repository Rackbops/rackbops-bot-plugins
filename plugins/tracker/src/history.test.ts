import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  describeSchedule,
  formatInstant,
  visibleFindings,
  visibleHistory,
  visibleOccurrences,
  visibleReplies,
  visibleTask,
  type Occurrence,
  type OccurrenceStatus,
  type ReplyKind,
  type TaskEvent,
  type TaskEventKind,
  type User,
} from "@rackbops/docket-core";
import type { TrackerDeps } from "./actions.js";
import { LEFT_DETAIL, PAUSE_DETAIL, PERSON_REF, recipientPauseDetail } from "./delivery-health.js";
import {
  changesForRecipient,
  changeView,
  findingView,
  HISTORY_CHANGES,
  HISTORY_RUNS,
  type HistoryView,
  loadHistory,
  NEUTRAL_PAUSE,
  runView,
  taskHistory,
} from "./history.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

const row = (kind: TaskEvent["kind"], detail: string): TaskEvent => ({ id: "e1", taskId: "t1", actorId: null, kind, detail, at: "2026-10-01T13:00:00.000Z" });
const read = (events: TaskEvent[], viewer = "u4") => changesForRecipient(events, viewer).map((e) => `${e.kind}: ${e.detail}`);

describe("changesForRecipient (#273: another recipient's pause, as a recipient who is not its owner sees it)", () => {
  it("another recipient's pause reads as the task's own, and the resume after it as its own resume", () => {
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    // The owner going on without them reads as the owner's own delivery resuming.
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "resumed by the owner")])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    // A pause by hand keeps its own resume.
    expect(read([row("paused", "paused by the owner"), row("resumed", "resumed by the owner")])).toEqual(["paused: paused by the owner", "resumed: resumed by the owner"]);
  });

  it("their own pause and a pause by hand read as stored", () => {
    for (const detail of [recipientPauseDetail("u4"), "paused by the owner"]) {
      expect(read([row("paused", detail), row("resumed", "delivery resumed")])).toEqual([`paused: ${detail}`, "resumed: delivery resumed"]);
    }
  });

  it("the owner's own delivery pause reads exactly as another recipient's does", () => {
    const owners = read([row("paused", PAUSE_DETAIL), row("resumed", "delivery resumed")]);
    expect(owners).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual(owners);
  });

  it("a resume that says a recipient left reads neutrally; one with no pause shown above it is left out", () => {
    expect(read([row("paused", recipientPauseDetail("u3")), row("resumed", LEFT_DETAIL)])).toEqual([`paused: ${NEUTRAL_PAUSE}`, "resumed: delivery resumed"]);
    expect(read([row("created", "reminder"), row("resumed", LEFT_DETAIL)])).toEqual(["created: reminder"]);
    expect(read([row("resumed", "delivery resumed")])).toEqual([]);
  });

  it("another recipient's pause while the task already shows paused adds no second pause", () => {
    expect(read([row("paused", recipientPauseDetail("u4")), row("paused", recipientPauseDetail("u3")), row("resumed", "delivery resumed")])).toEqual([
      `paused: ${recipientPauseDetail("u4")}`,
      "resumed: delivery resumed",
    ]);
  });
});

/**
 * `loadHistory` before #265's decision 7, verbatim but for its name: it read a task's whole run and
 * change history through docket's authorized reads, then kept the newest. The oracle for the
 * bounded reads below.
 */
async function wholeHistory(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<HistoryView | null> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (!task) return null;
  const now = d.clock.now();
  const all = (await visibleOccurrences(d.store, actor, task.id)) ?? [];
  const upcoming = (o: Occurrence) => o.status === "queued" && Date.parse(o.dueAt) > now.getTime();
  const runs = all.filter((o) => !upcoming(o));
  const next = all.find(upcoming);
  const replies = (await visibleReplies(d.store, actor, task.id)) ?? [];
  const seesEveryone = user.admin || task.ownerId === user.id;
  const visible = (await visibleHistory(d.store, actor, task.id)) ?? [];
  const changes = seesEveryone ? visible : changesForRecipient(visible, user.id);
  const people = new Map<string, User>();
  for (const r of replies) {
    if (!people.has(r.userId)) {
      const u = await d.store.getUser(r.userId);
      if (u) people.set(u.id, u);
    }
  }
  const names = new Map<string, string>();
  for (const e of changes) {
    for (const [, id] of e.detail.matchAll(PERSON_REF)) {
      if (id === undefined || names.has(id)) continue;
      const u = await d.store.getUser(id);
      if (u) names.set(id, u.displayName ?? id);
    }
  }
  const findings = (await visibleFindings(d.store, actor, task.id)) ?? [];
  const owner = task.ownerId === user.id ? user : await d.store.getUser(task.ownerId);
  return {
    task,
    cadence: task.schedule && owner ? describeSchedule(task.schedule, owner, user.timeZone, now) : "no schedule",
    next: next ? formatInstant(next.dueAt, user.timeZone, now) : null,
    runs: runs.slice(-HISTORY_RUNS).map((o) => runView(o, replies, people, user, now, seesEveryone)),
    earlierRuns: Math.max(0, runs.length - HISTORY_RUNS),
    changes: changes.slice(-HISTORY_CHANGES).map((e) => changeView(e, user, now, names)),
    earlierChanges: Math.max(0, changes.length - HISTORY_CHANGES),
    findings: findings.map((f) => findingView(f, user, now)),
  };
}

/** Every kind docket writes: a kind docket adds fails the typecheck here until it is listed. */
const KINDS: Record<TaskEventKind, true> = {
  created: true,
  edited: true,
  schedule_changed: true,
  recipient_invited: true,
  recipient_accepted: true,
  recipient_declined: true,
  recipient_opted_out: true,
  recipient_removed: true,
  granted: true,
  revoked: true,
  blocked: true,
  block_lifted: true,
  paused: true,
  resumed: true,
  completed: true,
  archived: true,
};
const ALL_KINDS = Object.keys(KINDS) as TaskEventKind[];
const DONE: OccurrenceStatus[] = ["done", "failed", "skipped", "snoozed", "running"];
const REPLY_KINDS: ReplyKind[] = ["text", "decision", "opt_out", "done", "snooze"];
const HNOW = "2026-10-02T12:00:00.000Z";

/** A small seeded generator, so a failure names a history that can be built again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Built {
  db: Database;
  d: Pick<TrackerDeps, "store" | "clock">;
  taskId: string;
  viewers: Record<"owner" | "admin" | "larry" | "curly", User>;
}

/**
 * A task with `runs` runs (two still to come; due times that tie, so the order's later keys count),
 * replies on about half of them from the owner and both recipients, and `changes` changes of every
 * kind, about each person, with every kind of pause and resume, in `seed`'s order.
 */
async function built(seed: number, runs: number, changes: number): Promise<Built> {
  const rnd = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const at = "2026-01-01T00:00:00.000Z";
  const person = async (name: string, admin = false) => {
    const u = await store.createUser({ displayName: name, admin, at });
    return u;
  };
  const owner = await person("Moe");
  const admin = await person("Shemp", true);
  const larry = await person("Larry");
  const curly = await person("Curly");
  const zed = await person("Zed");
  const t = await store.createTask({ ownerId: owner.id, type: "reminder", title: "Water the plants", config: {}, schedule: null, lane: "notify", capabilities: ["notify"], at });
  for (const u of [larry, curly]) await store.setRecipient(t.id, u.id, "accepted", at);
  await store.setRecipient(t.id, zed.id, "invited", at);
  const everyone = [owner, larry, curly, zed];
  const base = Date.parse("2026-03-01T00:00:00.000Z");
  const made: Occurrence[] = [];
  for (let i = 0; i < runs; i++) {
    // Two runs in every few share a due time; the last two are still to come.
    const due = i >= runs - 2 ? Date.parse(HNOW) + (i + 1) * 3_600_000 : base + Math.floor(i / 3) * 3_600_000;
    const o = await store.createOccurrence({ taskId: t.id, lane: "notify", dueAt: new Date(due).toISOString(), dedupeKey: `k${seed}-${i}`, at: new Date(base + (i % 7) * 1000).toISOString() });
    if (!o) throw new Error("not made");
    made.push(o);
    if (i >= runs - 2 || rnd() < 0.05) continue; // queued: to come, or due and not yet run
    const status = pick(DONE);
    const error = status === "failed" ? pick([`recipient ${pick(everyone).id} cannot be messaged`, "the page did not answer", `delivery to ${larry.id} failed`]) : null;
    await store.updateOccurrence(o.id, { status, error, late: rnd() < 0.3 });
  }
  for (const o of made) {
    if (rnd() < 0.5) continue;
    for (let k = Math.floor(rnd() * 3); k > 0; k--) {
      const kind = pick(REPLY_KINDS);
      const payload = kind === "text" ? { text: `it is [done] ${Math.floor(rnd() * 100)}` } : kind === "decision" ? { choice: "renew" } : null;
      await store.addReply({ occurrenceId: o.id, taskId: t.id, userId: pick([owner, larry, curly]).id, kind, payload, at });
    }
  }
  const about = (u: User) => pick([u.id, `${u.id} because`, `${u.id}x`]);
  for (let i = 0; i < changes; i++) {
    const kind = rnd() < 0.5 ? pick<TaskEventKind>(["paused", "resumed"]) : pick(ALL_KINDS);
    const detail =
      kind === "paused"
        ? pick([recipientPauseDetail(larry.id), recipientPauseDetail(curly.id), recipientPauseDetail(zed.id), PAUSE_DETAIL, "paused by the owner", "delivery to Zed {u4} paused: 3 DMs"])
        : kind === "resumed"
          ? pick(["delivery resumed", "resumed by the owner", LEFT_DETAIL, "resumed"])
          : kind.startsWith("recipient_") || kind === "blocked" || kind === "block_lifted"
            ? about(pick(everyone))
            : pick(["", "a note", larry.id]);
    await store.addTaskEvent({ taskId: t.id, actorId: owner.id, kind, detail, at: new Date(base + i * 60_000).toISOString() });
  }
  return { db, d: { store, clock: { now: () => new Date(HNOW) } }, taskId: t.id, viewers: { owner, admin, larry, curly } };
}

/** Counts every row the store's statements hand back while `body` runs. */
async function rowsRead(db: Database, body: () => Promise<unknown>): Promise<number> {
  const query = db.query.bind(db);
  let rows = 0;
  db.query = ((sql: string) => {
    const statement = query(sql);
    return new Proxy(statement, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === "all") return (...p: unknown[]) => { const r = (value as (...q: unknown[]) => unknown[]).apply(target, p); rows += r.length; return r; };
        if (key === "get") return (...p: unknown[]) => { const r = (value as (...q: unknown[]) => unknown).apply(target, p); if (r !== null && r !== undefined) rows += 1; return r; };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    await body();
  } finally {
    db.query = query;
  }
  return rows;
}

describe("loadHistory reads only what it shows (#265, decision 7)", () => {
  it("a long history reads the same as when the whole of it was read, for the owner, an admin and each recipient", async () => {
    const b = await built(7, 500, 300);
    for (const [who, viewer] of Object.entries(b.viewers)) {
      const now = await loadHistory(b.d, viewer, b.taskId);
      const before = await wholeHistory(b.d, viewer, b.taskId);
      expect({ who, view: now }).toEqual({ who, view: before });
      expect(now?.runs).toHaveLength(HISTORY_RUNS);
      expect(now?.changes).toHaveLength(HISTORY_CHANGES);
      // 498 runs have come due; the "(N earlier)" counts are the whole history's.
      expect(now?.earlierRuns).toBe(488);
      expect(await taskHistory(b.d as TrackerDeps, viewer, b.taskId)).toContain("Runs:\n- (488 earlier)\n");
    }
    // The recipients are shown fewer changes than the owner: the filter comes before the count.
    const earlier = async (u: User) => (await loadHistory(b.d, u, b.taskId))?.earlierChanges;
    expect(await earlier(b.viewers.owner)).toBe(300 - HISTORY_CHANGES);
    expect(await earlier(b.viewers.larry)).toBeLessThan(300 - HISTORY_CHANGES);
    expect(await earlier(b.viewers.larry)).not.toBe(await earlier(b.viewers.curly));
  });

  it("reads the same as the whole history across many short ones, wherever the newest changes start", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const b = await built(seed, 3 + (seed % 15), seed % 30);
      for (const [who, viewer] of Object.entries(b.viewers)) {
        expect({ seed, who, view: await loadHistory(b.d, viewer, b.taskId) }).toEqual({ seed, who, view: await wholeHistory(b.d, viewer, b.taskId) });
      }
    }
  });

  it("a run due at this very instant is history, not the next run", async () => {
    const b = await built(11, 0, 0);
    const later = new Date(Date.parse(HNOW) + 3_600_000).toISOString();
    for (const [i, dueAt] of [HNOW, later].entries()) await b.d.store.createOccurrence({ taskId: b.taskId, lane: "notify", dueAt, dedupeKey: `now${i}`, at: HNOW });
    for (const viewer of Object.values(b.viewers)) {
      const view = await loadHistory(b.d, viewer, b.taskId);
      expect(view).toEqual(await wholeHistory(b.d, viewer, b.taskId));
      expect(view?.runs.map((r) => r.status)).toEqual(["queued"]);
      expect(view?.next).toBe(formatInstant(later, viewer.timeZone, new Date(HNOW)));
    }
  });

  it("the rows it reads do not grow with the history", async () => {
    const long = await built(7, 500, 300);
    const short = await built(7, 40, 30);
    for (const viewer of Object.values(long.viewers)) {
      const read = await rowsRead(long.db, () => loadHistory(long.d, viewer, long.taskId));
      // The task, its recipients, the queued runs, 10 runs and their replies, 5 changes (and a pause
      // above them), the counts, the people named, and no findings.
      expect(read).toBeLessThan(60);
      // The whole history is past 800 rows; reading it is what this rules out.
      expect(await rowsRead(long.db, () => wholeHistory(long.d, viewer, long.taskId))).toBeGreaterThan(800);
    }
    // The same viewer reads about as much from a history twelve times shorter.
    const owner = await rowsRead(long.db, () => loadHistory(long.d, long.viewers.owner, long.taskId));
    const ownerShort = await rowsRead(short.db, () => loadHistory(short.d, short.viewers.owner, short.taskId));
    expect(owner).toBeLessThan(ownerShort + 20);
  });
});
