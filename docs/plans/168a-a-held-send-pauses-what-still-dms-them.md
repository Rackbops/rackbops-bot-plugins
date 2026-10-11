# #168, part 1 -- a send held for a paused person pauses every task that still DMs them, so its copy waits for the resume instead of failing silently

Part of Epic #265. Effort S (the first of #168's PRs; the web banner and Resume button are part 2,
on the owner's decision of 2026-10-11). Behaviour change: the three-reviewer gate applies. Part of
#168 (not `Closes`).

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

Dana's delivery is paused (`DeliveryHealth`, `plugins/tracker/src/delivery-health.ts`: three DMs
in a row the host could not deliver). The notifier (`createDmNotifier`, `notifier.ts`) refuses to DM
a paused person and throws `ExecutorUnavailableError`, which docket counts as a deferral. docket
holds a paused task's sends properly: `deliverOwed` (docket-core `dispatch.js`) calls
`freshRoundForPause` and waits for the resume. But a deferred send for a task that is still
**active** is retried 8 times (`DEFAULT_DELIVERY_POLICY.deferrals`, about 3 hours) and then settled
`failed` for good. Nothing is logged, the owner is not told, and Dana stays paused. The README and the
`delivery-health.ts` header say such a send is "deferred, not failed".

An active task can DM a paused person in these cases:

