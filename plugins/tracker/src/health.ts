/**
 * `/tracker/healthz` (plan 5.3): the notify lane is the tracker's heartbeat -- it runs on the host's
 * 60-second tick, so a last good tick older than a few minutes means reminders are not going out.
 * Pure over the times it is given; index.ts keeps them and answers the request.
 */

/** Three missed ticks. The host ticks every 60 s and waits on a tick at most 30 s. */
export const STALE_AFTER_MS = 3 * 60_000;

export interface HealthState {
  /** When `activate()` finished; null before (or when it threw). */
  activatedAt: Date | null;
  /** The end of the last tick that ran the lane to completion; null until one has. */
  lastTickAt: Date | null;
  /** Why the lane cannot run at all, when it cannot (e.g. the host has no `dm`). */
  blocked: string | null;
}

export interface Health {
  status: 200 | 503;
  body: { status: "ok" | "starting" | "stale" | "inactive" | "blocked"; lastTickAt: string | null; detail?: string };
}

export function decideHealth(state: HealthState, now: Date): Health {
  const lastTickAt = state.lastTickAt?.toISOString() ?? null;
  if (state.activatedAt === null) return { status: 503, body: { status: "inactive", lastTickAt } };
  if (state.blocked !== null) return { status: 503, body: { status: "blocked", lastTickAt, detail: state.blocked } };
  const since = state.lastTickAt ?? state.activatedAt;
  const fresh = now.getTime() - since.getTime() <= STALE_AFTER_MS;
  if (state.lastTickAt === null) return fresh ? { status: 200, body: { status: "starting", lastTickAt } } : { status: 503, body: { status: "stale", lastTickAt } };
  return fresh ? { status: 200, body: { status: "ok", lastTickAt } } : { status: 503, body: { status: "stale", lastTickAt } };
}

export function healthResponse(health: Health): Response {
  return new Response(JSON.stringify(health.body), {
    status: health.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
