import { Database } from "bun:sqlite";

/**
 * The tracker's own SQLite schema (plan 5.2, rev17): a fresh store in the plugin's data file,
 * behind docket's Store port, plus the tracker-only tables (admissions, delivery health, the web
 * area's sign-in). Each migration runs once, in order, recorded in `PRAGMA user_version`; a shipped
 * migration is never edited, only followed by a new one -- so migration 1 still creates the
 * `usr_subject` column and the `delivery_claims` table that migration 5 takes away.
 *
 * Every table has an `seq INTEGER PRIMARY KEY AUTOINCREMENT`: the public id is a one-letter prefix
 * plus that number (`u1`, `t12`, the same shape as docket's MemoryStore), which carries no dot, so
 * it fits a reply reference, and AUTOINCREMENT never reuses a number after a delete. Instants are
 * ISO-8601 UTC strings, compared as text, exactly as MemoryStore compares them. JSON columns hold
 * `JSON.stringify` output.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    usr_subject TEXT,
    display_name TEXT,
    time_zone TEXT NOT NULL,
    preferred_hour INTEGER NOT NULL,
    admin INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX users_discord_id ON users (discord_id) WHERE discord_id IS NOT NULL;
  CREATE INDEX users_usr_subject ON users (usr_subject);

  CREATE TABLE tasks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    config TEXT NOT NULL,
    state TEXT NOT NULL,
    schedule TEXT NOT NULL,
    lane TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_owner ON tasks (owner_id);

  CREATE TABLE task_recipients (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL,
    at TEXT NOT NULL,
    UNIQUE (task_id, user_id)
  );

  CREATE TABLE invite_blocks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    expires_at TEXT,
    decline_reply_id TEXT,
    lifted_by TEXT,
    lifted_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX invite_blocks_pair ON invite_blocks (owner_id, recipient_id);

  CREATE TABLE occurrences (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    due_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    status TEXT NOT NULL,
    late INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    summary TEXT,
    cost_usd REAL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX occurrences_due ON occurrences (status, lane, due_at);
  CREATE INDEX occurrences_task ON occurrences (task_id);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX events_occurrence ON events (occurrence_id, seq);

  CREATE TABLE task_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    actor_id TEXT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX task_events_task ON task_events (task_id, seq);

  CREATE TABLE replies (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_id TEXT,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX replies_task ON replies (task_id, seq);

  CREATE TABLE series (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    note TEXT
  );
  CREATE INDEX series_task ON series (task_id, at);

  CREATE TABLE delivery_claims (
    occurrence_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message_id TEXT,
    channel_id TEXT,
    error TEXT,
    claimed_at TEXT NOT NULL,
    settled_at TEXT,
    reported_at TEXT,
    PRIMARY KEY (occurrence_id, user_id)
  );
  `,
  // 2 (rackbops-bot-plugins#79): who admitted each person and when they registered (plan 5.8), and
  // each person's run of failed DMs with the tasks a pause stopped (plan 5.5). 0.1.0 had no
  // commands: its only way to make a person was `TRACKER_ADMIN_DISCORD_IDS`, so every user row it
  // left is backfilled as admitted by the configuration (`admitted_by` NULL), not yet registered.
  `
  CREATE TABLE admissions (
    user_id TEXT PRIMARY KEY,
    admitted_by TEXT,
    admitted_at TEXT NOT NULL,
    registered_at TEXT
  );
  INSERT INTO admissions (user_id, admitted_by, admitted_at, registered_at)
    SELECT 'u' || seq, NULL, created_at, NULL FROM users;

  CREATE TABLE delivery_health (
    user_id TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    last_error TEXT,
    last_failed_at TEXT,
    paused_at TEXT
  );

  CREATE TABLE delivery_pauses (
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );
  `,
  // 3 (rackbops-bot-plugins#80): the web area's sign-in (plan 5.10, item 41). A one-time link's
  // token and a session's id are stored only as their SHA-256, so a copy of the database signs
  // nobody in. `used_at` makes a link single use; the CSRF token is per session.
  // `member_checked_at` is when the person was last confirmed a member of `TRACKER_GUILD_ID`
  // (null with no gate): set by `/web`, carried to the session, refreshed by the web area.
  `
  CREATE TABLE web_login_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    member_checked_at TEXT
  );
  CREATE INDEX web_login_tokens_expiry ON web_login_tokens (expires_at);

  CREATE TABLE web_sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    member_checked_at TEXT
  );
  CREATE INDEX web_sessions_user ON web_sessions (user_id);
  CREATE INDEX web_sessions_expiry ON web_sessions (expires_at);
  `,
  // 4 (rackbops-bot-plugins#80, slice 4): personal API tokens for the task API (plan 5.10, E10). A
  // token is stored only as its SHA-256, like a session id; `seq` is its public id (`k<n>`). Null
  // `expires_at` never expires. `member_checked_at` is carried from the session that made it and
  // refreshed with the person's sessions. A database at 4 is refused by 0.6.0 and older (their
  // `migrate` throws on a newer schema), so this blocks a rollback.
  `
  CREATE TABLE api_tokens (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    member_checked_at TEXT
  );
  CREATE INDEX api_tokens_user ON api_tokens (user_id);
  `,
  // 5 (docket 0.4.0, Rackbops/docket#18): what docket's Store port asks of a host since 0.4.0.
  // - `occurrences.record`: a run's outcome as JSON, set when it fires (null before; every row an
  //   older plugin wrote stays null, which docket reads as a run that has not fired or, once done,
  //   one that finished before records existed).
  // - `series.key`: a run's point identity, unique when set, so an outcome applied twice appends
  //   once. Older points keep null.
  // - `deliveries`: one row per (run, person), docket's delivery claim. The tracker's own
  //   `delivery_claims` (0.1.0 to 0.8.0) is copied into it and dropped, so a DM a claim says went
  //   out, or may have, is never sent again: `sent` stays sent; `failed` becomes failed for good
  //   (one attempt); an `unconfirmed` the old plugin already reported (`reported_at` set) stays
  //   `unconfirmed`. A `claimed` row, and an `unconfirmed` one never reported, become docket's
  //   `claimed` (its error kept), so the first start's `recover()` settles each unconfirmed and
  //   `activate` logs it once -- the report 0.8.0 owed. None of them is owed (`retry_at` null), so
  //   none is ever resent. `seq` keeps insertion order for rows planned at one instant.
  // - `usage` and `notices`: docket's model-run charges and its once-only notice keys (budget.ts),
  //   which the execute lane writes; the tracker runs no execute lane yet, so both stay empty.
  // - `users.usr_subject` goes (people are not usr accounts, plan item 40): its index first, as
  //   SQLite drops no indexed column. Never written by any release, so nothing is lost.
  // A database at 5 is refused by 0.8.0 and older (their `migrate` throws on a newer schema).
  `
  ALTER TABLE occurrences ADD COLUMN record TEXT;

  ALTER TABLE series ADD COLUMN key TEXT;
  CREATE UNIQUE INDEX series_key ON series (key) WHERE key IS NOT NULL;

  CREATE TABLE deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message_id TEXT,
    error TEXT,
    attempts INTEGER NOT NULL,
    deferrals INTEGER NOT NULL,
    retry_at TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    settled_at TEXT,
    UNIQUE (occurrence_id, user_id)
  );
  CREATE INDEX deliveries_user ON deliveries (user_id);
  CREATE INDEX deliveries_owed ON deliveries (retry_at) WHERE retry_at IS NOT NULL;
  CREATE INDEX deliveries_status ON deliveries (status);
  INSERT INTO deliveries (occurrence_id, user_id, status, message_id, error, attempts, deferrals, retry_at, created_at, claimed_at, settled_at)
    SELECT occurrence_id, user_id,
      CASE
        WHEN status IN ('sent', 'failed') THEN status
        WHEN status = 'unconfirmed' AND reported_at IS NOT NULL THEN 'unconfirmed'
        ELSE 'claimed'
      END,
      message_id, error,
      CASE WHEN status = 'failed' THEN 1 ELSE 0 END,
      0, NULL, claimed_at, claimed_at,
      CASE
        WHEN status IN ('sent', 'failed') OR (status = 'unconfirmed' AND reported_at IS NOT NULL)
          THEN COALESCE(settled_at, claimed_at)
        ELSE NULL
      END
    FROM delivery_claims ORDER BY claimed_at, occurrence_id, user_id;
  DROP TABLE delivery_claims;

  CREATE TABLE usage (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    task_id TEXT,
    occurrence_id TEXT,
    source TEXT NOT NULL,
    calls INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX usage_user ON usage (user_id, at);

  CREATE TABLE notices (
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );

  DROP INDEX users_usr_subject;
  ALTER TABLE users DROP COLUMN usr_subject;
  `,
  // 6 (docket 0.5.0, Rackbops/docket#21; the research type, rackbops-bot-plugins#82): purely additive.
  // - `findings`: a run's stored claims (plan 5.2, item 37), oldest first by `at` then `seq`;
  //   `key` unique when set, so an outcome applied twice stores each finding once. Indexed by task
  //   (the task page) and by owner (forget-me).
  // - `usage.key`: a run's charge keyed by its Job key, unique when set, so a crash between the
  //   charge and the run's record never charges one call twice. Older rows keep null.
  // - `executor_jobs`: the city-hall Executor's own record (executor.ts), the Job key a run submitted
  //   under and the job id city-hall gave it, written before the first ask returns, so a later ask
  //   (docket passes no spec then) finds the Job again. `occurrence_id` is the run, for forget-me;
  //   `paused_at` is when the Job was first seen requeued by a stopped runner (executor.ts).
  // docket asks for an index on `events(occurrence_id)`: migration 1's `events_occurrence` on
  // (occurrence_id, seq) already serves it. A database at 6 is refused by 0.10.0 and older.
  `
  CREATE TABLE findings (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    occurrence_id TEXT,
    key TEXT,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    tags TEXT NOT NULL,
    source TEXT,
    at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX findings_key ON findings (key) WHERE key IS NOT NULL;
  CREATE INDEX findings_task ON findings (task_id);
  CREATE INDEX findings_owner ON findings (owner_id);

  ALTER TABLE usage ADD COLUMN key TEXT;
  CREATE UNIQUE INDEX usage_key ON usage (key) WHERE key IS NOT NULL;

  CREATE TABLE executor_jobs (
    job_key TEXT PRIMARY KEY,
    occurrence_id TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    paused_at TEXT
  );
  CREATE INDEX executor_jobs_occurrence ON executor_jobs (occurrence_id);
  `,
  // 7 (0.13.0; an admin raises a person's ceiling, plan 5.7, rackbops-bot-plugins#82): purely
  // additive, one new table and its index; no existing table or row is touched.
  // - `ceiling_changes`: every change an admin makes to a person's daily ceiling, append-only
  //   (ceilings.ts). The newest row per person is their ceiling; both values null is "back to the
  //   default", so the two are set together or not at all. `set_by` is the admin's id, `forgotten`
  //   once that admin is erased (roster.ts). A database at 7 is refused by 0.12.0 and older.
  `
  CREATE TABLE ceiling_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    usd REAL,
    calls INTEGER,
    set_by TEXT NOT NULL,
    at TEXT NOT NULL,
    CHECK ((usd IS NULL) = (calls IS NULL))
  );
  CREATE INDEX ceiling_changes_user ON ceiling_changes (user_id, seq);
  `,
  // 8 (0.19.0; listings sent in for a want-list watch, docket-types 0.7.0's `inbox` source): purely
  // additive, one new table and its two indexes; no existing table or row is touched.
  // - `want_inbox`: each listing sent in for an inbox watch (inbox.ts), oldest first by `seq`, as
  //   the JSON of the six fields docket-types' `Submitted` has, already cleaned and capped. `key` is
  //   the watch's inbox key (its config's `target`, `ebay-...` or `bgg-...`), what the source reads
  //   by; `task_id` is the watch, for forget-me (roster.ts). At most `MAX_INBOX_ROWS` rows per key are
  //   kept: the oldest go as new ones arrive. A database at 8 is refused by 0.18.1 and older.
  `
  CREATE TABLE want_inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    key TEXT NOT NULL,
    listing TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX want_inbox_key ON want_inbox (key, seq);
  CREATE INDEX want_inbox_task ON want_inbox (task_id);
  `,
  // 9 (0.20.0; people linked to our usr, Rod's "Wire it" of 2026-10-07, reversing item 40's usr
  // half): purely additive, one nullable column and its index; no existing row is changed.
  // - `users.usr_subject`: the person's usr user id (usr's `sub`, an opaque UUID), learned from usr's
  //   `/api/discord/allow` (usr.ts); null until they are linked, and always null while the usr link
  //   is off. Unique when set: one usr account is one person. A database at 9 is refused by 0.19.0
  //   and older.
  `
  ALTER TABLE users ADD COLUMN usr_subject TEXT;
  CREATE UNIQUE INDEX users_usr_subject ON users (usr_subject) WHERE usr_subject IS NOT NULL;
  `,
];

/** How long a statement waits on another connection's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/** Brings `db` up to the newest schema. Idempotent; each step runs in its own transaction. Returns the version it found. */
export function migrate(db: Database): number {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`tracker database is at schema ${current}, newer than this plugin knows (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
  return current;
}

/** Opens (creating if absent) the tracker's database file and migrates it. `":memory:"` for tests. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Forget-me (roster.ts): a deleted row's bytes are overwritten, not left in a free page.
    db.exec("PRAGMA secure_delete = ON");
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Housekeeping state kept outside the versioned schema: a key/value table made IF NOT EXISTS, never
 * by a migration, so `PRAGMA user_version` stays what the tables are and an older plugin (0.5.0),
 * which checks only `user_version` and never reads this table, still opens the database after a
 * downgrade. Not a person's data: forget-me has nothing to erase here.
 */
export const META_TABLE = "tracker_meta";
const VACUUMED = "vacuumed_for_secure_delete";

export type VacuumOutcome = { ran: false } | { ran: true } | { ran: false; error: string };

/**
 * The one VACUUM forget-me needs (rackbops-bot-plugins#80, slice 3): `secure_delete` (on since
 * 0.6.0) overwrites only what is deleted after it is on, so pages freed earlier (0.5.0's deletes of
 * queued runs, sessions, sign-in links) could still hold old bytes until the file is rewritten.
 * Once per database: the marker is written only after the VACUUM and the log's checkpoint succeed,
 * so a failure (a reader holding the file, a full disk) is reported, not thrown, and the next start
 * tries again. It does not wait on another connection (busy_timeout 0 for the duration), so a
 * reader cannot stall activation. Not after every erasure: a VACUUM rewrites the whole file under an
 * exclusive lock -- a stall of the bot's one write queue each time -- and `secure_delete` already
 * covers every later delete.
 */
export function vacuumOnce(db: Database, path: string): VacuumOutcome {
  if (path === ":memory:") return { ran: false };
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    if (db.query(`SELECT 1 FROM ${META_TABLE} WHERE key = ?`).get(VACUUMED) !== null) return { ran: false };
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("VACUUM");
      const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
      if (r && Number(r.busy) !== 0) throw new Error("the write-ahead log is busy");
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    db.query(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(VACUUMED, new Date().toISOString());
    return { ran: true };
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) };
  }
}
