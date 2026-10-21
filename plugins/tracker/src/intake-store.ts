import type { Database } from "bun:sqlite";
import type { IntakeDraft, IntakeLine } from "@rackbops/docket-types";

/**
 * The intake's conversations (intake.ts; schema migration 12): one row per DM conversation, with the
 * whole transcript the tracker keeps and sends each turn (Rod, 2026-10-19, "Clerk keeps it"), so no
 * turn's model run keeps a session. A person has at most one open conversation. An open one idle for
 * `INTAKE_IDLE_MS` closes; an ended one goes `INTAKE_KEPT_MS` after it ended (`purge`), and forget-me
 * deletes a person's at once (roster.ts).
 */

/** A conversation left this long since its last turn closes; the person's next DM starts a new one. */
export const INTAKE_IDLE_MS = 24 * 60 * 60 * 1000;
/** How long an ended conversation's transcript is kept. */
export const INTAKE_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** What a `created` or `edited` history row's detail ends with when a conversation made the task or the change. */
export const CREATED_IN_CONVERSATION = " in conversation";

export type IntakeStatus = "open" | "saved" | "cancelled" | "closed";

export interface Conversation {
  /** `c` + its row number. */
  id: string;
  userId: string;
  status: IntakeStatus;
  transcript: IntakeLine[];
  /** The draft on the person's latest card, or null when none is showing. */
  draft: IntakeDraft | null;
  /** The latest draft's number, carried by its card's buttons. */
  draftSeq: number;
  /** Model turns run so far, retries included. */
  turns: number;
  /** The task a Save made. */
  taskId: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

interface Row {
  seq: number;
  user_id: string;
  status: string;
  transcript: string;
  draft: string | null;
  draft_seq: number;
  turns: number;
  task_id: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toConversation(r: Row): Conversation {
  const transcript = parseJson<unknown>(r.transcript, []);
  return {
    id: `c${r.seq}`,
    userId: r.user_id,
    status: r.status as IntakeStatus,
    transcript: Array.isArray(transcript) ? (transcript as IntakeLine[]) : [],
    draft: parseJson<IntakeDraft | null>(r.draft, null),
    draftSeq: r.draft_seq,
    turns: r.turns,
    taskId: r.task_id,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

/** The row number in a conversation id, or null when it is not one. */
function seqOf(id: string): number | null {
  const m = /^c([1-9][0-9]*)$/.exec(id);
  return m ? Number(m[1]) : null;
}

export class IntakeConversations {
  constructor(private readonly db: Database) {}

  get(id: string): Conversation | null {
    const seq = seqOf(id);
    if (seq === null) return null;
    const r = this.db.query("SELECT * FROM intake_conversations WHERE seq = ?").get(seq) as Row | null;
    return r ? toConversation(r) : null;
  }

  /** The person's open conversation, after closing it if it sat idle past `INTAKE_IDLE_MS`; a new one when there is none. */
  open(userId: string, now: Date): Conversation {
    const at = now.toISOString();
    return this.db.transaction((): Conversation => {
      const idleBefore = new Date(now.getTime() - INTAKE_IDLE_MS).toISOString();
      this.db
        .query("UPDATE intake_conversations SET status = 'closed', draft = NULL, ended_at = ? WHERE user_id = ? AND status = 'open' AND updated_at < ?")
        .run(at, userId, idleBefore);
      const found = this.db.query("SELECT * FROM intake_conversations WHERE user_id = ? AND status = 'open'").get(userId) as Row | null;
      if (found) return toConversation(found);
      const made = this.db
        .query("INSERT INTO intake_conversations (user_id, status, transcript, started_at, updated_at) VALUES (?, 'open', '[]', ?, ?) RETURNING *")
        .get(userId, at, at) as Row;
      return toConversation(made);
    })();
  }

  /** Counts one model turn against the conversation. */
  countTurn(id: string, now: Date): void {
    this.db.query("UPDATE intake_conversations SET turns = turns + 1, updated_at = ? WHERE seq = ?").run(now.toISOString(), seqOf(id));
  }

  /**
   * Keeps the transcript after a turn and the draft it ended with: a draft is numbered anew, so the
   * buttons of any earlier card stop working; null takes the card's draft away.
   */
  saveTurn(id: string, transcript: readonly IntakeLine[], draft: IntakeDraft | null, now: Date): Conversation | null {
    const r = this.db
      .query(
        `UPDATE intake_conversations SET transcript = ?, draft = ?, draft_seq = draft_seq + ?, updated_at = ?
         WHERE seq = ? AND status = 'open' RETURNING *`,
      )
      .get(JSON.stringify(transcript), draft ? JSON.stringify(draft) : null, draft ? 1 : 0, now.toISOString(), seqOf(id)) as Row | null;
    return r ? toConversation(r) : null;
  }

  /**
   * Takes the draft numbered `draftSeq` off an open conversation and returns the conversation as it
   * was, draft included; null when that draft is no longer showing. One write, so only one press
   * acts on a card.
   */
  takeDraft(id: string, draftSeq: number, now: Date): Conversation | null {
    return this.db.transaction((): Conversation | null => {
      const before = this.get(id);
      if (!before || before.status !== "open" || before.draftSeq !== draftSeq || before.draft === null) return null;
      this.db.query("UPDATE intake_conversations SET draft = NULL, updated_at = ? WHERE seq = ?").run(now.toISOString(), seqOf(id));
      return before;
    })();
  }

  /** Ends an open conversation; false when it had already ended. */
  end(id: string, status: Exclude<IntakeStatus, "open">, now: Date, taskId: string | null = null): boolean {
    const at = now.toISOString();
    return (
      this.db
        .query("UPDATE intake_conversations SET status = ?, task_id = ?, draft = NULL, updated_at = ?, ended_at = ? WHERE seq = ? AND status = 'open'")
        .run(status, taskId, at, at, seqOf(id)).changes > 0
    );
  }

  /**
   * Marks the task's `created` history row as made in conversation (`CREATED_IN_CONVERSATION`, which
   * history.ts shows): docket writes that row with the type's id as its detail, and nothing reads it.
   */
  markCreatedInConversation(taskId: string): void {
    this.db
      .query("UPDATE task_events SET detail = detail || ? WHERE task_id = ? AND kind = 'created' AND substr(detail, -length(?)) != ?")
      .run(CREATED_IN_CONVERSATION, taskId, CREATED_IN_CONVERSATION, CREATED_IN_CONVERSATION);
  }

  /** Marks the task's newest `edited` history row as made in conversation, as `markCreatedInConversation` does its `created` row (edit.ts writes the changed fields' names as its detail). */
  markEditedInConversation(taskId: string): void {
    this.db
      .query(
        `UPDATE task_events SET detail = detail || ? WHERE seq = (SELECT max(seq) FROM task_events WHERE task_id = ? AND kind = 'edited')
         AND substr(detail, -length(?)) != ?`,
      )
      .run(CREATED_IN_CONVERSATION, taskId, CREATED_IN_CONVERSATION, CREATED_IN_CONVERSATION);
  }

  /** Closes every conversation idle past `INTAKE_IDLE_MS` and deletes every one ended over `INTAKE_KEPT_MS` ago. Returns how many went. */
  purge(now: Date): number {
    const at = now.toISOString();
    this.db
      .query("UPDATE intake_conversations SET status = 'closed', draft = NULL, ended_at = ? WHERE status = 'open' AND updated_at < ?")
      .run(at, new Date(now.getTime() - INTAKE_IDLE_MS).toISOString());
    return this.db
      .query("DELETE FROM intake_conversations WHERE status != 'open' AND ended_at < ?")
      .run(new Date(now.getTime() - INTAKE_KEPT_MS).toISOString()).changes;
  }
}
