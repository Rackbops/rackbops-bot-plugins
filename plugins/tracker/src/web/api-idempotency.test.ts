import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { MIGRATIONS, migrate, openDatabase } from "../schema.js";
import { CONFIRM_WORD } from "./admin-pages.js";
import { canonicalJson } from "./api.js";
import { ApiIdempotency, KEEP_MS, OUTCOME_UNKNOWN, PENDING_MS } from "./api-idempotency.js";
import { api, call, cleanup, csrfOf, CURLY, LARRY, makeToken, ORIGIN, people, signIn, slash, START, world } from "./harness.js";
import { VERSION_MISMATCH } from "./task-version.js";

/**
 * The task API's idempotent writes and version checks (rackbops-bot-plugins#369, for the ChatGPT
 * client of #368): `Idempotency-Key` makes a retried write one write, `If-Match` makes a write
 * conditional on the version the client last read.
 */

afterEach(cleanup);

const tick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

function query<T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const taskCount = (dbPath: string) => query<{ n: number }>(dbPath, "SELECT COUNT(*) AS n FROM tasks")[0]?.n;

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, larry, token };
}

const REMIND = { type: "reminder", text: "water the plants", when: "tomorrow 9am", repeat: "week" };

describe("migration 13", () => {
  it("adds api_idempotency and its index and nothing else", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 12; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    const before = schema();
    expect(migrate(db)).toBe(12);
    expect(MIGRATIONS).toHaveLength(13);
    expect(schema().filter((s) => !s.name.includes("api_idempotency"))).toEqual(before);
    expect(schema().filter((s) => s.name.includes("api_idempotency")).map((s) => s.name)).toEqual(["api_idempotency", "api_idempotency_created", "sqlite_autoindex_api_idempotency_1"]);
  });
});

