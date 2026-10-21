import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { INTAKE_MAX_TURNS, type IntakeLine } from "@rackbops/docket-types";
import type { HostButton } from "../../../packages/api/contract.js";
import { NOT_ADMITTED } from "./access.js";
import { intakeButtonId, parseIntakeId } from "./buttons.js";
import {
  CHANGE_ASK,
  draftText,
  INTAKE_TURN_LIMIT,
  localNow,
  MODEL_BUSY,
  NOT_OPEN,
  NO_MODEL,
  NOT_UNDERSTOOD,
  NOTHING_SAVED,
  parseIntakeCapability,
  parseIntakeMode,
  STALE,
  STILL_WORKING,
  TEXT_ONLY,
  TOO_SLOW,
  tooLong,
} from "./intake.js";
import { CITY_HALL, fakeCityHall, query, success } from "./web/execute-harness.js";
import { ADMIN, api, cleanup, CURLY, LARRY, makeToken, people, press, signIn, slash, START, STRANGER, world } from "./web/harness.js";

/**
 * The plain-language intake (plan E10; rackbops-bot-plugins slice 3 of the intake design): a DM
 * becomes a turn Job at a fake city-hall, its answer a question or a draft card, and Save makes the
 * task through the task API's create.
 */

afterEach(() => cleanup());
afterAll(() => cleanup());

const HOLD = Symbol("hold");
type Scripted = unknown | typeof HOLD;

const asking = (reply: string) => success({ reply, state: "asking" }, 0.01);
const ready = (reply: string, type: string, fields: Record<string, unknown>) => success({ reply, state: "ready", draft: { action: "create", type, fields } }, 0.01);

/**
 * A world with the intake on and a fake city-hall that answers each turn's Job, in order, with the
 * next scripted result when the intake sleeps between asks; `HOLD` leaves that Job queued.
 */
async function setup(o: { env?: Record<string, string>; script?: Scripted[]; waitMs?: number; cityHall?: boolean } = {}) {
  const city = fakeCityHall();
  const script = [...(o.script ?? [])];
  const logs: string[] = [];
  const w = await world({
    env: { ...(o.cityHall === false ? {} : CITY_HALL), TRACKER_INTAKE: "admins", ...(o.env ?? {}) },
    cityHallFetch: city.fetchImpl,
    logs,
    intakePollMs: 1,
    ...(o.waitMs !== undefined ? { intakeWaitMs: o.waitMs } : {}),
    intakeSleep: async () => {
      const job = city.latest();
      if (!job || job.status !== "queued" || script.length === 0) return;
      const next = script.shift();
      if (next === HOLD) return;
      job.status = "done";
      job.result = next;
    },
  });
  await people(w.plugin);
  let typed = 0;
  const dm = (userId: string, content: string) => w.plugin.directMessage!({ userId, messageId: "1300000000000000001", content, sentAt: START, typing: async () => void typed++ });
  /** What the bot DMed `userId`, with the buttons each carried. */
  const dmsTo = (userId: string) => w.sent.filter((s) => s.userId === userId).map((s) => s.message as { content: string; buttons?: HostButton[] });
  const lastTo = (userId: string) => dmsTo(userId).at(-1);
  const conversations = () =>
    query<{ id: string; user_id: string; status: string; transcript: string; draft: string | null; draft_seq: number; turns: number; task_id: string | null }>(
      w.dbPath,
      "SELECT 'c' || seq AS id, user_id, status, transcript, draft, draft_seq, turns, task_id FROM intake_conversations ORDER BY seq",
    );
  const transcriptOf = (id: string) => JSON.parse(conversations().find((c) => c.id === id)?.transcript ?? "[]") as IntakeLine[];
  return { ...w, city, script, logs, dm, dmsTo, lastTo, conversations, transcriptOf, typed: () => typed };
}

