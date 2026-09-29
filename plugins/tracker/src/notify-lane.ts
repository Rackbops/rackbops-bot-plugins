import { Lanes, type Clock, type Store, type TaskType, type TickResult } from "@rackbops/docket-core";
import type { HostApi, PluginLog } from "../../../packages/api/contract.js";
import type { ClaimStore } from "./claims.js";
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
}

export type NotifyTickOutcome =
  | { kind: "ran"; result: TickResult }
  | { kind: "aborted" }
  /** The host predates `dm` (rackbops-discord-bot#736): nothing can be delivered, so nothing runs. */
  | { kind: "no-dm" };

export async function runNotifyTick(d: NotifyLaneDeps, signal?: AbortSignal): Promise<NotifyTickOutcome> {
  if (typeof d.dm !== "function") return { kind: "no-dm" };
  if (signal?.aborted) return { kind: "aborted" };
  const notifier = createDmNotifier({
    store: d.store,
    claims: d.claims,
    dm: d.dm,
    clock: d.clock,
    log: d.log,
    ...(signal ? { signal } : {}),
  });
  const lanes = new Lanes({ store: d.store, clock: d.clock, types: d.types, notifier });
  const result = await lanes.tickNotify();
  return signal?.aborted ? { kind: "aborted" } : { kind: "ran", result };
}