describe("ApiIdempotency", () => {
  const NOW = new Date(START);
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it("claims a key once; a second claim while the first runs is in progress; a finished 2xx replays", () => {
    const keys = new ApiIdempotency(openDatabase(":memory:"));
    const first = keys.begin("u1", "key-00001", "h1", NOW);
    expect(first).toEqual({ kind: "new", claim: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const claim = (first as { claim: string }).claim;
    expect(keys.begin("u1", "key-00001", "h1", at(1000))).toEqual({ kind: "in_progress" });
    expect(keys.begin("u1", "key-00001", "h2", at(1000))).toEqual({ kind: "conflict" });
    keys.finish("u1", "key-00001", claim, { status: 201, body: { task: { id: "t1" } }, headers: { Location: "/x" } });
    expect(keys.begin("u1", "key-00001", "h1", at(2000))).toEqual({ kind: "replay", answer: { status: 201, body: { task: { id: "t1" } }, headers: { Location: "/x" } } });
    // Another person's same key is theirs alone.
    expect(keys.begin("u2", "key-00001", "h9", at(2000)).kind).toBe("new");
  });

  it("drops a refusal's claim, so a retry runs again; a claim that never finished stops blocking after PENDING_MS", () => {
    const keys = new ApiIdempotency(openDatabase(":memory:"));
    const c = keys.begin("u1", "key-00002", "h1", NOW) as { claim: string };
    keys.finish("u1", "key-00002", c.claim, { status: 400, body: { error: {} }, headers: {} });
    expect(keys.begin("u1", "key-00002", "h2", at(1)).kind).toBe("new");
    expect(keys.begin("u1", "key-00002", "h2", at(PENDING_MS - 1)).kind).toBe("in_progress");
    expect(keys.begin("u1", "key-00002", "h3", at(PENDING_MS + 1)).kind).toBe("new");
  });

  it("forgets a key after KEEP_MS", () => {
    const keys = new ApiIdempotency(openDatabase(":memory:"));
    const c = keys.begin("u1", "key-00003", "h1", NOW) as { claim: string };
    keys.finish("u1", "key-00003", c.claim, { status: 200, body: {}, headers: {} });
    expect(keys.begin("u1", "key-00003", "h2", at(KEEP_MS - 1)).kind).toBe("conflict");
    expect(keys.begin("u1", "key-00003", "h2", at(KEEP_MS + 1)).kind).toBe("new");
  });

  it("a slow request whose key was taken over cannot finish or drop the new claim", () => {
    const keys = new ApiIdempotency(openDatabase(":memory:"));
    const slow = keys.begin("u1", "key-00004", "h1", NOW) as { claim: string };
    const next = keys.begin("u1", "key-00004", "h1", at(PENDING_MS + 1)) as { claim: string };
    expect(next.claim).not.toBe(slow.claim);
    keys.finish("u1", "key-00004", slow.claim, { status: 201, body: { stale: true }, headers: {} });
    keys.abandon("u1", "key-00004", slow.claim);
    expect(keys.begin("u1", "key-00004", "h1", at(PENDING_MS + 2)).kind).toBe("in_progress");
    keys.finish("u1", "key-00004", next.claim, { status: 201, body: { fresh: true }, headers: {} });
    expect(keys.begin("u1", "key-00004", "h1", at(PENDING_MS + 3))).toEqual({ kind: "replay", answer: { status: 201, body: { fresh: true }, headers: {} } });
  });

  it("a request that threw answers outcome_unknown to a retry instead of running again", () => {
    const keys = new ApiIdempotency(openDatabase(":memory:"));
    const c = keys.begin("u1", "key-00005", "h1", NOW) as { claim: string };
    keys.fail("u1", "key-00005", c.claim);
    expect(keys.begin("u1", "key-00005", "h1", at(PENDING_MS + 1))).toEqual({
      kind: "replay",
      answer: { status: 500, body: { error: { code: "outcome_unknown", message: OUTCOME_UNKNOWN } }, headers: {} },
    });
  });

  it("hashes a body the same whatever the order of its keys", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: "s" } })).toBe(canonicalJson({ a: { c: "s", d: [2, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});

describe("Idempotency-Key", () => {
  it("a retried create with the same key makes one task and answers the first answer again", async () => {
    const w = await setup();
    const headers = { "idempotency-key": "6f1c2a9e-0d1b-4c7e-9a55-2b8e3d4f5a60" };
    const first = await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    const made = await body(first);
    // The same request, its keys in another order.
    const again = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { repeat: "week", when: "tomorrow 9am", text: "water the plants", type: "reminder" }, headers });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(again.headers.get("location")).toBe(first.headers.get("location"));
    expect(await body(again)).toEqual(made);
    expect(taskCount(w.dbPath)).toBe(1);
    // A new key is a new write.
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers: { "idempotency-key": "another-key-1" } })).status).toBe(201);
    expect(taskCount(w.dbPath)).toBe(2);
  });

  it("the same key for a different request is refused and writes nothing", async () => {
    const w = await setup();
    const headers = { "idempotency-key": "key-for-one-thing" };
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers });
    const other = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { ...REMIND, text: "something else" }, headers });
    expect(other.status).toBe(409);
    expect((await body(other)).error.code).toBe("idempotency_conflict");
    // Another path with the same key is another request too.
    const paused = await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {}, headers });
    expect(paused.status).toBe(409);
    expect(taskCount(w.dbPath)).toBe(1);
    expect(query<{ status: string }>(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "active" }]);
  });

  it("a refused write keeps no answer: the same key with a corrected body then makes the task", async () => {
    const w = await setup();
    const headers = { "idempotency-key": "key-after-a-refusal" };
    const refused = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "reminder", text: "x", when: "not a time at all" }, headers });
    expect(refused.status).toBe(400);
    expect(taskCount(w.dbPath)).toBe(0);
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers })).status).toBe(201);
    expect(taskCount(w.dbPath)).toBe(1);
  });

  it("a key is the sender's own: Curly's same key makes Curly's own task", async () => {
    const w = await setup();
    const curly = await signIn(w.plugin, CURLY);
    const curlyToken = await makeToken(w, curly, "curly-agent");
    const headers = { "idempotency-key": "shared-looking-key" };
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers })).status).toBe(201);
    const theirs = await api(w.plugin, "POST", "/tasks", { token: curlyToken, body: REMIND, headers });
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("idempotency-replayed")).toBeNull();
    expect(query<{ owner_id: string }>(w.dbPath, "SELECT owner_id FROM tasks ORDER BY seq").map((r) => r.owner_id)).toEqual(["u2", "u3"]);
  });

  it("a malformed key is refused before anything is read or written", async () => {
    const w = await setup();
    for (const key of ["short", "has space in it", "x".repeat(129), "naughty/slash"]) {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers: { "idempotency-key": key } });
      expect(res.status).toBe(400);
      expect((await body(res)).error.code).toBe("invalid_idempotency_key");
    }
    expect(taskCount(w.dbPath)).toBe(0);
  });

  it("DELETE with a key: the retry answers the first delete again instead of 404", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const headers = { "idempotency-key": "delete-t1-once" };
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token, headers })).status).toBe(200);
    const again = await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token, headers });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token })).status).toBe(404);
  });

  it("the same key and body under another If-Match version is another request", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const v1 = (await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.version as string;
    const key = { "idempotency-key": "pause-with-a-version" };
    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {}, headers: { ...key, "if-match": `"${v1}"` } })).status).toBe(200);
    const other = await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {}, headers: { ...key, "if-match": '"0123456789abcdef"' } });
    expect(other.status).toBe(409);
    expect((await body(other)).error.code).toBe("idempotency_conflict");
  });

  it("forget-me erases a person's keys and kept answers", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers: { "idempotency-key": "larry-key-0001" } });
    expect(query<{ user_id: string }>(w.dbPath, "SELECT user_id FROM api_idempotency")).toEqual([{ user_id: "u2" }]);
    const csrf = await csrfOf(w.plugin, w.larry);
    const done = await call(w.plugin, "POST", "/forget", { jar: w.larry, form: { csrf, confirm: "yes", word: CONFIRM_WORD }, origin: ORIGIN });
    expect(done.status).toBe(303);
    expect(query(w.dbPath, "SELECT 1 FROM api_idempotency")).toEqual([]);
  });
});

