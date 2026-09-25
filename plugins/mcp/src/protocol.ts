// Pure request/response shapes for docs/bridge-protocol.md (Rackbops/discord-mcp, decision 6 of
// Tooling#735's plan) -- no I/O, no HostApi. The wire is snake_case JSON (request_id, guild_id,
// user_id, message_ref, seq, created_at); everything internal is camelCase, so every function here is
// also the one place that translates between the two. Validation never throws -- a malformed request
// is data, not a crash.
import type { HostCard, HostDelivery, HostLinkButton } from "../../../packages/api/contract.js";

export const REQUEST_ID_RE = /^[0-9a-f]{64}$/;
export const SNOWFLAKE_RE = /^[0-9]{5,25}$/;
/** A Discord user id specifically (Tooling#746's `dm` target, matching `http.ts`'s own
 *  `REGISTRATION_ID_RE` capture group, #743) -- tighter than `SNOWFLAKE_RE` (no leading zero, a
 *  narrower 17-20 digit length): `guild_id`/`message_ref` reuse the looser `SNOWFLAKE_RE`/
 *  `REQUEST_ID_RE` because nothing about THEIR wire contract calls for the tighter shape, but
 *  `target.user_id`'s own 400 rule is exactly `^[1-9][0-9]{16,19}$` -- reusing `SNOWFLAKE_RE` here
 *  would accept a value the documented contract (and `REGISTRATION_ID_RE`'s own precedent) rejects. */
export const DISCORD_USER_ID_RE = /^[1-9][0-9]{16,19}$/;
export const MAX_BODY_BYTES = 64 * 1024;
export const CONTENT_MIN = 1;
export const CONTENT_MAX = 2000;
/** Decision (Tooling#746): `target.seq` on an edit -- a signed 32-bit range, matching the service's
 *  own counter. */
export const SEQ_MIN = 1;
export const SEQ_MAX = 2147483647;
/** `GET /recipients` (Tooling#746): at most this many, and a display name truncated to this many
 *  characters. */
export const RECIPIENTS_MAX = 100;
export const DISPLAY_NAME_MAX = 100;

// Tooling#743's own wire shape for POST /pair/redeem's body. Deliberately looser than registry.ts's
// own CODE_ALPHABET (which excludes I/L/O/U) -- the wire only rejects a structurally-wrong
// submission, never second-guesses which subset of A-Z the generator used. GET /registration/{user_id}
// has no request body, so its own id-shape lives only at http.ts's routing regex (REGISTRATION_ID_RE)
// -- matching this file's existing DELIVERY_ID_RE/REQUEST_ID_RE split, where a path parameter's shape
// is checked once, at the route match, and a handler never re-validates what its own routing already
// guaranteed. A #743 revision removed this file's own DISCORD_USER_ID_RE as unused, on the reasoning
// that no request body carried a user_id yet, and that composing it into REGISTRATION_ID_RE's already-
// anchored routing regex would have been wrong anyway (a regex's `^`/`$` land in `.source` literally,
// so nesting one inside another produces un-satisfiable inner anchors). Tooling#746 reinstates the
// constant above (DISCORD_USER_ID_RE) for its own reason: a dm's `target.user_id` now IS a request-body
// field, with its own 400 rule matching REGISTRATION_ID_RE's capture group exactly -- round-1 review
// caught an earlier revision of this file reusing the looser SNOWFLAKE_RE for it instead, which
// silently accepted a leading-zero or 5-16-digit value the documented `^[1-9][0-9]{16,19}$` rejects.
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

/** Tooling#746 decision 5. */
export interface DmTarget {
  userId: string;
}

/** Tooling#746 decision 5. `seq` is the service's own per-message edit counter, not a Discord id. */
export interface EditTarget {
  messageRef: string;
  seq: number;
}

/** Tooling#746 decision 5: `StoredDelivery.target` is this union, not narrowed by `kind` -- a legacy
 *  #742 dm/edit record (target coerced to `{guildId: "", destination: ""}`) is a real value this type
 *  must still describe, and the mismatch between `kind` and the target's actual shape is exactly what
 *  the guards below let a caller detect. */
export type DeliveryTarget = PostTarget | DmTarget | EditTarget;

