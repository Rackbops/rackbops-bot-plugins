import { ExecutorUnavailableError, Lanes, type Clock, type Fetch, type Store, type Task, type TaskType, type TickResult } from "@rackbops/docket-core";
import type { HostApi, PluginLog } from "../../../packages/api/contract.js";
import type { DeliveryHealth } from "./delivery-health.js";
import type { TaskLocks } from "./locks.js";
import { createDmNotifier } from "./notifier.js";

/**
 * The notify lane on the host's tick (plan 5.3): due notify-lane runs, fired runs left part way,
 * and the sends still owed, through docket's `Lanes.tickNotify` with the tracker's Store, the clock,
 * and a Notifier over `host.dm`. It never touches city-hall and never waits on a model. The execute
 * lane is not ticked here: it has no Executor until the city-hall adapter exists, so its items stay
 * queued (docket skips a lane whose runtime is missing).
 *
 * One task at a time (docket 0.4.0: a task's runs, replies and edits are serialized): the tick finds
 * the tasks with work -- a due or part-way run, a run left `running`, a send owed or a claim left
 * open -- and gives each a pass of its own, `tickNotify` over a view of the Store that shows that one
 * task, under the task's lock (locks.ts), which the surface's replies and edits take too.
 *
 * The lane runs as two host ticks (rackbops-bot-plugins#81), so a reminder never waits behind a slow
 * web page: `notify` takes every task but the ones that read the web (`FETCH_TYPES`), and `poll`
 * only those, with the Fetch port. The host awaits a plugin's ticks one after another in declared
 * order, `notify` first, and stops waiting on a tick after 30 seconds (rackbops-discord-bot
 * src/plugins/host.ts, `PLUGIN_TICK_TIMEOUT_MS`), so a slow page holds the next round up by at most
 * that, and a reminder due now has already gone out. The two take disjoint sets of tasks, and the
 * task lock keeps an abandoned `poll` call from overlapping the next `notify` on one task.
 *
 * The tick's signal reaches docket (0.4.0 checks it before each run, before an outcome is stored and
 * before each send), and a page read cut short by it is not the page's fault, so it must not count
 * as a price miss: on the `poll` tick each page reader's run is wrapped (`untilAborted`) to requeue
 * its run, through docket's `ExecutorUnavailableError`, once the signal has aborted.
 */

/** The notify-lane types that read the web; they run on the `poll` tick, never on `notify`. */
export const FETCH_TYPES: ReadonlySet<string> = new Set(["price"]);

/** Which due runs a tick takes: `notify` everything but `FETCH_TYPES`, `poll` only those. */
export type NotifyTickKind = "notify" | "poll";

export function takesType(kind: NotifyTickKind, type: string): boolean {
  return kind === "poll" ? FETCH_TYPES.has(type) : !FETCH_TYPES.has(type);
}

/** `type` with a run that requeues, rather than records, a run the tick's abort reached. */
export function untilAborted(type: TaskType<unknown>, signal: AbortSignal): TaskType<unknown> {
  const run = type.run;
  if (!run) return type;
  const stop = () => new ExecutorUnavailableError("the tick was aborted; the run waits for the next one");
  return {
    ...type,
    async run(ctx) {
      if (signal.aborted) throw stop();
      const outcome = await run.call(type, ctx);
      if (signal.aborted) throw stop();
      return outcome;
    },
  };
}

export interface NotifyLaneDeps {
  store: Store;
  clock: Clock;
  types: Readonly<Record<string, TaskType<unknown>>>;
  dm: HostApi["dm"];
  log: PluginLog;
  /** Serializes each task's pass with its replies and edits; a private set when absent (tests). */
  locks?: TaskLocks;
  health?: DeliveryHealth;
  /** Which tick this is; `notify` when absent. */
  kind?: NotifyTickKind;
  /** The Fetch port, for the `poll` tick. */
  fetch?: Fetch | null;
}

