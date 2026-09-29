import { ExecutorUnavailableError, Lanes, type Clock, type Fetch, type Store, type Task, type TaskType, type TickResult } from "@rackbops/docket-core";
import type { HostApi, PluginLog } from "../../../packages/api/contract.js";
import type { ClaimStore } from "./claims.js";
import type { DeliveryHealth } from "./delivery-health.js";
import { createDmNotifier } from "./notifier.js";

/**
 * The notify lane on the host's tick (plan 5.3): every due notify-lane occurrence, run through
 * docket's `Lanes.tickNotify` with the tracker's Store, the clock, and a Notifier over `host.dm`.
 * It never touches city-hall and never waits on a model. The execute lane is not ticked here: it has
 * no Executor until the city-hall adapter exists, so its items stay queued (docket skips a lane
 * whose runtime is missing).
 *
 * The lane runs as two host ticks (rackbops-bot-plugins#81), so a reminder never waits behind a slow
 * web page: `notify` runs every notify-lane type except the ones that read the web (`FETCH_TYPES`),
 * and `poll` runs only those, with the Fetch port. The host awaits a plugin's ticks one after
 * another in declared order, `notify` first, and stops waiting on a tick after 30 seconds
 * (rackbops-discord-bot src/plugins/host.ts, `PLUGIN_TICK_TIMEOUT_MS`), so a slow page holds the
 * next round up by at most that, and a reminder due now has already gone out. A tick is never run
 * twice at once, and the two drain disjoint sets of occurrences, so they cannot both take one run
 * even when an abandoned `poll` call overlaps the next `notify`.
 *
 * A page read cut short by the tick's signal (a restart, a stop) is not the page's fault, so it
 * must not count as a price miss: on the `poll` tick each page reader's run is wrapped
 * (`untilAborted`) to requeue its run, through docket's `ExecutorUnavailableError`, once the signal
 * has aborted -- before it starts, or after a read the abort cut short.
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
  claims: ClaimStore;
  clock: Clock;
  types: Readonly<Record<string, TaskType<unknown>>>;
  dm: HostApi["dm"];
  log: PluginLog;
  health?: DeliveryHealth;
  /** Which tick this is; `notify` when absent. */
  kind?: NotifyTickKind;
  /** The Fetch port, for the `poll` tick. */
  fetch?: Fetch | null;
}

/**
 * The Store as the lane sees it (rackbops-bot-plugins#79): a due occurrence of a task that is not
 * active is not run. docket 0.3.0's `due` lists every queued occurrence whatever its task's status,
 * so a paused task would otherwise still fire. `keep` narrows the due runs further, by their task
 * (the tick's share, #81). Everything else passes through unchanged.
 */
export function laneStore(store: Store, keep: (task: Task) => boolean = () => true): Store {
  const view = Object.create(store) as Store;
  view.listOccurrences = async (filter = {}) => {
    const found = await store.listOccurrences(filter);
    if (filter.status !== "queued" || filter.dueBefore === undefined) return found;
    const kept = [];
    for (const o of found) {
      const task = await store.getTask(o.taskId);
      if (task?.status === "active" && keep(task)) kept.push(o);
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
  const store = laneStore(d.store, (task) => takesType(kind, task.type));
  const notifier = createDmNotifier({
    store,
    claims: d.claims,
    dm: d.dm,
    clock: d.clock,
    log: d.log,
    ...(signal ? { signal } : {}),
    ...(d.health ? { health: d.health } : {}),
  });
  let types = d.types;
  if (kind === "poll" && signal) {
    types = Object.fromEntries(Object.entries(d.types).map(([id, t]) => [id, FETCH_TYPES.has(id) ? untilAborted(t, signal) : t]));
  }
  const lanes = new Lanes({ store, clock: d.clock, types, notifier, ...(kind === "poll" && d.fetch ? { fetch: d.fetch } : {}) });
  const result = await lanes.tickNotify();
  return signal?.aborted ? { kind: "aborted" } : { kind: "ran", result };
}
