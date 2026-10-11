# #202 core-6 -- the tracker core's comments say what is true, and the dead `localIdentity` goes

Part of Epic #265. Effort XS. Comments, plus one dead function and its test removed; no behaviour
change, so the single-auditor lane applies. Part of #202: its finding `tracker-core-6`, except the
`CONTEXT.md` line about `laneStore`, which rides with #210 (Epic #269). core-3 is PR #284, and
core-5 waits on the epic's decision 8.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by its text. **Before changing a
line, read the code it describes and confirm the finding; if a finding is wrong, change nothing for
it and record why under Deviations.** A shipped migration's SQL is never edited. Its comments may
be corrected, but only to say what was true when it shipped and what is true now. Never rewrite a
comment's history as if the past were different.

### The changes

1. **`plugins/tracker/src/schema.ts` header (~10):** it says "Every table has an
   `seq INTEGER PRIMARY KEY AUTOINCREMENT`". That is false for admissions, delivery_health,
   delivery_pauses, web_login_tokens, web_sessions, notices, executor_jobs and tracker_meta. Check
   that list against the schema. Reword the claim to cover only the tables whose rows have a public
   id (docket's tables and any others that do). Say that the rest are keyed by what they describe,
   and name the keys only if it stays short.
2. **`schema.ts`, migration 5's comment (~229-230):** "the tracker runs no execute lane yet, so both
   stay empty" was true when migration 5 shipped (0.9.0). The execute lane (0.11.0) writes both.
   Reword it as history, e.g. "...which the execute lane writes; at 0.9.0 the tracker ran no execute
   lane, so both stayed empty until 0.11.0". If the next bullet ("`users.usr_subject` goes (people
   are not usr accounts, plan item 40)") is now misleading, because 0.20.0 brought `usr_subject`
   back in schema 9, add a short "(schema 9 adds it back, 0.20.0)" rather than rewriting it.
3. **`plugins/tracker/src/index.ts`, `createPlugin`'s JSDoc (~51-52):** it says `createPlugin`
   validates the listed settings "and nothing else". It also validates the `TRACKER_USR_*` settings
   (a half-set link throws, `usr.ts`) and parses `TRACKER_BGG_TOKEN`. Add them, and drop "and
   nothing else" unless the list is then complete; read `createPlugin` to be sure.
4. **`plugins/tracker/src/people.ts`:**
   - The header (~3-7) says people are "never a usr account, and nothing here calls usr". Since
     0.20.0 each person can be linked to a usr account (`users.usr_subject`, `usr.ts`/`usr-links.ts`),
     and since 0.22.0 the web area signs in by usr identity. Say what `people.ts` itself does (it
     still does not call usr, if true), and where the usr link lives.
   - `localIdentity` (~98-109) has no production caller, only `people.test.ts`. Its JSDoc says
     "the commands (#79) will" use it, and "a Discord id is the only way in". Delete the function
     and its test block in `people.test.ts`, with any import that falls out.
5. **`plugins/tracker/src/limits.ts` header (~3-5):** it names `reminders.ts`, `tracked.ts` and
   `price.ts` as the files whose rules check the limits. `research.ts`, `scout.ts`, `want.ts` and
   `edit.ts` import them too. Name all of them, or say "the shared rules (reminders.ts, tracked.ts,
   price.ts, research.ts, scout.ts, want.ts, edit.ts)" after grepping for the exact set.

### Steps

1. The edits above. This file is committed as `docs/plans/202-core-comments-say-what-is-true.md`.
2. Checks: `bun run lint`, `bun run check` (no unused import may remain), `bun run build`,
   `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/tracker`
   (private `TMPDIR`), `bun test`. Paste the counts. The tracker test count drops by exactly the
   removed `localIdentity` test(s); say how many.
3. Single auditor (read-only): every changed sentence is checked against the code; `localIdentity`
   has no caller anywhere (grep the repo, including web, scripts and other plugins); no other change.

## CHANGELOG bullet (for the PR body)

None: comments and dead code only, nothing a user or operator sees.

## Deviations as implemented