describe("If-Match", () => {
  it("GET gives the task's version as its ETag; a write with that version goes through and moves it", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const read = await api(w.plugin, "GET", "/tasks/t1", { token: w.token });
    const { task } = await body(read);
    expect(task.version).toMatch(/^[0-9a-f]{16}$/);
    expect(read.headers.get("etag")).toBe(`"${task.version}"`);
    const saved = await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { text: "water the ferns" }, headers: { "if-match": `"${task.version}"` } });
    expect(saved.status).toBe(200);
    const after = (await body(saved)).task;
    expect(after.version).not.toBe(task.version);
    expect(saved.headers.get("etag")).toBe(`"${after.version}"`);
    // GET /tasks shows the same version.
    expect((await body(await api(w.plugin, "GET", "/tasks", { token: w.token }))).tasks[0].version).toBe(after.version);
  });

  it("a stale version is 412 and changes nothing, for an edit, a pause and a delete", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const stale = (await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.version as string;
    await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { text: "changed elsewhere" } });
    const before = query(w.dbPath, "SELECT title, config, status FROM tasks");
    const headers = { "if-match": `"${stale}"` };
    for (const [method, path, b] of [["PATCH", "/tasks/t1", { text: "mine" }], ["POST", "/tasks/t1/pause", {}], ["DELETE", "/tasks/t1", undefined]] as const) {
      const res = await api(w.plugin, method, path, { token: w.token, headers, ...(b !== undefined ? { body: b } : {}) });
      expect(res.status).toBe(412);
      expect(await body(res)).toEqual({ error: { code: "version_mismatch", message: VERSION_MISMATCH } });
    }
    expect(query(w.dbPath, "SELECT title, config, status FROM tasks")).toEqual(before);
  });

  it("a padded task id is checked like the plain one", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const stale = (await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.version as string;
    await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { text: "changed elsewhere" } });
    const headers = { "if-match": `"${stale}"` };
    for (const [method, path, b] of [["PATCH", "/tasks/%20t1", { text: "mine" }], ["POST", "/tasks/%20t1/pause", {}], ["DELETE", "/tasks/t1%20", undefined]] as const) {
      const res = await api(w.plugin, method, path, { token: w.token, headers, ...(b !== undefined ? { body: b } : {}) });
      expect(res.status).toBe(412);
    }
    expect(query(w.dbPath, "SELECT title, status FROM tasks")).toEqual([{ title: "changed elsewhere", status: "active" }]);
  });

  it("a run of the task does not move its version", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins", when: "in 5 minutes", repeat: "day" } });
    const before = (await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.version;
    w.clock.advance(10 * 60 * 1000);
    await tick(w.plugin);
    expect(query<{ n: number }>(w.dbPath, "SELECT COUNT(*) AS n FROM occurrences WHERE task_id = 't1' AND status = 'done'")[0]?.n).toBe(1);
    expect((await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.version).toBe(before);
  });

  it("is refused where it means nothing, and when it names no version this API makes", async () => {
    const w = await setup();
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND });
    const create = await api(w.plugin, "POST", "/tasks", { token: w.token, body: REMIND, headers: { "if-match": '"0123456789abcdef"' } });
    expect(create.status).toBe(400);
    expect((await body(create)).error.code).toBe("if_match_unsupported");
    for (const bad of ["*", "0123456789abcdef", 'W/"0123456789abcdef"', '"short"']) {
      const res = await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { text: "x" }, headers: { "if-match": bad } });
      expect(res.status).toBe(400);
      expect((await body(res)).error.code).toBe("invalid_if_match");
    }
    expect(taskCount(w.dbPath)).toBe(1);
  });
});
