// Pure request/response shapes for docs/bridge-protocol.md (Rackbops/discord-mcp, decision 6 of
// Tooling#735's plan) -- no I/O, no HostApi. The wire is snake_case JSON (request_id, guild_id,
// message_ref, created_at); everything internal is camelCase, so every function here is also the
// one place that translates between the two. Validation never throws -- a malformed request is data,
// not a crash.
import type { HostCard, HostDelivery, HostLinkButton } from "../../../packages/api/contract.js";

export const REQUEST_ID_RE = /^[0-9a-f]{64}$/;
export const SNOWFLAKE_RE = /^[0-9]{5,25}$/;
export const MAX_BODY_BYTES = 64 * 1024;
export const CONTENT_MIN = 1;
export const CONTENT_MAX = 2000;

// Tooling#743's own wire shape for POST /pair/redeem's body. Deliberately looser than registry.ts's
// own CODE_ALPHABET (which excludes I/L/O/U) -- the wire only rejects a structurally-wrong
// submission, never second-guesses which subset of A-Z the generator used. GET /registration/{user_id}
// has no request body, so its own id-shape lives only at http.ts's routing regex (REGISTRATION_ID_RE)
// -- matching this file's existing DELIVERY_ID_RE/REQUEST_ID_RE split, where a path parameter's shape
// is checked once, at the route match, and a handler never re-validates what its own routing already
// guaranteed. An earlier revision also exported a DISCORD_USER_ID_RE here for http.ts to reuse, but
// nothing in protocol.ts's own body-validation ever needed it (no request body carries a user_id) and
// composing it into the anchored routing regex is actively wrong (a regex's `^`/`$` land in `.source`
// literally, so nesting one inside another produces un-satisfiable inner anchors) -- removed rather
// than kept as an unused, never-reused export.
export const PAIR_CODE_RE = /^[A-Z2-9]{27}$/;

// Mirrors package.json's botPlugin.destinations verbatim (Tooling#742 decision 1) -- kept as a
// runtime constant because a plugin has no access to its own manifest at runtime; the two must be
// changed together, and generate-index's own duplicate/shape checks catch the manifest half drifting.
export const DESTINATIONS = [
  { name: "alerts", description: "Time-sensitive findings and warnings" },
  { name: "deals", description: "Notable deals or opportunities" },
  { name: "digest", description: "Periodic summaries" },
  { name: "ops", description: "Operational status and infrastructure notices" },
] as const;
export type Destination = (typeof DESTINATIONS)[number]["name"];
const DESTINATION_NAMES: readonly string[] = DESTINATIONS.map((d) => d.name);

export type DeliveryKind = "post" | "dm" | "edit";

export interface PostTarget {
  guildId: string;
  destination: string;
}

export interface DeliveryBody {
  content: string;
  card?: HostCard;
  links?: HostLinkButton[];
}

/** One delivery's full record, kept one per `request_id` (decision 5). `dm`/`edit` land straight in
 *  `failed{CAPABILITY_UNAVAILABLE}` at creation (#742 decision 5) and never hold a real target, so
 *  `target` for those is whatever the caller sent, best-effort, never read for an actual delivery. */
export type StoredDelivery =
  | { state: "pending"; kind: DeliveryKind; target: PostTarget; body: DeliveryBody; createdAt: string }
  | { state: "unknown"; kind: DeliveryKind; target: PostTarget; body: DeliveryBody; createdAt: string }
  | {
      state: "delivered";
      kind: DeliveryKind;
      target: PostTarget;
      body: DeliveryBody;
      createdAt: string;
      messageRef: string | null;
      url: string | null;
      delivery: HostDelivery | null;
    }
  | {
      state: "failed";
      kind: DeliveryKind;
      target: PostTarget;
      body: DeliveryBody;
      createdAt: string;
      code: "CAPABILITY_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE";
    };

export type ValidatedCreate =
  | { ok: true; requestId: string; kind: DeliveryKind; target: PostTarget; body: DeliveryBody }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort target for a `dm`/`edit` request -- never read for delivery (they fail before ever
 *  reaching drain), kept only so the stored record shows what was actually asked for. */
function coerceTarget(raw: unknown): PostTarget {
  const r = isRecord(raw) ? raw : {};
  return {
    guildId: typeof r.guild_id === "string" ? r.guild_id : "",
    destination: typeof r.destination === "string" ? r.destination : "",
  };
}

