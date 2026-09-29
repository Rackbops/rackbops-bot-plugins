import { Lanes, type Clock, type Store, type TaskType, type TickResult } from "@rackbops/docket-core";
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
 */

export interface NotifyLaneDeps {
  store: Store;
  claims: ClaimStore;
  clock: Clock;
  types: Readonly<Record<string, TaskType<unknown>>>;
  dm: HostApi["dm"];
  log: PluginLog;
  health?: DeliveryHealth;
}

/**
 * The Store as the lane sees it (rackbops-bot-plugins#79). Two things docket 0.3.0 leaves to its
 * host: a due occurrence of a task that is not active is not run (docket's `due` lists every queued
 * occurrence whatever its task's status, so a paused task would still fire), and a recipient whose
 * delivery is paused is left out of a run's targets rather than failing it. Everything else passes
 * through unchanged.
 */
export function laneStore(store: Store, health?: DeliveryHealth): Store {
  const view = Object.create(store) as Store;
  view.listOccurrences = async (filter = {}) => {
    const found = await store.listOccurrences(filter);
    if (filter.status !== "queued" || filter.dueBefore === undefined) return found;
    const kept = [];
    for (const o of found) {
      if ((await store.getTask(o.taskId))?.status === "active") kept.push(o);
    }
    return kept;
  };
  view.listRecipients = async (taskId) => {
    const all = await store.listRecipients(taskId);
    const paused = health?.pausedUsers();
    return paused && paused.size > 0 ? all.filter((r) => !paused.has(r.userId)) : all;
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
  const store = laneStore(d.store, d.health);
  const notifier = createDmNotifier({
    store,
    claims: d.claims,
    dm: d.dm,
    clock: d.clock,
    log: d.log,
    ...(signal ? { signal } : {}),
    ...(d.health ? { health: d.health } : {}),
  });
  const lanes = new Lanes({ store, clock: d.clock, types: d.types, notifier });
  const result = await lanes.tickNotify();
  return signal?.aborted ? { kind: "aborted" } : { kind: "ran", result };
}
