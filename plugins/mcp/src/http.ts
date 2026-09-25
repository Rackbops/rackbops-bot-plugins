// Routes docs/bridge-protocol.md's three endpoints under /mcp/ (Tooling#742 decisions 2-5). Wires
// auth.ts, protocol.ts, store.ts and drain.ts together; owns no state of its own.
import type { HostApi, PluginHttpInfo, PluginLog } from "../../../packages/api/contract.js";
import { checkAuth, type RateLimiter } from "./auth.js";
import { drainAndPersist, type DrainLock } from "./drain.js";
import {
  capabilitiesResponse,
  MAX_BODY_BYTES,
  toWireState,
  validateCreateRequest,
  validateRedeemRequest,
  type StoredDelivery,
} from "./protocol.js";
import type { RegistryStore } from "./registry.js";
import type { DeliveryStore } from "./store.js";

export interface HttpDeps {
  host: HostApi;
  store: DeliveryStore;
  registry: RegistryStore;
  token: string | undefined;
  limiter: RateLimiter;
  drainLock: DrainLock;
  now: () => Date;
  log: PluginLog;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Claims `requestId` in `deps.drainLock`; on success, stores `entry` as the current state and kicks
 * off its delivery without awaiting it (the `202` goes out first, decision 5), releasing the lock
 * once the attempt settles either way -- INCLUDING if the initial write itself throws (a full disk,
 * a permissions error): that write is not load-bearing for the delivery attempt (drain works from
 * the in-memory `entry`, and drainAndPersist's own write corrects the file once the attempt settles),
 * so a failure there is logged and the attempt proceeds anyway, rather than left to propagate
 * uncaught -- which used to skip past the `.finally()` below entirely and strand the lock for that
 * request_id forever (review finding, Tooling#742). Returns whether the claim succeeded -- on
 * `false` (the tick's re-drive already holds this id) NOTHING is written or started; the caller must
 * answer with the unmodified existing state instead. The same lock, shared with the tick (index.ts),
 * is what stops a caller's retry and the tick's re-drive from ever draining one id at the same time:
 * for a brand-new reservation the claim always succeeds (the id cannot already be in flight
 * anywhere), so this is also the one place that writes the store for both a fresh `pending` and a
 * `failed`/`unknown` reset.
 */
async function startDrain(deps: HttpDeps, requestId: string, entry: Extract<StoredDelivery, { state: "pending" }>): Promise<boolean> {
  if (!deps.drainLock.tryStart(requestId)) return false;
  try {
    await deps.store.set(requestId, entry);
  } catch (err) {
    deps.log.error(`writing the initial state for delivery ${requestId} failed -- attempting delivery anyway`, err);
  }
  void drainAndPersist(deps.host, requestId, entry, deps.store.set, deps.log)
    .catch((err) => deps.log.error(`delivery ${requestId} failed to persist`, err))
    .finally(() => deps.drainLock.finish(requestId));
  return true;
}

async function handleCreateDelivery(request: Request, deps: HttpDeps): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { error: "request body too large" });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: "request body must be valid JSON" });
  }
  const validated = validateCreateRequest(raw);
  if (!validated.ok) return json(400, { error: validated.reason });
  const { requestId, kind, target, body } = validated;

  if (kind !== "post") {
    // Structurally valid, capability we don't have (decision 5's second bullet) -- still goes
    // through reserve so a retry of the SAME request_id sees the same stored answer, not a second
    // fresh evaluation, and existing:true/false is reported the same way as every other kind.
    const { value, existing } = await deps.store.reserve(requestId, kind, target, body, deps.now);
    if (value.state === "pending" || value.state === "unknown") {
      const failed: StoredDelivery = { state: "failed", kind, target, body, createdAt: value.createdAt, code: "CAPABILITY_UNAVAILABLE" };
      await deps.store.set(requestId, failed);
      return json(202, { state: toWireState(failed), existing });
    }
    return json(202, { state: toWireState(value), existing });
  }

  const { value, existing } = await deps.store.reserve(requestId, kind, target, body, deps.now);
  if (!existing) {
    await startDrain(deps, requestId, value as Extract<StoredDelivery, { state: "pending" }>);
    return json(202, { state: toWireState(value), existing });
  }

  // Retry semantics (decision 5): delivered/pending answer the stored state with no new drain;
  // failed/unknown reset to pending (keeping the ORIGINAL createdAt -- the request's true age is
  // what prune measures) and drain again -- unless the tick's re-drive already holds this id's
  // drain lock, in which case startDrain leaves the stored state untouched and this retry
  // re-attaches to whatever the tick is already doing instead of starting a second attempt.
  if (value.state === "delivered" || value.state === "pending") {
    return json(202, { state: toWireState(value), existing });
  }
  const reset: Extract<StoredDelivery, { state: "pending" }> = {
    state: "pending",
    kind: value.kind,
    target: value.target,
    body: value.body,
    createdAt: value.createdAt,
  };
  const started = await startDrain(deps, requestId, reset);
  return json(202, { state: toWireState(started ? reset : value), existing });
}

