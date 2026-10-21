import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { CREATED_IN_CONVERSATION, INTAKE_IDLE_MS, INTAKE_KEPT_MS, IntakeConversations } from "./intake-store.js";
import { MIGRATIONS, migrate, openDatabase } from "./schema.js";
import { CONFIRM_WORD } from "./web/admin-pages.js";
import { CITY_HALL, fakeCityHall, query, success } from "./web/execute-harness.js";
import { ADMIN, call, cleanup, csrfOf, LARRY, ORIGIN, people, signIn, START, world } from "./web/harness.js";

afterEach(() => cleanup());
afterAll(() => cleanup());

const NOW = new Date(START);
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("migration 12", () => {
  it("adds intake_conversations and its index and nothing else", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 11; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    const before = schema();
    expect(migrate(db)).toBe(11);
    expect(MIGRATIONS).toHaveLength(12);
    expect(schema().filter((s) => !s.name.includes("intake_conversations"))).toEqual(before);
    expect(schema().filter((s) => s.name.includes("intake_conversations")).map((s) => s.name)).toEqual(["intake_conversations", "intake_conversations_open"]);
  });
});

describe("IntakeConversations", () => {
  it("keeps one open conversation per person, and starts a new one after a day idle", () => {
    const convs = new IntakeConversations(openDatabase(":memory:"));
    const c1 = convs.open("u1", NOW);
    expect(c1).toMatchObject({ id: "c1", userId: "u1", status: "open", transcript: [], draft: null, draftSeq: 0, turns: 0 });
    expect(convs.open("u1", later(1000)).id).toBe("c1");
    expect(convs.open("u2", NOW).id).toBe("c2");
    expect(convs.open("u1", later(INTAKE_IDLE_MS + 1)).id).toBe("c3");
    expect(convs.get("c1")?.status).toBe("closed");
  });

  it("numbers each draft anew, takes it away with null, and writes nothing to an ended conversation", () => {
    const convs = new IntakeConversations(openDatabase(":memory:"));
    const c = convs.open("u1", NOW);
    const draft = { action: "create" as const, type: "reminder", fields: { text: "Call Anne" } };
    const lines = [{ from: "person" as const, text: "remind me" }, { from: "bot" as const, text: "Done?" }];
    expect(convs.saveTurn(c.id, lines, draft, NOW)).toMatchObject({ transcript: lines, draft, draftSeq: 1 });
    expect(convs.saveTurn(c.id, lines, draft, NOW)?.draftSeq).toBe(2);
    expect(convs.saveTurn(c.id, lines, null, NOW)).toMatchObject({ draft: null, draftSeq: 2 });
    convs.countTurn(c.id, NOW);
    expect(convs.get(c.id)?.turns).toBe(1);
    expect(convs.end(c.id, "saved", NOW, "t4")).toBe(true);
    expect(convs.end(c.id, "cancelled", NOW)).toBe(false);
    expect(convs.saveTurn(c.id, [], draft, NOW)).toBeNull();
    expect(convs.get(c.id)).toMatchObject({ status: "saved", taskId: "t4", draft: null });
    expect(convs.get("t1")).toBeNull();
  });

  it("takeDraft hands a card's draft to one press only, and only while it is the latest", () => {
    const convs = new IntakeConversations(openDatabase(":memory:"));
    const c = convs.open("u1", NOW);
    const draft = { action: "create" as const, type: "reminder", fields: { text: "Call Anne" } };
    convs.saveTurn(c.id, [], draft, NOW);
    convs.saveTurn(c.id, [], draft, NOW);
    expect(convs.takeDraft(c.id, 1, NOW)).toBeNull();
    expect(convs.takeDraft(c.id, 2, NOW)).toMatchObject({ draft, draftSeq: 2 });
    expect(convs.takeDraft(c.id, 2, NOW)).toBeNull();
    expect(convs.get(c.id)).toMatchObject({ status: "open", draft: null, draftSeq: 2 });
    convs.saveTurn(c.id, [], draft, NOW);
    convs.end(c.id, "cancelled", NOW);
    expect(convs.takeDraft(c.id, 3, NOW)).toBeNull();
    expect(convs.takeDraft("t1", 3, NOW)).toBeNull();
  });

  it("an idle conversation closed by open() keeps no draft", () => {
    const convs = new IntakeConversations(openDatabase(":memory:"));
    const c = convs.open("u1", NOW);
    convs.saveTurn(c.id, [], { action: "create", type: "reminder", fields: { text: "x" } }, NOW);
    convs.open("u1", later(INTAKE_IDLE_MS + 1));
    expect(convs.get(c.id)).toMatchObject({ status: "closed", draft: null });
  });

  it("purge closes the idle and deletes what ended over a week ago", () => {
    const convs = new IntakeConversations(openDatabase(":memory:"));
    const idle = convs.open("u1", NOW);
    const ended = convs.open("u2", NOW);
    convs.end(ended.id, "cancelled", NOW);
    expect(convs.purge(later(INTAKE_IDLE_MS + 1))).toBe(0);
    expect(convs.get(idle.id)?.status).toBe("closed");
    expect(convs.purge(later(INTAKE_KEPT_MS + 1))).toBe(1);
    expect(convs.get(ended.id)).toBeNull();
    expect(convs.purge(later(INTAKE_IDLE_MS + INTAKE_KEPT_MS + 2))).toBe(1);
    expect(convs.get(idle.id)).toBeNull();
  });

  it("marks a task's created row once, leaving every other row alone", () => {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO task_events (task_id, actor_id, kind, detail, at) VALUES
      ('t1', 'u1', 'created', 'reminder', '${START}'), ('t1', 'u1', 'edited', 'reminder', '${START}'), ('t2', 'u1', 'created', 'reminder', '${START}')`);
    const convs = new IntakeConversations(db);
    convs.markCreatedInConversation("t1");
    convs.markCreatedInConversation("t1");
    expect(db.query("SELECT task_id, kind, detail FROM task_events ORDER BY seq").all()).toEqual([
      { task_id: "t1", kind: "created", detail: `reminder${CREATED_IN_CONVERSATION}` },
      { task_id: "t1", kind: "edited", detail: "reminder" },
      { task_id: "t2", kind: "created", detail: "reminder" },
    ]);
  });
});

describe("markEditedInConversation", () => {
  it("marks the task's newest edited row once, and nothing else", () => {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO task_events (task_id, actor_id, kind, detail, at) VALUES
      ('t1', 'u1', 'created', 'reminder', '${START}'), ('t1', 'u1', 'edited', 'text', '${START}'), ('t1', 'u1', 'edited', 'when', '${START}'), ('t2', 'u1', 'edited', 'text', '${START}')`);
    const convs = new IntakeConversations(db);
    convs.markEditedInConversation("t1");
    convs.markEditedInConversation("t1");
    expect(db.query("SELECT task_id, kind, detail FROM task_events ORDER BY seq").all()).toEqual([
      { task_id: "t1", kind: "created", detail: "reminder" },
      { task_id: "t1", kind: "edited", detail: "text" },
      { task_id: "t1", kind: "edited", detail: `when${CREATED_IN_CONVERSATION}` },
      { task_id: "t2", kind: "edited", detail: "text" },
    ]);
  });
});