/**
 * The tasks with work for a tick, soonest first: a queued run due now (docket starts it, or resumes
 * it when it fired and was put back), a run still `running` (docket puts it back once stale), a send
 * owed and due, or a claim left open (docket settles it once stale). `keep` narrows them to the
 * tick's share; it is asked with null for a task whose row is gone (its pass drops what it owed).
 */
export async function tasksWithWork(store: Store, now: Date, keep: (task: Task | null) => boolean): Promise<string[]> {
  const at = now.toISOString();
  const ids: string[] = [];
  const add = (id: string) => void (ids.includes(id) || ids.push(id));
  for (const o of await store.listOccurrences({ status: "queued", dueBefore: at })) add(o.taskId);
  for (const o of await store.listOccurrences({ status: "running" })) add(o.taskId);
  const rows = [...(await store.listDeliveries({ dueBefore: at })), ...(await store.listDeliveries({ status: "claimed" }))];
  for (const row of rows) {
    const o = await store.getOccurrence(row.occurrenceId);
    if (o) add(o.taskId);
  }
  const kept: string[] = [];
  for (const id of ids) {
    if (keep(await store.getTask(id))) kept.push(id);
  }
  return kept;
}

/**
 * The Store as one task's pass sees it: an unscoped list of occurrences or deliveries shows only
 * `taskId`'s, so docket's `tickNotify` -- its due runs, its resumes, its sweep of stale runs and
 * claims, its owed sends -- touches that task alone. Everything else passes through unchanged.
 */
export function taskStore(store: Store, taskId: string): Store {
  const view = Object.create(store) as Store;
  view.listOccurrences = (filter = {}) => store.listOccurrences(filter.taskId === undefined ? { ...filter, taskId } : filter);
  view.listDeliveries = async (filter = {}) => {
    const rows = await store.listDeliveries(filter);
    if (filter.occurrenceId !== undefined) return rows;
    const ours = new Map<string, boolean>();
    const kept = [];
    for (const row of rows) {
      if (!ours.has(row.occurrenceId)) ours.set(row.occurrenceId, (await store.getOccurrence(row.occurrenceId))?.taskId === taskId);
      if (ours.get(row.occurrenceId)) kept.push(row);
    }
    return kept;
  };
  return view;
}

export type NotifyTickOutcome =
  | { kind: "ran"; result: TickResult }
  | { kind: "aborted" }
  /** The host predates `dm` (rackbops-discord-bot#736): nothing can be delivered, so nothing runs. */
  | { kind: "no-dm" };

export async function runNotifyTick(d: NotifyLaneDeps, signal?: AbortSignal): Promise<NotifyTickOutcome> {
  if (typeof d.dm !== "function") return { kind: "no-dm" };
  if (signal?.aborted) return { kind: "aborted" };
  const kind = d.kind ?? "notify";
  const notifier = createDmNotifier({ store: d.store, dm: d.dm, clock: d.clock, log: d.log, ...(d.health ? { health: d.health } : {}) });
  let types = d.types;
  if (kind === "poll" && signal) {
    types = Object.fromEntries(Object.entries(d.types).map(([id, t]) => [id, FETCH_TYPES.has(id) ? untilAborted(t, signal) : t]));
  }
  const locks = d.locks;
  const result: TickResult = { ran: 0, failed: 0, skipped: 0 };
  for (const taskId of await tasksWithWork(d.store, d.clock.now(), (task) => (task ? takesType(kind, task.type) : kind === "notify"))) {
    if (signal?.aborted) break;
    const pass = async () => {
      const lanes = new Lanes({
        store: taskStore(d.store, taskId),
        clock: d.clock,
        types,
        notifier,
        ...(kind === "poll" && d.fetch ? { fetch: d.fetch } : {}),
      });
      const r = await lanes.tickNotify(signal);
      result.ran += r.ran;
      result.failed += r.failed;
      result.skipped += r.skipped;
    };
    await (locks ? locks.run(taskId, pass) : pass());
  }
  return signal?.aborted ? { kind: "aborted" } : { kind: "ran", result };
}