1. **Change 1 (schema header) -> also names the tables with a `seq` but no public id -> "the rest
   are keyed by what they describe" would be false for three of them.** The public-id tables are
   users `u`, tasks `t`, invite_blocks `b`, occurrences `o`, events `e`, task_events `h`, replies
   `r`, series `s`, usage `c`, findings `f` (store.ts's `to*` mappers), api_tokens `k`
   (web/api-tokens.ts) and ceiling_changes `c` (ceilings.ts). `task_recipients`, `deliveries` and
   `want_inbox` also have `seq INTEGER PRIMARY KEY AUTOINCREMENT` but expose no id (`toRecipient`
   and `toDelivery` carry none; inbox.ts reads `want_inbox` by `seq` only for order), so the header
   says they keep a `seq` for order only. The list of tables keyed by what they describe matched the
   finding, plus migration 1's `delivery_claims` (dropped by 5), so the old claim was false from the
   start.
2. **Change 2 (migration 5's comment) -> adds that `notices` also holds the daily digest's claims
   since 0.18.0 -> the plan's "which the execute lane writes" is not the whole story.** digest.ts
   claims each person's day with `claimNotice(digestKey(...))` on the notify tick (0.18.0's
   CHANGELOG). And with "(schema 9 adds it back, 0.20.0)" in place, the bullet's "Never written by
   any release" read today is false (0.20.0 on writes it, usr-links.ts `link`), so it now says "any
   release before it": two words, not a rewrite.
3. **Change 5 (limits.ts header) -> names reminders.ts, tracked.ts, price.ts, research.ts, want.ts,
   plus actions.ts and web/app.ts; not scout.ts or edit.ts -> the finding listed who imports
   limits.ts, but the sentence is about who checks a limit on the server.** scout.ts (`scoutTitle`)
   and edit.ts (`editReminderLocked`) only `clip` a title they build to `MAX_TITLE`; edit.ts's
   reminder checks run through reminders.ts's `reminderPlan`. actions.ts's `answerLatest` refuses a
   `/task snooze` `until` over `MAX_WHEN`, and web/app.ts's `settingsPost` refuses a zone over
   `MAX_ZONE`: both check on the server and were missing.

Change 3 kept "and nothing else": with the `TRACKER_USR_*` settings and `TRACKER_BGG_TOKEN` added,
the list covers all 14 settings in the tracker's `botPlugin.env`, each read at the top of
`createPlugin`, which is the plan's condition for keeping it.

### Audit

The single auditor found the change SOUND with five Minors. Each was checked against the code and
applied as worded:

4. **people.ts, `admit`'s doc: "What `/allow` will call" is future tense for a command that
   exists -> "What `/allow` calls (actions.ts's `allowPerson`, rackbops-bot-plugins#79)".**
   `allowPerson` calls `admit` (actions.ts).
5. **people.ts, `setPreferences`'s doc: "what `/register` will write" -> "what `/register`,
   `/settings hour` and the web settings form write, actions.ts".** Its callers are
   `registerSettings` (`/register`), `setHour` (`/settings hour`, discord.ts) and `saveSettings`
   (web/app.ts's `settingsPost`), all in actions.ts.
6. **limits.ts header: it called the file "the length limits", but it also holds `MAX_LIVE_TASKS`,
   a count -> the header names the cap (last in the file, checked by actions.ts's `liveTaskCap`)
   and says "A length limit is on the trimmed text".**
7. **people.ts header: "`/allow`, `/register` ... go by it, not this file" contradicted 4 and 5,
   and 0.20.0 made no links ("Nothing calls usr yet"; `/allow` links from 0.21.0) -> the person
   may carry a usr account's id since 0.20.0, and the link lives in usr.ts and usr-links.ts. `/allow`
   and `/register` admit and register through this file and, since 0.21.0, make and use the link
   too. The web sign-in (0.22.0) finds the person by it.** `/allow` makes the link
   (`usr.links.link`), `/register` uses it (`subjectOf`, `unlink`) and web/app.ts reads it with
   `userOfSubject`.
8. **schema.ts header: "a Job or notice key" left out `tracker_meta` -> "a Job, notice or
   `tracker_meta` key".** `tracker_meta` is `key TEXT PRIMARY KEY` (schema.ts, `vacuumOnce`).
