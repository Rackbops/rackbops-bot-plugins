import { describe, expect, test } from "bun:test";
import { capabilitiesResponse, CONTENT_MAX, toWireState, validateCreateRequest, type StoredDelivery } from "./protocol.js";

const VALID_ID = "a".repeat(64);
const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const MESSAGE = "333333333333333333";

const validPost = (over: Record<string, unknown> = {}) => ({
  request_id: VALID_ID,
  kind: "post",
  target: { guild_id: GUILD, destination: "alerts" },
  body: { content: "hi" },
  ...over,
});

describe("validateCreateRequest: request_id and kind", () => {
  test("accepts a valid post request", () => {
    const result = validateCreateRequest(validPost());
    expect(result).toEqual({
      ok: true,
      requestId: VALID_ID,
      kind: "post",
      target: { guildId: GUILD, destination: "alerts" },
      body: { content: "hi" },
    });
  });

  test("refuses a non-object request body", () => {
    expect(validateCreateRequest("nope")).toEqual({ ok: false, reason: "request body must be an object" });
    expect(validateCreateRequest(null)).toEqual({ ok: false, reason: "request body must be an object" });
  });

  test("refuses a request_id that isn't 64 lowercase hex characters", () => {
    for (const bad of ["short", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(validateCreateRequest(validPost({ request_id: bad }))).toEqual({
        ok: false,
        reason: "request_id must be a lowercase 64-character hex string",
      });
    }
  });

  test("refuses a kind that isn't post, dm or edit", () => {
    expect(validateCreateRequest(validPost({ kind: "broadcast" }))).toEqual({
      ok: false,
      reason: 'kind must be "post", "dm" or "edit"',
    });
  });
});

describe("validateCreateRequest: body", () => {
  test("content accepted at 1 and 2000 characters, refused at 0 and 2001", () => {
    expect(validateCreateRequest(validPost({ body: { content: "a" } }))).toMatchObject({ ok: true });
    expect(validateCreateRequest(validPost({ body: { content: "a".repeat(CONTENT_MAX) } }))).toMatchObject({ ok: true });
    expect(validateCreateRequest(validPost({ body: { content: "" } }))).toEqual({
      ok: false,
      reason: `body.content must be 1..${CONTENT_MAX} characters`,
    });
    expect(validateCreateRequest(validPost({ body: { content: "a".repeat(CONTENT_MAX + 1) } }))).toEqual({
      ok: false,
      reason: `body.content must be 1..${CONTENT_MAX} characters`,
    });
  });

  test("a non-object body is refused", () => {
    expect(validateCreateRequest(validPost({ body: "hi" }))).toEqual({ ok: false, reason: "body must be an object" });
  });

  test("card and links pass through when present, absent when omitted", () => {
    const card = { title: "t" };
    const links = [{ label: "l", url: "https://example.com" }];
    const result = validateCreateRequest(validPost({ body: { content: "hi", card, links } }));
    expect(result).toMatchObject({ ok: true, body: { content: "hi", card, links } });

    const bare = validateCreateRequest(validPost({ body: { content: "hi" } }));
    expect(bare).toMatchObject({ ok: true });
    if (bare.ok) {
      expect(bare.body.card).toBeUndefined();
      expect(bare.body.links).toBeUndefined();
    }
  });

  test("a non-object card or a non-array links is refused", () => {
    expect(validateCreateRequest(validPost({ body: { content: "hi", card: "nope" } }))).toEqual({
      ok: false,
      reason: "body.card must be an object",
    });
    expect(validateCreateRequest(validPost({ body: { content: "hi", links: "nope" } }))).toEqual({
      ok: false,
      reason: "body.links must be an array",
    });
  });
});

describe("validateCreateRequest: post target", () => {
  test("refuses a non-object target", () => {
    expect(validateCreateRequest(validPost({ target: "nope" }))).toEqual({ ok: false, reason: "target must be an object" });
  });

  test("refuses a guild_id that isn't a snowflake", () => {
    for (const bad of ["not-an-id", "1234", "1".repeat(26)]) {
      expect(validateCreateRequest(validPost({ target: { guild_id: bad, destination: "alerts" } }))).toEqual({
        ok: false,
        reason: "target.guild_id must be a snowflake",
      });
    }
  });

  test("refuses an undeclared destination", () => {
    expect(validateCreateRequest(validPost({ target: { guild_id: GUILD, destination: "spam" } }))).toEqual({
      ok: false,
      reason: "target.destination must be one of alerts, deals, digest, ops",
    });
  });

  test("accepts every declared destination", () => {
    for (const destination of ["alerts", "deals", "digest", "ops"]) {
      expect(validateCreateRequest(validPost({ target: { guild_id: GUILD, destination } }))).toMatchObject({ ok: true });
    }
  });
});

describe("validateCreateRequest: dm/edit", () => {
  test("dm and edit are accepted structurally, target coerced best-effort and never validated deeply", () => {
    for (const kind of ["dm", "edit"] as const) {
      const result = validateCreateRequest({
        request_id: VALID_ID,
        kind,
        target: { guild_id: "not-a-real-snowflake", destination: "not-declared" },
        body: { content: "hi" },
      });
      expect(result).toEqual({
        ok: true,
        requestId: VALID_ID,
        kind,
        target: { guildId: "not-a-real-snowflake", destination: "not-declared" },
        body: { content: "hi" },
      });
    }
  });

  test("a missing/malformed target for dm/edit coerces to empty strings rather than refusing", () => {
    const result = validateCreateRequest({ request_id: VALID_ID, kind: "dm", target: "garbage", body: { content: "hi" } });
    expect(result).toEqual({
      ok: true,
      requestId: VALID_ID,
      kind: "dm",
      target: { guildId: "", destination: "" },
      body: { content: "hi" },
    });
  });
});

describe("capabilitiesResponse", () => {
  test("targeted_post and cards follow hasPost; dm and edit are always false", () => {
    expect(capabilitiesResponse(true)).toMatchObject({ dm: false, edit: false, targeted_post: true, cards: true });
    expect(capabilitiesResponse(false)).toMatchObject({ dm: false, edit: false, targeted_post: false, cards: false });
  });

  test("destinations lists all four declared names with descriptions", () => {
    const result = capabilitiesResponse(true);
    expect(result.destinations).toEqual([
      { destination: "alerts", description: "Time-sensitive findings and warnings" },
      { destination: "deals", description: "Notable deals or opportunities" },
      { destination: "digest", description: "Periodic summaries" },
      { destination: "ops", description: "Operational status and infrastructure notices" },
    ]);
  });
});

describe("toWireState", () => {
  const target = { guildId: GUILD, destination: "alerts" };
  const body = { content: "hi" };

  test("pending and unknown carry the common fields and nothing else", () => {
    const pending: StoredDelivery = { state: "pending", kind: "post", target, body, createdAt: "2026-09-25T00:00:00.000Z" };
    expect(toWireState(pending)).toEqual({
      state: "pending",
      kind: "post",
      target: { guild_id: GUILD, destination: "alerts" },
      body: { content: "hi" },
      created_at: "2026-09-25T00:00:00.000Z",
    });
    expect(toWireState({ ...pending, state: "unknown" })).toEqual({ ...toWireState(pending), state: "unknown" });
  });

  test("delivered adds message_ref and url, snake_cased", () => {
    const delivered: StoredDelivery = {
      state: "delivered",
      kind: "post",
      target,
      body,
      createdAt: "2026-09-25T00:00:00.000Z",
      messageRef: VALID_ID,
      url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
      delivery: { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE },
    };
    expect(toWireState(delivered)).toEqual({
      state: "delivered",
      kind: "post",
      target: { guild_id: GUILD, destination: "alerts" },
      body: { content: "hi" },
      created_at: "2026-09-25T00:00:00.000Z",
      message_ref: VALID_ID,
      url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    });
  });

  test("failed adds code", () => {
    const failed: StoredDelivery = {
      state: "failed",
      kind: "post",
      target,
      body,
      createdAt: "2026-09-25T00:00:00.000Z",
      code: "UPSTREAM_UNAVAILABLE",
    };
    expect(toWireState(failed)).toEqual({
      state: "failed",
      kind: "post",
      target: { guild_id: GUILD, destination: "alerts" },
      body: { content: "hi" },
      created_at: "2026-09-25T00:00:00.000Z",
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  test("card and links, when present on the body, pass through unchanged", () => {
    const withExtras: StoredDelivery = {
      state: "pending",
      kind: "post",
      target,
      body: { content: "hi", card: { title: "t" }, links: [{ label: "l", url: "https://example.com" }] },
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    const wire = toWireState(withExtras);
    expect((wire.body as Record<string, unknown>).card).toEqual({ title: "t" });
    expect((wire.body as Record<string, unknown>).links).toEqual([{ label: "l", url: "https://example.com" }]);
  });
});
