import { Database } from "bun:sqlite";

/**
 * The tracker's own SQLite schema (plan 5.2, rev17): a fresh store in the plugin's data file,
 * behind docket's Store port, plus the tracker-only `delivery_claims` table (plan 5.5). Each
 * migration runs once, in order, recorded in `PRAGMA user_version`; a shipped migration is never
 * edited, only followed by a new one.
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
  // 4 (rackbops-bot-plugins#80, slice 3): no table changes. It marks the one-time VACUUM that
  // `openDatabase` runs when it brings a database past this step: forget-me needs deleted rows gone
  // from the file, and `secure_delete` (on since 0.6.0) overwrites only what is deleted after it is
  // on -- pages freed before (by 0.5.0's deletes of queued runs, sessions, sign-in links) could still
  // hold old bytes. A VACUUM cannot run inside the migration's transaction, hence the marker.
  `
  SELECT 1;
  `,
];

/** How long a statement waits on another connection's lock before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/** The migration after which `openDatabase` runs its one VACUUM (see migration 4). */
export const VACUUM_AT = 4;

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
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // Forget-me (roster.ts): a deleted row's bytes are overwritten, not left in a free page.
  db.exec("PRAGMA secure_delete = ON");
  const found = migrate(db);
  // Once, when a database that existed before migration 4 first opens here: rewrites the file, so
  // no page freed before `secure_delete` was on keeps old bytes; then the log is emptied. Not after
  // every erasure: from here on `secure_delete` covers each delete, and a VACUUM rewrites the whole
  // file under an exclusive lock -- a stall of the bot's one write queue on each forget-me for no
  // gain. A brand-new database has nothing to clear.
  if (path !== ":memory:" && found > 0 && found < VACUUM_AT) {
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  return db;
}