- Dana makes tasks through the web editor or the Task API. Nothing under `src/web` resumes her (only
  Discord's `enter()`, `/task resume` and the admin button do).
- A pause stopped part way. `recordFailure` writes `paused_at` and then pauses the affected tasks one
  by one, outside a transaction. The branch meant to catch the rest ("Already paused: a task that
  started DMing them since ... pauses too") runs only on a later *failure*, and the notifier never DMs
  a paused person, so it is unreachable.
- An owner resumes by hand a task they had paused themselves while one of its recipients is
  delivery-paused.

### Decisions

- **The held send heals the pause.** When the notifier finds the person paused, it first runs the
  same pause pass `recordFailure` runs for an already-paused person (`pauseAffected`, under the
  health lock, with the owners' notices sent after the lock is released, exactly as in
  `recordFailure`), then throws `ExecutorUnavailableError` as today. Every active task that would DM
  them becomes paused with its `delivery_pauses` row and its `paused` event. docket's next
  `deliverOwed` then sees the task paused and holds its owed sends with a fresh round until the
  resume, so no copy is lost. Expose this as one method on `DeliveryHealth` (e.g. `holdFor(userId,
  at)`), and have `recordFailure`'s already-paused branch call the same code.
- **This replaces the transaction the epic suggested** for "a pause that stopped part way": with the
  pass re-run on every held send, a partial pause completes on the next send instead of needing to
  be atomic. `pauseAffected`'s per-task writes go through the docket `Store` port (async), which a
  `bun:sqlite` transaction cannot wrap. Record this under "Deviations as implemented" if the code
  shows otherwise.
- **No "deferrals ran out" log.** The tracker cannot see docket's deferral count (`sendDm` is not
  handed it, and the settling happens inside docket's `deliver`). With the pass above, a deferred
  send to a paused person no longer runs out: its task is paused at the first deferral. Say so in the
  PR. If the code shows a clean way to see the count, record it and do not build it here.
- **A failure of the pass never replaces the send's own result:** catch and `log.error` it, then
  throw `ExecutorUnavailableError` as today (same rule as the `recordFailure` call in the catch
  above it).
- **The comments and README say what is true:** the `delivery-health.ts` header ("a send ... already
  under way is deferred ... never failed"), the comment above the `pauseAffected` call in
  `recordFailure` (it names a new share as the trigger, which `press.ts` refuses for a paused invitee),
  and README's "Pause after failed DMs" paragraph ("a DM to them still owed is deferred, not
  failed") are each checked against the new behaviour and reworded where false.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/delivery-health.ts`: the `holdFor` method (or similar name) as decided;
   `recordFailure`'s already-paused branch uses it; comments corrected.
2. `plugins/tracker/src/notifier.ts`: in `sendDm`, when `d.health?.isPaused(userId)`, await the pass
   (caught and logged on failure), then throw `ExecutorUnavailableError` as today.
3. README's pause paragraph, if a claim is false.
4. Tests (`delivery-health.test.ts` for the unit; the notify-tick path in `surface.test.ts` or the
   web/API test that can make a task for a paused person):
   - "a task made on the web by a paused person pauses at its first send, and its DM waits for the
     resume": pause Dana (three refused DMs), make her a reminder through the web editor or the Task
     API, run notify ticks well past 8 deferrals' worth of time (or the policy's whole backoff) -> the
     task is `paused` with a `delivery_pauses` row naming her, its delivery row is not `failed`; then
     she uses a Discord command (resume) and the next tick DMs her that run.
   - "a pause that stopped part way completes on the next held send": set `paused_at` for a person
     while one of their tasks is still active (directly, as a crash would leave it), fire that task's
     run -> after the tick the task is paused for them.
   - "a task its owner resumed while a recipient is still paused pauses again at its next send".
   - "a failing pause pass is logged and the send is still only deferred": make the pass throw ->
     `sendDm` rejects with `ExecutorUnavailableError`, and the error is logged.
   - The owner of a task paused this way for a recipient is told once (the existing notice), not on
     every held send.
5. This file, committed as `docs/plans/168a-a-held-send-pauses-what-still-dms-them.md`.
6. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
7. Mutations from the table, each in a scratch worktree, never in the tree under test; name the red
   test per row in the PR.
8. Review gate: you plus two read-only reviewers (A: correctness and failure modes -- lock ordering
   between the notifier's pass, the interaction queue's `enter`/`resume` and the tick's task locks;
   a pass that runs while a resume is in flight; repeated owner notices; the run's copy for the
   paused person versus everyone else's copies of the same run; forget-me while a send is held; B:
   claims-vs-code over this plan, the comments, the README and the bullet, walking every coverage row
   and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or
   declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A paused person's web-made task pauses and its DM waits, not fails | 1, 2 | the web-made task test | drop the pass in `sendDm` |
| The DM arrives after the resume | 1, 2 | the same test's last half | -- (end-to-end) |
| A partial pause completes on the next held send | 1, 2 | the part-way test | pass only on `recordFailure` |
| A hand-resumed task pauses again for a paused recipient | 1, 2 | the owner-resume test | pass skips tasks the person receives |
| A failing pass is logged and still only defers | 2 | the failing-pass test | let the pass's error escape |
| The owner is told once | 1 | the notice-count assertion | send the notice on every held send |

## CHANGELOG bullet (for the PR body)

A DM to someone whose delivery is paused is now held until they come back for every task not yet
finished that would DM them, including tasks they made on the web or through the task API while
paused, a task its owner resumed by hand while a recipient was still paused, and a task a pause had
not reached yet: the first held DM pauses that task too. Before, such a DM was retried for about two
hours and then dropped without a word (#168).

## Deviations as implemented

1. **`recordFailure` runs the pass itself, not through `holdFor`.** The health lock is a promise
   chain and not re-entrant, so `recordFailure` (already on it) cannot call `holdFor`. Both run the
   one pass, `pauseAffected`, inside their own turn of the lock, and share the code that sends the
   owners' notices after the lock is released (`lockedThenTell`, which `recordFailure` now uses in
   place of its own copy). `holdFor` re-checks `isPaused` inside the lock, so a resume (or a
   forget-me, whose erasure deletes the `delivery_health` row) that landed after the notifier
   looked makes it do nothing.
2. **`pauseAffected` pauses an active task even when its `delivery_pauses` row is already there.**
   The old guard (`changes === 0 || ...`) skipped a task whose row existed, so a pause that stopped
   between a task's row and its status -- one of the part-way points -- would never complete: every
   later pass found the row and left the task active. Now an active task the pass reaches is paused
   either way (the INSERT stays `ON CONFLICT DO NOTHING`); a task already paused is still skipped, so
   its owner is still told once per pause. The part-way test covers both stopping points.
3. **No transaction (confirmed).** The pass's reads and writes go through docket's async Store port
   (`listTasks`, `listRecipients`, `updateTask`, `addTaskEvent`). A `bun:sqlite` `db.transaction(fn)`
   runs `fn` synchronously and commits at its first `await`; a hand-rolled `BEGIN`/`COMMIT` across
   those awaits on the one shared connection would take in whatever else the event loop writes
   meanwhile, and make roster.ts's own `db.transaction` throw. So the pass re-run on every held send
   (and deviation 2) is what completes a partial pause, as planned.
4. **The deferral count is visible -- not built.** docket claims the row before it calls `sendDm`,
   and every run's message carries `ref.occurrenceId`, so
   `store.listDeliveries({ occurrenceId: message.ref.occurrenceId, userId })` returns the claimed
   row with its `deferrals`. Recorded only, per the plan; with the pass, a held send for a task not
   yet finished no longer runs out.
5. **A finished task's held DM is still not held.** A finished task is `done` while its DMs are
   still owed -- a research request completes with the run that answers it, before the answer goes
   out; a task its owner ended keeps an earlier run's owed copies -- but the pass pauses only active
   tasks, and docket's `deliverOwed` holds only a `paused` task's rows; pausing a done task would
   restart it on the resume (`release` sets it active and gives it a next run). So such a DM to a
   paused person is deferred eight times and fails, as before (checked: a `complete` run's copy to a
   paused owner settles `failed` after 123 minutes of one-minute ticks). The
   comments and README say so, and the CHANGELOG bullet's "every task that would DM them" was untrue
   for it: it now reads "every task not yet finished that would DM them".
6. **About two hours, not three.** `DEFAULT_DELIVERY_POLICY`'s deferral backoff is 1, 2, 4, 8, 16
   and 32 minutes, then capped at 60 (`maxBackoffMs`), so the eighth try, which settles the row
   `failed`, comes about 123 minutes after the first (checked with one-minute ticks and the pass
   removed). The comments, README and the CHANGELOG bullet say about two hours; "What is wrong"
   above is left as written.