export function isPostTarget(target: DeliveryTarget): target is PostTarget {
  return "guildId" in target && "destination" in target;
}
export function isDmTarget(target: DeliveryTarget): target is DmTarget {
  return "userId" in target;
}
export function isEditTarget(target: DeliveryTarget): target is EditTarget {
  return "messageRef" in target && "seq" in target;
}

/** Decision 6 (Tooling#746): optional at the type level -- `edit`'s body may omit it (validated by
 *  `validateBody`'s `requireContent` below), so the type has to allow that for every caller, not just
 *  edit's. `toWireState` emits it only when present. */
export interface DeliveryBody {
  content?: string;
  card?: HostCard;
  links?: HostLinkButton[];
}

/** One delivery's full record, kept one per `request_id` (#742 decision 5). `target` is the general
 *  `DeliveryTarget` union, not narrowed by `kind` -- see `DeliveryTarget`'s own comment. `lastEditSeq`
 *  and `applied` are Tooling#746 additions: `lastEditSeq` persists on a `post`/`dm` original's own
 *  delivered record (decision 4), so a restart can't lose edit ordering; `applied` appears only on a
 *  `kind: "edit"` record that reaches `delivered` (decision 3). */
export type StoredDelivery =
  | { state: "pending"; kind: DeliveryKind; target: DeliveryTarget; body: DeliveryBody; createdAt: string }
  | { state: "unknown"; kind: DeliveryKind; target: DeliveryTarget; body: DeliveryBody; createdAt: string }
  | {
      state: "delivered";
      kind: DeliveryKind;
      target: DeliveryTarget;
      body: DeliveryBody;
      createdAt: string;
      messageRef: string | null;
      url: string | null;
      delivery: HostDelivery | null;
      lastEditSeq?: number;
      applied?: boolean;
    }
  | {
      state: "failed";
      kind: DeliveryKind;
      target: DeliveryTarget;
      body: DeliveryBody;
      createdAt: string;
      code: "CAPABILITY_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE" | "RECIPIENT_UNREACHABLE" | "NOT_FOUND";
    };

export type ValidatedCreate =
  | { ok: true; requestId: string; kind: DeliveryKind; target: DeliveryTarget; body: DeliveryBody }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `content` is required (1..CONTENT_MAX) when `requireContent` -- post and dm, matching #742's
 * original rule. Edit passes `requireContent: false`: `content` is validated the same way when
 * present, but the body must instead carry at least one of `content`/`card`/`links` (Tooling#746 wire
 * contract, `POST /deliveries` kind "edit" 400 rules). card/links are re-validated in full by the
 * host's own validateHostMessage at drain time (hostMessage.ts); here they only need to be
 * present-or-absent, not deeply shaped.
 */
function validateBody(raw: unknown, opts: { requireContent: boolean }): { ok: true; value: DeliveryBody } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "body must be an object" };
  const value: DeliveryBody = {};
  if (raw.content !== undefined) {
    if (typeof raw.content !== "string" || raw.content.length < CONTENT_MIN || raw.content.length > CONTENT_MAX) {
      return { ok: false, reason: `body.content must be ${CONTENT_MIN}..${CONTENT_MAX} characters` };
    }
    value.content = raw.content;
  } else if (opts.requireContent) {
    return { ok: false, reason: `body.content must be ${CONTENT_MIN}..${CONTENT_MAX} characters` };
  }
  if (raw.card !== undefined) {
    if (!isRecord(raw.card)) return { ok: false, reason: "body.card must be an object" };
    value.card = raw.card as unknown as HostCard;
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) return { ok: false, reason: "body.links must be an array" };
    value.links = raw.links as unknown as HostLinkButton[];
  }
  if (!opts.requireContent && value.content === undefined && value.card === undefined && value.links === undefined) {
    return { ok: false, reason: "body must include at least one of content, card or links" };
  }
  return { ok: true, value };
}

