import type { Database } from "bun:sqlite";

/**
 * Each person's link to their usr account (schema 9's `users.usr_subject`; usr.ts): usr's opaque user
 * id, learned from `/api/discord/allow`. One usr account is one person (the column's unique index),
 * so a second person can never be linked to an account already linked here.
 */

/** The row behind a tracker user id (`u<seq>`, store.ts), or null when `id` is not one. */
function seqOf(id: string): number | null {
  return /^u[1-9][0-9]*$/.test(id) ? Number(id.slice(1)) : null;
}

/** `gone`: the person left the tracker (forget-me) while usr was being asked, so nothing was kept. */
export type LinkOutcome = "linked" | "unchanged" | "relinked" | "taken" | "gone";

export class UsrLinks {
  /**
   * The people usr has said are signed up there (its 409 to a sign-up link), so `/register` stops
   * asking for one: usr rate-limits those asks (5 an hour by default), and a person who runs
   * `/register` often would otherwise be told about a limit for a link they no longer need. In
   * memory only: after a restart, the next `/register` asks once more.
   */
  private readonly signedUp = new Set<string>();

  constructor(private readonly db: Database) {}

  isSignedUp(userId: string): boolean {
    return this.signedUp.has(userId);
  }

  markSignedUp(userId: string): void {
    this.signedUp.add(userId);
  }

  /** The person's usr user id, or null when they are not linked (or not found). */
  subjectOf(userId: string): string | null {
    const seq = seqOf(userId);
    if (seq === null) return null;
    const row = this.db.query("SELECT usr_subject FROM users WHERE seq = ?").get(seq) as { usr_subject: string | null } | null;
    return row?.usr_subject ?? null;
  }

  /**
   * Links the person to `subject`. `taken`: another person here is already linked to it, and nothing
   * changes. `relinked`: they were linked to a different account, which usr now says is theirs.
   */
  link(userId: string, subject: string): LinkOutcome {
    const seq = seqOf(userId);
    if (seq === null) throw new Error(`not a tracker user id: ${userId}`);
    return this.db.transaction((): LinkOutcome => {
      const row = this.db.query("SELECT usr_subject FROM users WHERE seq = ?").get(seq) as { usr_subject: string | null } | null;
      if (!row) return "gone";
      const holder = this.db.query("SELECT seq FROM users WHERE usr_subject = ?").get(subject) as { seq: number } | null;
      if (holder && holder.seq !== seq) return "taken";
      if (row.usr_subject === subject) return "unchanged";
      this.db.query("UPDATE users SET usr_subject = ? WHERE seq = ?").run(subject, seq);
      // A new account has not signed up yet, whatever the old one had.
      this.signedUp.delete(userId);
      return row.usr_subject === null ? "linked" : "relinked";
    }).immediate();
  }

  /**
   * Forgets the person's link, when usr says it no longer knows them (its 403 to a sign-up link for
   * someone linked here: a usr admin removed their Discord link). The next `/allow` links them anew.
   */
  unlink(userId: string): void {
    const seq = seqOf(userId);
    if (seq === null) return;
    this.db.query("UPDATE users SET usr_subject = NULL WHERE seq = ?").run(seq);
    this.signedUp.delete(userId);
  }
}