describe("TRACKER_INTAKE and TRACKER_INTAKE_CAPABILITY", () => {
  it("is off unless set to admins or everyone, any case; anything else refuses to load, naming the variable", () => {
    expect(parseIntakeMode(undefined)).toBe("off");
    expect(parseIntakeMode(" ")).toBe("off");
    expect(parseIntakeMode("OFF")).toBe("off");
    expect(parseIntakeMode(" Admins ")).toBe("admins");
    expect(parseIntakeMode("everyone")).toBe("everyone");
    expect(() => parseIntakeMode("yes")).toThrow("TRACKER_INTAKE must be off, admins or everyone");
    expect(parseIntakeCapability(undefined)).toBeNull();
    expect(parseIntakeCapability("claude-cli:intake")).toBe("claude-cli:intake");
    expect(() => parseIntakeCapability("Not A Tag")).toThrow("TRACKER_INTAKE_CAPABILITY");
  });

  it("the manifest declares the DM intent, the two settings with formats that agree with the parsers, and the hook is there", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      botPlugin: { intents: number[]; env: { key: string; format: string; secret: boolean }[] };
    };
    expect(pkg.botPlugin.intents).toEqual([4096]);
    const env = new Map(pkg.botPlugin.env.map((e) => [e.key, e]));
    const mode = new RegExp(env.get("TRACKER_INTAKE")?.format ?? "^$");
    for (const ok of ["", "off", "Admins", " everyone "]) expect(mode.test(ok)).toBe(true);
    for (const bad of ["yes", "admin", "all"]) expect(mode.test(bad)).toBe(false);
    expect(env.get("TRACKER_INTAKE_CAPABILITY")?.secret).toBe(false);
    const w = await setup();
    expect(typeof w.plugin.directMessage).toBe("function");
  });
});

describe("who the intake answers", () => {
  it("off: a DM is not read, and nothing goes to city-hall", async () => {
    const w = await setup({ env: { TRACKER_INTAKE: "off" } });
    await w.dm(ADMIN, "remind me to call Anne");
    expect(w.dmsTo(ADMIN)).toEqual([]);
    expect(w.city.jobs.size).toBe(0);
    expect(w.conversations()).toEqual([]);
  });

  it("admins: a registered person who is not an admin is told it is not open yet; a stranger is told to be allowed first", async () => {
    const w = await setup();
    await w.dm(LARRY, "remind me to call Anne");
    expect(w.lastTo(LARRY)?.content).toBe(NOT_OPEN);
    await w.dm(STRANGER, "hello");
    expect(w.lastTo(STRANGER)?.content).toBe(NOT_ADMITTED);
    expect(w.city.jobs.size).toBe(0);
  });

  it("everyone: a registered person gets a turn", async () => {
    const w = await setup({ env: { TRACKER_INTAKE: "everyone" }, script: [asking("What time?")] });
    await w.dm(LARRY, "remind me to call Anne on Friday");
    expect(w.lastTo(LARRY)?.content).toBe("What time?");
  });

  it("without the execute lane's settings the person is told the assistant is not set up", async () => {
    const w = await setup({ cityHall: false });
    await w.dm(ADMIN, "remind me");
    expect(w.lastTo(ADMIN)?.content).toBe(NO_MODEL);
    expect(w.logs.some((l) => l.includes("TRACKER_INTAKE is admins, but the execute lane is off"))).toBe(true);
  });

  it("a DM with no text asks for words, and runs nothing", async () => {
    const w = await setup();
    await w.dm(ADMIN, "   ");
    expect(w.lastTo(ADMIN)?.content).toBe(TEXT_ONLY);
    expect(w.city.jobs.size).toBe(0);
  });
});