/**
 * `POST /deliveries`'s body, validated. Every `kind` now gets its own deeply-checked `target`
 * (Tooling#746 -- `dm` and `edit` used to be coerced best-effort and never actually delivered; now
 * they do, so a malformed target is a real 400, not a record that silently never delivers).
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

  if (kind === "post") {
    const bodyResult = validateBody(raw.body, { requireContent: true });
    if (!bodyResult.ok) return bodyResult;
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

  if (kind === "dm") {
    const bodyResult = validateBody(raw.body, { requireContent: true });
    if (!bodyResult.ok) return bodyResult;
    if (!isRecord(raw.target)) return { ok: false, reason: "target must be an object" };
    const userId = raw.target.user_id;
    if (typeof userId !== "string" || !DISCORD_USER_ID_RE.test(userId)) {
      return { ok: false, reason: "target.user_id must be a snowflake" };
    }
    return { ok: true, requestId, kind, target: { userId }, body: bodyResult.value };
  }

  // kind === "edit"
  const bodyResult = validateBody(raw.body, { requireContent: false });
  if (!bodyResult.ok) return bodyResult;
  if (!isRecord(raw.target)) return { ok: false, reason: "target must be an object" };
  const messageRef = raw.target.message_ref;
  if (typeof messageRef !== "string" || !REQUEST_ID_RE.test(messageRef)) {
    return { ok: false, reason: "target.message_ref must be a lowercase 64-character hex string" };
  }
  const seq = raw.target.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < SEQ_MIN || seq > SEQ_MAX) {
    return { ok: false, reason: `target.seq must be an integer from ${SEQ_MIN} to ${SEQ_MAX}` };
  }
  return { ok: true, requestId, kind, target: { messageRef, seq }, body: bodyResult.value };
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

/** Wire JSON for `GET /capabilities`. `dm`/`edit` now genuinely reflect `host.dm`/`host.edit`
 *  (Tooling#746) -- before this child they were always `false`, regardless of the host. */
export function capabilitiesResponse(flags: { post: boolean; dm: boolean; edit: boolean }): Record<string, unknown> {
  return {
    dm: flags.dm,
    targeted_post: flags.post,
    cards: flags.post,
    edit: flags.edit,
    destinations: DESTINATIONS.map((d) => ({ destination: d.name, description: d.description })),
  };
}

/** The wire shape of one target, keyed by the target's own runtime shape (via the guards above), not
 *  by the record's `kind` -- a legacy record's mismatched target (Tooling#746 decision 5) is emitted
 *  exactly as stored, whatever `kind` says. Never reached for a target none of the three guards match
 *  (every value ever constructed by `validateCreateRequest`, `reserve`'s legacy coercion, or a stored
 *  #742 record satisfies one of them). */
function wireTarget(target: DeliveryTarget): Record<string, unknown> {
  if (isDmTarget(target)) return { user_id: target.userId };
  if (isEditTarget(target)) return { message_ref: target.messageRef, seq: target.seq };
  return { guild_id: target.guildId, destination: target.destination };
}

/** `StoredDelivery` -> the wire `DeliveryState` JSON (snake_case), the same shape for both
 *  `POST /deliveries`'s `state` field and `GET /deliveries/{request_id}`'s whole body. */
export function toWireState(stored: StoredDelivery): Record<string, unknown> {
  const base = {
    kind: stored.kind,
    target: wireTarget(stored.target),
    body: {
      ...(stored.body.content !== undefined ? { content: stored.body.content } : {}),
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
      return {
        state: "delivered",
        ...base,
        message_ref: stored.messageRef,
        url: stored.url,
        ...(stored.applied !== undefined ? { applied: stored.applied } : {}),
      };
    case "failed":
      return { state: "failed", ...base, code: stored.code };
  }
}

/** `GET /recipients` (Tooling#746): ordered by `registeredAt` ascending then `userId` (ISO-8601
 *  sorts lexically the same as chronologically, so a plain string compare is enough), capped at
 *  `RECIPIENTS_MAX`, each `displayName` truncated to `DISPLAY_NAME_MAX` characters. */
export function recipientsResponse(entries: { userId: string; displayName: string; registeredAt: string }[]): Record<string, unknown> {
  const sorted = [...entries].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.userId.localeCompare(b.userId));
  return {
    items: sorted.slice(0, RECIPIENTS_MAX).map((e) => ({ user_id: e.userId, display_name: e.displayName.slice(0, DISPLAY_NAME_MAX) })),
  };
}