function validateBody(raw: unknown): { ok: true; value: DeliveryBody } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "body must be an object" };
  if (typeof raw.content !== "string" || raw.content.length < CONTENT_MIN || raw.content.length > CONTENT_MAX) {
    return { ok: false, reason: `body.content must be ${CONTENT_MIN}..${CONTENT_MAX} characters` };
  }
  const value: DeliveryBody = { content: raw.content };
  // card/links are re-validated in full by the host's own validateHostMessage at drain time
  // (hostMessage.ts); here they only need to be present-or-absent, not deeply shaped.
  if (raw.card !== undefined) {
    if (!isRecord(raw.card)) return { ok: false, reason: "body.card must be an object" };
    value.card = raw.card as unknown as HostCard;
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) return { ok: false, reason: "body.links must be an array" };
    value.links = raw.links as unknown as HostLinkButton[];
  }
  return { ok: true, value };
}

/**
 * `POST /deliveries`'s body, validated (decision 5). `kind` "dm"/"edit" is a structurally valid
 * request -- it is accepted here and left to the caller to immediately record as
 * `failed{CAPABILITY_UNAVAILABLE}` (decision 5's second bullet); only `kind: "post"` gets its
 * `target` deeply checked (a declared destination, a real snowflake), since that is the only kind
 * whose target is ever actually used.
 */
export function validateCreateRequest(raw: unknown): ValidatedCreate {
  if (!isRecord(raw)) return { ok: false, reason: "request body must be an object" };
  const requestId = raw.request_id;
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
    return { ok: false, reason: "request_id must be a lowercase 64-character hex string" };
  }
  const kind = raw.kind;
  if (kind !== "post" && kind !== "dm" && kind !== "edit") {
    return { ok: false, reason: 'kind must be "post", "dm" or "edit"' };
  }
  const bodyResult = validateBody(raw.body);
  if (!bodyResult.ok) return bodyResult;

  if (kind !== "post") {
    return { ok: true, requestId, kind, target: coerceTarget(raw.target), body: bodyResult.value };
  }

  if (!isRecord(raw.target)) return { ok: false, reason: "target must be an object" };
  const guildId = raw.target.guild_id;
  if (typeof guildId !== "string" || !SNOWFLAKE_RE.test(guildId)) {
    return { ok: false, reason: "target.guild_id must be a snowflake" };
  }
  const destination = raw.target.destination;
  if (typeof destination !== "string" || !DESTINATION_NAMES.includes(destination)) {
    return { ok: false, reason: `target.destination must be one of ${DESTINATION_NAMES.join(", ")}` };
  }
  return { ok: true, requestId, kind, target: { guildId, destination }, body: bodyResult.value };
}

export type ValidatedRedeem = { ok: true; code: string } | { ok: false };

/** `POST /pair/redeem`'s body (Tooling#743): the wire contract names one 400 reason
 *  ("malformed request") for every shape problem -- not JSON, no `code`, or `code` not matching
 *  `PAIR_CODE_RE` -- so this collapses them to a single boolean rather than a `reason` string. */
export function validateRedeemRequest(raw: unknown): ValidatedRedeem {
  if (!isRecord(raw)) return { ok: false };
  const code = raw.code;
  if (typeof code !== "string" || !PAIR_CODE_RE.test(code)) return { ok: false };
  return { ok: true, code };
}

/** Wire JSON for `GET /capabilities` (decision 4). `dm`/`edit` are `false` regardless of the host in
 *  this child -- the recipient registry and edit ordering arrive in Tooling#737. */
export function capabilitiesResponse(hasPost: boolean): Record<string, unknown> {
  return {
    dm: false,
    targeted_post: hasPost,
    cards: hasPost,
    edit: false,
    destinations: DESTINATIONS.map((d) => ({ destination: d.name, description: d.description })),
  };
}

/** `StoredDelivery` -> the wire `DeliveryState` JSON (snake_case), the same shape for both
 *  `POST /deliveries`'s `state` field and `GET /deliveries/{request_id}`'s whole body. */
export function toWireState(stored: StoredDelivery): Record<string, unknown> {
  const base = {
    kind: stored.kind,
    target: { guild_id: stored.target.guildId, destination: stored.target.destination },
    body: {
      content: stored.body.content,
      ...(stored.body.card !== undefined ? { card: stored.body.card } : {}),
      ...(stored.body.links !== undefined ? { links: stored.body.links } : {}),
    },
    created_at: stored.createdAt,
  };
  switch (stored.state) {
    case "pending":
    case "unknown":
      return { state: stored.state, ...base };
    case "delivered":
      return { state: "delivered", ...base, message_ref: stored.messageRef, url: stored.url };
    case "failed":
      return { state: "failed", ...base, code: stored.code };
  }
}
