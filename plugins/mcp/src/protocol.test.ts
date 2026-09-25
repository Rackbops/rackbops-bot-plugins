import { describe, expect, test } from "bun:test";
import { capabilitiesResponse, CONTENT_MAX, recipientsResponse, toWireState, validateCreateRequest, type StoredDelivery } from "./protocol.js";

const VALID_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);
const USER = "123456789012345678";
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

const validDm = (over: Record<string, unknown> = {}) => ({
  request_id: VALID_ID,
  kind: "dm",
  target: { user_id: USER },
  body: { content: "hi" },
  ...over,
});

const validEdit = (over: Record<string, unknown> = {}) => ({
  request_id: OTHER_ID,
  kind: "edit",
  target: { message_ref: VALID_ID, seq: 1 },
  body: { content: "v2" },
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

describe("validateCreateRequest: post body", () => {
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

  test("content is required for post -- an absent content is refused, not treated as optional", () => {
    expect(validateCreateRequest(validPost({ body: {} }))).toEqual({
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

describe("validateCreateRequest: dm", () => {
  test("accepts a valid dm request", () => {
    expect(validateCreateRequest(validDm())).toEqual({
      ok: true,
      requestId: VALID_ID,
      kind: "dm",
      target: { userId: USER },
      body: { content: "hi" },
    });
  });

  test("refuses a non-object target", () => {
    expect(validateCreateRequest(validDm({ target: "nope" }))).toEqual({ ok: false, reason: "target must be an object" });
  });

  test("refuses a user_id that isn't a snowflake", () => {
    for (const bad of ["not-an-id", "1234", "1".repeat(26)]) {
      expect(validateCreateRequest(validDm({ target: { user_id: bad } }))).toEqual({
        ok: false,
        reason: "target.user_id must be a snowflake",
      });
    }
  });

  test("content is required for dm, exactly like post", () => {
    expect(validateCreateRequest(validDm({ body: {} }))).toEqual({
      ok: false,
      reason: `body.content must be 1..${CONTENT_MAX} characters`,
    });
  });
});

describe("validateCreateRequest: edit", () => {
  test("accepts a valid edit request", () => {
    expect(validateCreateRequest(validEdit())).toEqual({
      ok: true,
      requestId: OTHER_ID,
      kind: "edit",
      target: { messageRef: VALID_ID, seq: 1 },
      body: { content: "v2" },
    });
  });

  test("refuses a non-object target", () => {
    expect(validateCreateRequest(validEdit({ target: "nope" }))).toEqual({ ok: false, reason: "target must be an object" });
  });

  test("refuses a message_ref that isn't 64 lowercase hex characters", () => {
    for (const bad of ["short", "A".repeat(64), "g".repeat(64)]) {
      expect(validateCreateRequest(validEdit({ target: { message_ref: bad, seq: 1 } }))).toEqual({
        ok: false,
        reason: "target.message_ref must be a lowercase 64-character hex string",
      });
    }
  });

  test("refuses a seq that isn't an integer from 1 to 2147483647", () => {
    for (const bad of [0, -1, 1.5, 2147483648, "1"]) {
      expect(validateCreateRequest(validEdit({ target: { message_ref: VALID_ID, seq: bad } }))).toEqual({
        ok: false,
        reason: "target.seq must be an integer from 1 to 2147483647",
      });
    }
  });

  test("accepts seq at both boundaries, 1 and 2147483647", () => {
    expect(validateCreateRequest(validEdit({ target: { message_ref: VALID_ID, seq: 1 } }))).toMatchObject({ ok: true });
    expect(validateCreateRequest(validEdit({ target: { message_ref: VALID_ID, seq: 2147483647 } }))).toMatchObject({ ok: true });
  });

  test("content is NOT required -- card alone, or links alone, is a valid edit body", () => {
    expect(validateCreateRequest(validEdit({ body: { card: { title: "t" } } }))).toMatchObject({ ok: true, body: { card: { title: "t" } } });
    const links = [{ label: "l", url: "https://example.com" }];
    expect(validateCreateRequest(validEdit({ body: { links } }))).toMatchObject({ ok: true, body: { links } });
  });

  test("refuses a body with none of content, card or links", () => {
    expect(validateCreateRequest(validEdit({ body: {} }))).toEqual({
      ok: false,
      reason: "body must include at least one of content, card or links",
    });
  });

  test("content, when present, is still bounded 1..2000", () => {
    expect(validateCreateRequest(validEdit({ body: { content: "" } }))).toEqual({
      ok: false,
      reason: `body.content must be 1..${CONTENT_MAX} characters`,
    });
  });
});

describe("capabilitiesResponse", () => {
  test("dm/edit/targeted_post/cards each follow their own flag independently", () => {
    expect(capabilitiesResponse({ post: true, dm: false, edit: false })).toMatchObject({ dm: false, edit: false, targeted_post: true, cards: true });
    expect(capabilitiesResponse({ post: false, dm: false, edit: false })).toMatchObject({ dm: false, edit: false, targeted_post: false, cards: false });
    expect(capabilitiesResponse({ post: false, dm: true, edit: false })).toMatchObject({ dm: true, edit: false, targeted_post: false, cards: false });
    expect(capabilitiesResponse({ post: false, dm: false, edit: true })).toMatchObject({ dm: false, edit: true, targeted_post: false, cards: false });
  });

  test("destinations lists all four declared names with descriptions", () => {
    const result = capabilitiesResponse({ post: true, dm: false, edit: false });
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

  test("a body with no content omits content from the wire body entirely (card/links-only edit)", () => {
    const cardOnly: StoredDelivery = {
      state: "pending",
      kind: "edit",
      target: { messageRef: VALID_ID, seq: 1 },
      body: { card: { title: "t" } },
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    const wire = toWireState(cardOnly);
    expect(wire.body).toEqual({ card: { title: "t" } });
    expect((wire.body as Record<string, unknown>).content).toBeUndefined();
  });

  test("a dm target is wired as user_id, not guild_id/destination", () => {
    const dm: StoredDelivery = {
      state: "pending",
      kind: "dm",
      target: { userId: USER },
      body: { content: "hi" },
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    expect(toWireState(dm).target).toEqual({ user_id: USER });
  });

  test("an edit target is wired as message_ref/seq", () => {
    const edit: StoredDelivery = {
      state: "pending",
      kind: "edit",
      target: { messageRef: VALID_ID, seq: 2 },
      body: { content: "v2" },
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    expect(toWireState(edit).target).toEqual({ message_ref: VALID_ID, seq: 2 });
  });

  test("applied appears only on a delivered edit record, never on post/dm or a non-delivered edit", () => {
    const deliveredEdit: StoredDelivery = {
      state: "delivered",
      kind: "edit",
      target: { messageRef: VALID_ID, seq: 2 },
      body: { content: "v2" },
      createdAt: "2026-09-25T00:00:00.000Z",
      messageRef: VALID_ID,
      url: "https://discord.com/x",
      delivery: { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE },
      applied: true,
    };
    expect(toWireState(deliveredEdit).applied).toBe(true);

    const deliveredEditFalse: StoredDelivery = { ...deliveredEdit, applied: false };
    expect(toWireState(deliveredEditFalse).applied).toBe(false);

    const deliveredPost: StoredDelivery = {
      state: "delivered",
      kind: "post",
      target,
      body,
      createdAt: "2026-09-25T00:00:00.000Z",
      messageRef: VALID_ID,
      url: "https://discord.com/x",
      delivery: { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE },
    };
    expect("applied" in toWireState(deliveredPost)).toBe(false);

    const pendingEdit: StoredDelivery = {
      state: "pending",
      kind: "edit",
      target: { messageRef: VALID_ID, seq: 2 },
      body: { content: "v2" },
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    expect("applied" in toWireState(pendingEdit)).toBe(false);
  });
});

describe("recipientsResponse", () => {
  test("matches the literal wire shape", () => {
    expect(recipientsResponse([{ userId: USER, displayName: "Roshne", registeredAt: "2026-09-25T00:00:00.000Z" }])).toEqual({
      items: [{ user_id: USER, display_name: "Roshne" }],
    });
  });

  test("an empty list is an empty items array", () => {
    expect(recipientsResponse([])).toEqual({ items: [] });
  });

  test("ordered by registeredAt ascending, then user_id", () => {
    const entries = [
      { userId: "3", displayName: "C", registeredAt: "2026-09-25T00:00:02.000Z" },
      { userId: "1", displayName: "A", registeredAt: "2026-09-25T00:00:00.000Z" },
      { userId: "2", displayName: "B", registeredAt: "2026-09-25T00:00:00.000Z" }, // same instant as userId 1 -- tiebreak by user_id
    ];
    expect(recipientsResponse(entries).items).toEqual([
      { user_id: "1", display_name: "A" },
      { user_id: "2", display_name: "B" },
      { user_id: "3", display_name: "C" },
    ]);
  });

  test("101 registered users -> capped at 100, oldest first", () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({
      userId: String(i).padStart(3, "0"),
      displayName: `user-${i}`,
      registeredAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    const result = recipientsResponse(entries);
    const items = result.items as { user_id: string; display_name: string }[];
    expect(items).toHaveLength(100);
    expect(items[0]!.user_id).toBe("000"); // oldest first
    expect(items.some((e) => e.user_id === "100")).toBe(false); // the newest (101st) is the one dropped
  });

  test("a display name over 100 characters is truncated to 100", () => {
    const result = recipientsResponse([{ userId: USER, displayName: "x".repeat(150), registeredAt: "2026-09-25T00:00:00.000Z" }]);
    const items = result.items as { display_name: string }[];
    expect(items[0]!.display_name).toHaveLength(100);
    expect(items[0]!.display_name).toBe("x".repeat(100));
  });
});