async function handleGetDelivery(requestId: string, deps: HttpDeps): Promise<Response> {
  const value = await deps.store.get(requestId);
  if (value === undefined) return json(404, { error: "unknown request_id" });
  return json(200, toWireState(value));
}

/** `POST /pair/redeem` (Tooling#743): a malformed body/code is 400 before the registry is ever
 *  touched; the registry's own "unknown, expired, used, or orphaned by an unregister" cases all
 *  answer the same 404 (decision 6) -- there is nothing left to distinguish once `redeem` returns. */
async function handleRedeemPair(request: Request, deps: HttpDeps): Promise<Response> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "malformed request" });
  }
  const validated = validateRedeemRequest(raw);
  if (!validated.ok) return json(400, { error: "malformed request" });
  const outcome = await deps.registry.redeem(validated.code, deps.now);
  if (!outcome.ok) return json(404, { error: "invalid or expired code" });
  return json(200, { discord_user_id: outcome.discordUserId, generation: outcome.generation });
}

/** `GET /registration/{user_id}` (Tooling#743). The path segment's own shape is enforced by
 *  `REGISTRATION_ID_RE` below, the same way `DELIVERY_ID_RE` enforces the hex-64 shape for
 *  deliveries -- a malformed user_id therefore never reaches this handler at all, falling through
 *  to the generic catch-all 404 rather than this endpoint's specific "not registered" one. */
async function handleGetRegistration(userId: string, deps: HttpDeps): Promise<Response> {
  const generation = await deps.registry.generationOf(userId);
  if (generation === undefined) return json(404, { error: "not registered" });
  return json(200, { generation });
}

const DELIVERY_ID_RE = /^\/deliveries\/([0-9a-f]{64})$/;
const REGISTRATION_ID_RE = /^\/registration\/([1-9][0-9]{16,19})$/;

export async function handleMcpHttp(request: Request, info: PluginHttpInfo, deps: HttpDeps): Promise<Response> {
  // Decision 3: unset token is 503, checked BEFORE auth.
  if (deps.token === undefined) return json(503, { error: "bridge not configured" });
  const auth = checkAuth(request, info.clientIp, deps.token, deps.limiter, deps.now, deps.log);
  if (!auth.ok) return json(auth.status, { error: auth.status === 429 ? "too many failed attempts" : "unauthorized" });

  if (info.path === "/capabilities") {
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    return json(200, capabilitiesResponse(typeof deps.host.post === "function"));
  }
  if (info.path === "/deliveries") {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    return handleCreateDelivery(request, deps);
  }
  const deliveryMatch = DELIVERY_ID_RE.exec(info.path);
  if (deliveryMatch) {
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    return handleGetDelivery(deliveryMatch[1]!, deps);
  }
  if (info.path === "/pair/redeem") {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    return handleRedeemPair(request, deps);
  }
  const registrationMatch = REGISTRATION_ID_RE.exec(info.path);
  if (registrationMatch) {
    if (request.method !== "GET") return json(405, { error: "method not allowed" });
    return handleGetRegistration(registrationMatch[1]!, deps);
  }
  return json(404, { error: "not found" });
}
