# #204 -- the tracker's docs on the queue, the membership gate and the task API say what is true

Part of Epic #265. Effort XS. Docs only (README, one env description in `package.json` and so
`plugins.json`, one source comment): the single-auditor lane applies. Closes #204: findings
`tracker-discord-5`, `tracker-discord-6` and `orphans-6`.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by its text. **Before changing a
line, read the code it describes and confirm the finding; if a finding is wrong, change nothing for
it and record why under Deviations.**

### What is wrong, and the change

1. **discord-5: a zone or hour change can hold up the queue.**
   - `actions.ts` `rescheduleOwned` (from `/register zone:`, `/settings hour`, and the web settings
     save) takes `d.locks.run(task.id, ...)`, which waits, for each of the person's tasks, inside
     the one serial queue.
   - The execute tick holds the lock of every due execute-lane task for its whole pass (several
     city-hall calls, 15 s each, `CITY_HALL_TIMEOUT_MS`).
   - So a zone or hour change by the owner of such a task waits for the pass, and every other
     person's command, button and web write waits behind it in the queue. `locks.ts` admits this in
     a comment.
   - The README says the opposite twice: the execute lane paragraph ("a command, button or web
     action on one of them answers ... at once, so no one else's command waits behind it") and
     **One task at a time** (it lists "a zone or hour change" among the edits that take a task's
     lock, then says an edit about a held task "does not wait but answers ...").
   - **Change:** document the exception in both places, in the README's own voice. A zone or hour
     change is the one edit that waits for a task the execute tick holds rather than answering
     "busy", and while it waits, the commands, buttons and web writes queued behind it wait too: up
     to the execute pass's length, its city-hall calls bounded at 15 s each. Say why in one clause: a
     zone or hour change moves every one of the person's tasks, and none may be skipped. Answering
     "busy" instead is a behaviour change and is not done here.
2. **discord-6: stale and overstated docs.**
   - README **Not yet** lists "An optional Discord-role gate (plan 5.5)", which shipped in 0.17.0
     (`TRACKER_GUILD_ROLES`, documented in the settings table). **Change:** drop that clause. Keep
     the rest of the bullet ("showing unconfirmed deliveries to admins anywhere but the log, or a
     run's deliveries in its history") as its own bullet.
   - `TRACKER_GUILD_ID`'s `description` in `plugins/tracker/package.json` says the gate is "Checked
     on every command and button, in DMs too". Declining an invitation and opting out skip it by
     design (`press.ts`, the comment above the consent and opt-out paths). Check the Reply modal's
     path against the code and #162's test ("the Reply path's gates (#162)", PR #272, which may not
     have merged): include it only if it truly skips the gate. **Change:** "Checked on every command
     and button, in DMs too, except declining an invitation and opting out, so anyone can always stop
     the messages." Then regenerate `plugins.json` (`bun run generate-index`) and commit it. If the
     README's settings table repeats the sentence, make it match.
   - `actions.ts`'s header says "Everything touches the world only through the injected Store, clock
     and host `dm`". `/allow` and registration also call the usr HTTP client (`usr.ts`, through
     `TrackerDeps.usr`). **Change:** name it.
3. **orphans-6: the task API's types.**
   - README **Not yet** says "The task API makes reminders, renewals, prices and research requests".
     The API also makes scouts and want-list watches (`POST /api/v1/tasks` row: `scout`, `wantlist`).
   - The API section's "Which types" paragraph says `POST /tasks` takes the editor types, `research`
     and `scout`. It does not name `wantlist`, which the `POST` row documents.
   - **Change:** name `scout` and `wantlist` in both, matching what `web/api-tasks.ts` accepts. Read
     which types `PATCH` takes too, and correct that sentence if it is wrong.

### Steps

1. The edits above. `plugins.json` is regenerated, never hand-edited.
2. This file, committed as `docs/plans/204-discord-docs-say-what-is-true.md`.
3. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts. No test changes are expected. If a test pins the old `TRACKER_GUILD_ID` description, say
   so and update it.
4. Single auditor (read-only): every changed sentence checked against the code it describes,
   `plugins.json` regenerated and in sync, nothing else changed.

## CHANGELOG bullet (for the PR body)

Docs: the README now says that a zone or hour change waits for a scout the model runner holds (and
holds up the commands behind it). It no longer lists the Discord-role gate as not done, and it names
scouts and want-list watches among what the task API makes. It also says that `null` clears a
want-list watch's top price in a task API `PATCH`. `TRACKER_GUILD_ID`'s description now says that
declining and opting out skip the membership check (#204).

## Deviations as implemented

1. **discord-5, the "why" clause and which task.** The plan's clause says a zone or hour change
   "moves every one of the person's tasks". `rescheduleOwned` (`actions.ts`) moves only their active
   and paused `calendar` and `period` tasks, and on an hour-only change only those naming no hour of
   their own. And of the execute-lane types only the scout is one of those: research is `once`
   (`research.ts`), a judged watch `poll` (`want.ts`), a scout `calendar` with no hour
   (`scout.ts`), as `locks.ts`'s `turn` comment says. -> The README says the change "re-times every
   recurring task that follows the zone or hour and may skip none", and that the wait happens for
   the owner of a scout the execute tick holds, rather than for "a task the execute tick holds" in
   general. -> Both claims as the plan worded them were broader than the code.

### Audit

The single auditor found the change sound, with these Minors, all applied:

2. The `POST /api/v1/tasks` row's `type` list left out `wantlist`, which `NEW_TYPES`
   (`web/editor-pages.ts`) takes. -> It reads "`reminder`, `renewal`, `price`, `research`, `scout`
   or `wantlist`".
3. **One task at a time** bounded only city-hall calls, but a judged watch's page reads run in the
   same execute pass (`ExecuteLane`'s `fetch`, `createPageFetch`, `fetch.ts` `TIMEOUT_MS` =
   15 s). -> "each city-hall call or page read in it bounded at 15 seconds".
4. This plan's CHANGELOG bullet said "a task the model runner holds", broader than deviation 1. ->
   "a scout the model runner holds".
5. **Requests** said "`null` is never a value", but `asFields` (`web/api-tasks.ts`) takes `null` for
   `max` in a `PATCH` of a `wantlist` or `wantjudge` and clears the top price (`want.test.ts`,
   `wantjudge.test.ts`; `CHANGELOG.md` [0.16.0]). -> "`null` is a value only for a want-list
   watch's `max` in a `PATCH`, where it clears the top price; anywhere else it is refused as the
   wrong JSON type (send `""` to clear a note)", and a sentence for it in the CHANGELOG bullet.
6. The execute-lane paragraph's edited line ran past 100 characters. -> Rewrapped to the
   paragraph's end; the words are unchanged.
