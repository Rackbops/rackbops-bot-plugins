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
 * The Store as the lane sees it (rackbops-bot-plugins#79): a due occurrence of a task that is not
 * active is not run. docket 0.3.0's `due` lists every queued occurrence whatever its task's status,
 * so a paused task would otherwise still fire. Everything else passes through unchanged.
 */
export function laneStore(store: Store): Store {
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
  const store = laneStore(d.store);
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