describe("forget-me", () => {
  it("erases the person's intake conversations, transcripts and all", async () => {
    const city = fakeCityHall();
    const w = await world({
      env: { ...CITY_HALL, TRACKER_INTAKE: "everyone" },
      cityHallFetch: city.fetchImpl,
      intakePollMs: 1,
      intakeSleep: async () => {
        const job = city.latest();
        if (job && job.status === "queued") {
          job.status = "done";
          job.result = success({ reply: "What time?", state: "asking" }, 0.01);
        }
      },
    });
    await people(w.plugin);
    const dm = (userId: string, content: string) => w.plugin.directMessage!({ userId, messageId: "1", content, sentAt: START, typing: async () => {} });
    await dm(LARRY, "remind me to call Anne, my sister");
    await dm(ADMIN, "remind me to water the plants");
    expect(query<{ user_id: string }>(w.dbPath, "SELECT user_id FROM intake_conversations ORDER BY seq")).toEqual([{ user_id: "u2" }, { user_id: "u1" }]);
    const larry = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, larry);
    const done = await call(w.plugin, "POST", "/forget", { jar: larry, form: { csrf, confirm: "yes", word: CONFIRM_WORD }, origin: ORIGIN });
    expect(done.status).toBe(303);
    expect(query<{ user_id: string }>(w.dbPath, "SELECT user_id FROM intake_conversations")).toEqual([{ user_id: "u1" }]);
    expect(query(w.dbPath, "SELECT 1 FROM intake_conversations WHERE transcript LIKE '%sister%'")).toEqual([]);
  });
});