describe("a conversation", () => {
  it("asks, drafts, and Save makes the task as the person, marked made in conversation; each turn is one charged call", async () => {
    const w = await setup({
      script: [
        asking("What time on Friday should I remind you?"),
        ready("A reminder to call Anne on Friday at 9:00.", "reminder", { text: "Call Anne", when: "2026-10-02 09:00" }),
      ],
    });
    await w.dm(ADMIN, "remind me to call Anne on Friday");
    expect(w.lastTo(ADMIN)?.content).toBe("What time on Friday should I remind you?");
    expect(w.typed()).toBeGreaterThan(0);

    // The turn's Job: no tools, one-shot, the intake's caps, the execute lane's tag, the person's words in the prompt.
    const first = w.city.byKey("intake:c1:1");
    expect(first?.capability).toBe(CITY_HALL.TRACKER_CITY_HALL_CAPABILITY);
    const spec = first?.spec as { prompt: string; allowedTools?: string[]; maxTurns?: number; resumeSessionId?: string };
    expect(spec.allowedTools).toEqual([]);
    expect(spec.maxTurns).toBe(INTAKE_MAX_TURNS);
    expect(spec.resumeSessionId).toBeUndefined();
    expect(spec.prompt).toContain("PERSON: remind me to call Anne on Friday");
    expect(spec.prompt).toContain("- reminder");

    await w.dm(ADMIN, "9am");
    const card = w.lastTo(ADMIN);
    expect(card?.content).toBe(`A reminder to call Anne on Friday at 9:00.\n\n${draftText({ action: "create", type: "reminder", fields: { text: "Call Anne", when: "2026-10-02 09:00" } })}`);
    expect(card?.buttons?.map((b) => b.label)).toEqual(["Save", "Change", "Cancel"]);
    expect(card?.buttons?.[0]?.customId).toBe(intakeButtonId("save", "c1", 1));
    // The second turn carried the whole conversation.
    expect((w.city.byKey("intake:c1:2")?.spec as { prompt: string }).prompt).toContain("YOU: What time on Friday should I remind you?\nPERSON: 9am");

    const said = await press(w.plugin, intakeButtonId("save", "c1", 1), ADMIN);
    expect(said.at(-1)).toStartWith("the message\n\n-- Saved.");
    const tasks = query<{ id: string; owner_id: string; type: string; title: string }>(w.dbPath, "SELECT 't' || seq AS id, owner_id, type, title FROM tasks");
    expect(tasks).toEqual([{ id: "t1", owner_id: "u1", type: "reminder", title: "Call Anne" }]);
    expect(w.conversations()).toMatchObject([{ id: "c1", status: "saved", task_id: "t1", draft: null, turns: 2 }]);
    expect(query<{ calls: number; key: string; task_id: string | null }>(w.dbPath, "SELECT calls, key, task_id FROM usage ORDER BY seq")).toEqual([
      { calls: 1, key: "intake:c1:1", task_id: null },
      { calls: 1, key: "intake:c1:2", task_id: null },
    ]);
    // The history says so, on Discord and over the API.
    expect(await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } })).toContain("created: in conversation");
    const token = await makeToken(w, await signIn(w.plugin, ADMIN));
    const read = (await (await api(w.plugin, "GET", "/tasks/t1", { token })).json()) as { history: { changes: { kind: string; detail: string | null }[] } };
    expect(read.history.changes[0]).toMatchObject({ kind: "created", detail: "in conversation" });
    // A Save pressed again finds the draft gone.
    expect((await press(w.plugin, intakeButtonId("save", "c1", 1), ADMIN)).at(-1)).toEndWith(`-- ${STALE}`);
    expect(query(w.dbPath, "SELECT 1 FROM tasks")).toHaveLength(1);
    // The next DM starts a new conversation.
    w.script.push(asking("What would you like to set up?"));
    await w.dm(ADMIN, "hello again");
    expect(w.conversations().map((c) => c.status)).toEqual(["saved", "open"]);
  });

  it("Change takes the card away and asks; Cancel ends it with nothing saved; an older card's buttons do nothing", async () => {
    const w = await setup({
      script: [
        ready("A reminder to call Anne.", "reminder", { text: "Call Anne" }),
        ready("A reminder to call Anne back.", "reminder", { text: "Call Anne back" }),
      ],
    });
    await w.dm(ADMIN, "remind me to call Anne");
    expect((await press(w.plugin, intakeButtonId("change", "c1", 1), ADMIN)).at(-1)).toBe(`the message\n\n-- ${CHANGE_ASK}`);
    expect(w.transcriptOf("c1").at(-1)).toEqual({ from: "bot", text: CHANGE_ASK });
    expect(w.conversations()[0]?.draft).toBeNull();
    await w.dm(ADMIN, "call her back, I mean");
    expect(w.lastTo(ADMIN)?.buttons?.[2]?.customId).toBe(intakeButtonId("cancel", "c1", 2));
    // The first card's Save is stale now.
    expect((await press(w.plugin, intakeButtonId("save", "c1", 1), ADMIN)).at(-1)).toEndWith(`-- ${STALE}`);
    expect((await press(w.plugin, intakeButtonId("cancel", "c1", 2), ADMIN)).at(-1)).toEndWith(`-- ${NOTHING_SAVED}`);
    expect(w.conversations()[0]?.status).toBe("cancelled");
    expect(query(w.dbPath, "SELECT 1 FROM tasks")).toEqual([]);
  });

  it("only the conversation's own person can press its card", async () => {
    const w = await setup({ env: { TRACKER_INTAKE: "everyone" }, script: [ready("A reminder.", "reminder", { text: "Call Anne" })] });
    await w.dm(LARRY, "remind me to call Anne");
    expect((await press(w.plugin, intakeButtonId("save", "c1", 1), CURLY)).at(-1)).toEndWith(`-- ${STALE}`);
    expect(query(w.dbPath, "SELECT 1 FROM tasks")).toEqual([]);
    expect(w.conversations()[0]?.status).toBe("open");
  });

  it("a Save the editor refuses is not made; the person hears why and so does the model next turn", async () => {
    const w = await setup({ script: [ready("A reminder.", "reminder", { text: "Call Anne", when: "not a time" })] });
    await w.dm(ADMIN, "remind me to call Anne at some point");
    const said = (await press(w.plugin, intakeButtonId("save", "c1", 1), ADMIN)).at(-1) ?? "";
    expect(said).toContain("-- Not saved: ");
    expect(said).toEndWith("Tell me what to change, or say stop.");
    expect(query(w.dbPath, "SELECT 1 FROM tasks")).toEqual([]);
    expect(w.transcriptOf("c1").at(-1)?.text).toStartWith("I could not save that: ");
    expect(w.conversations()[0]).toMatchObject({ status: "open", draft: null });
  });

  it("the model's cancel ends the conversation", async () => {
    const w = await setup({ script: [success({ reply: "Okay, never mind.", state: "cancelled" })] });
    await w.dm(ADMIN, "actually forget it");
    expect(w.lastTo(ADMIN)?.content).toBe("Okay, never mind.");
    expect(w.conversations()[0]?.status).toBe("cancelled");
  });

  it("a draft that does not fit is sent back to the model once, unseen; a second miss drops the turn", async () => {
    const w = await setup({
      script: [
        ready("A reminder.", "reminder", { text: "Call Anne", colour: "blue" }),
        ready("A reminder.", "reminder", { text: "Call Anne" }),
      ],
    });
    await w.dm(ADMIN, "remind me to call Anne");
    expect(w.dmsTo(ADMIN).map((d) => d.content)).toHaveLength(1);
    expect(w.lastTo(ADMIN)?.buttons).toHaveLength(3);
    expect((w.city.byKey("intake:c1:2")?.spec as { prompt: string }).prompt).toContain('Your last draft was refused: "colour" is not a create field of a reminder.');
    expect(w.conversations()[0]?.turns).toBe(2);

    w.script.push(success({ reply: "", state: "asking" }), success({ reply: "", state: "asking" }));
    await w.dm(ADMIN, "and another");
    expect(w.lastTo(ADMIN)?.content).toBe(NOT_UNDERSTOOD);
    // The failed turn kept nothing of what was said.
    expect(w.transcriptOf("c1").map((l) => l.text)).toEqual(["remind me to call Anne", "A reminder."]);
  });

  it("a usage limit says the model is busy, keeps nothing and charges nothing", async () => {
    const w = await setup({ script: [{ kind: "usage_limit", detail: "limit", durationMs: 1 }] });
    await w.dm(ADMIN, "remind me to call Anne");
    expect(w.lastTo(ADMIN)?.content).toBe(MODEL_BUSY);
    expect(w.transcriptOf("c1")).toEqual([]);
    expect(query(w.dbPath, "SELECT 1 FROM usage")).toEqual([]);
  });

  it("a turn not answered in time is dropped, and the person told to send it again", async () => {
    const w = await setup({ script: [HOLD], waitMs: 0 });
    await w.dm(ADMIN, "remind me to call Anne");
    expect(w.lastTo(ADMIN)?.content).toBe(TOO_SLOW);
    expect(w.transcriptOf("c1")).toEqual([]);
  });

  it("names TRACKER_INTAKE_CAPABILITY's tag when set", async () => {
    const w = await setup({ env: { TRACKER_INTAKE_CAPABILITY: "claude-cli:intake" }, script: [asking("What?")] });
    await w.dm(ADMIN, "hi");
    expect(w.city.latest()?.capability).toBe("claude-cli:intake");
  });

  it("one turn at a time per person: a DM while one is out is turned away", async () => {
    const w = await setup({ script: [asking("What time?")] });
    // The second arrives while the first waits on city-hall.
    await Promise.all([w.dm(ADMIN, "remind me to call Anne"), w.dm(ADMIN, "on Friday")]);
    expect(w.dmsTo(ADMIN).map((d) => d.content)).toContain(STILL_WORKING);
    expect(w.dmsTo(ADMIN).map((d) => d.content)).toContain("What time?");
  });

  it(`past ${INTAKE_TURN_LIMIT} turns the conversation closes`, async () => {
    const w = await setup();
    w.script.push(...Array.from({ length: INTAKE_TURN_LIMIT }, (_, i) => asking(`Question ${i + 1}?`)));
    for (let i = 0; i < INTAKE_TURN_LIMIT; i++) await w.dm(ADMIN, `answer ${i + 1}`);
    expect(w.lastTo(ADMIN)?.content).toBe(`Question ${INTAKE_TURN_LIMIT}?`);
    await w.dm(ADMIN, "one more");
    expect(w.lastTo(ADMIN)?.content).toBe(tooLong(true));
    expect(w.conversations()[0]?.status).toBe("closed");
    expect(w.city.jobs.size).toBe(INTAKE_TURN_LIMIT);
  });
});

describe("pieces", () => {
  it("words the person's own time for the model", () => {
    expect(localNow("America/New_York", new Date("2026-10-21T13:15:00.000Z"))).toBe("Wednesday 2026-10-21 09:15, America/New_York");
  });

  it("parses only its own button ids", () => {
    expect(parseIntakeId(intakeButtonId("change", "c12", 3))).toEqual({ action: "change", conversationId: "c12", draftSeq: 3 });
    expect(parseIntakeId("tracker:d.o.o1")).toBeNull();
    expect(parseIntakeId("tracker:i.s.t1.1")).toBeNull();
  });

  it("GET /types marks the one field an edit clears with null", async () => {
    const w = await setup();
    const token = await makeToken(w, await signIn(w.plugin, ADMIN));
    const body = (await (await api(w.plugin, "GET", "/types", { token })).json()) as { types: { type: string; edit: { name: string; nullable?: boolean }[] }[] };
    const nullable = body.types.flatMap((t) => t.edit.filter((f) => f.nullable).map((f) => `${t.type}.${f.name}`));
    expect(nullable).toEqual(["wantlist.max"]);
  });
});
