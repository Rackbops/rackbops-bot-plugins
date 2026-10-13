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
not reached yet: the first held DM pauses that task too. Pausing such a task also holds its other
recipients' later copies until the person comes back or the owner runs `/task resume`, and the owner
is told, as at any pause. Before, such a DM was retried for about two hours and then dropped without
a word. A DM for a task that has already finished, a research answer say, is still not held: it
fails after about two hours, as before. An owner's own pause or delete is no longer undone by a
delivery pause or resume running at the same moment (#168).

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

### Review gate round 1

Fixes on `ac1ce52` (code, tests, wording), this record and the bullet in `cd507f9`; items 10 to 12,
on the orchestrator's decision to close both races found while testing, on `e81f1a5`.

1. **(A) The pass could write over an owner's delete or pause, and the person's resume then set
   the task active.** docket's Store port has no compare-and-set for a task (`ports.d.ts`:
   `updateOccurrenceIf` only; `store.ts`'s `updateTask` reads the row and rewrites every column), so
   `pauseAffected` pauses through a new `pauseIfActive`: `UPDATE tasks SET status = 'paused',
   updated_at = ? WHERE seq = ? AND status = 'active'` on `this.db` -- the two columns `updateTask`
   changes for a status patch (the rest it rewrites with their current values) -- with the id's row
   number from `store.ts`'s `seqOf`, now exported. The status write and the `delivery_pauses` row
   change in one `db.transaction` (two synchronous statements, no await in it, as `resume` already
   does), so no crash can leave one without the other: the row goes in only when the task was
   paused, and this person's row comes off it when it was not (one a pass that stopped part way
   left, which would otherwise let their resume set an owner's pause back to active). The `paused`
   event and the owner notice follow only when it applied. A task the snapshot shows paused for
   someone else gets its row as before.
   - Tests: "an owner's {deleteTask, pauseTask} landing between a held send's read of the tasks and
     its write stands (and a row a pause stopped part way left on it goes); the recipient's resume
     leaves it" -- a store whose `listRecipients`, the pass's first read after `listTasks`, runs the
     owner's act to its end, so it lands in the window every run -- and "an owner's delete started
     with a held send's pass, or queued behind the owner's own resume as `enter` runs it, stays
     deleted after the recipient's resume": the delete started 0 to 8 microtasks ahead of `holdFor`,
     and after `resume(owner)` with `holdFor` queued behind it on the lock. At natural timings this
     harness hits the window with the delete 3 to 5 microtasks ahead (active after the resume
     without the fix); started exactly together, or behind the owner's resume, the pass runs first
     and the delete after, which ends archived with or without the fix.
   - **Found while testing (fixed in item 10): the other order, for `pauseTask`.**
     `pauseLocked` reads the task (`ownLiveTask`), then writes `paused` with a plain `updateTask`,
     with awaits between. A pass whose compare-and-set lands between the two pauses the task for the
     person (row, `paused` event, owner notice); the owner's write then lands on a mechanism pause
     and adds "paused by the owner", and the person's resume sets it active: the owner's pause is
     lost, as in A's finding. It reproduces with the owner's pause and `holdFor` started together
     (the pause first, or `holdFor` up to 3 microtasks first) and with the pause queued behind the
     owner's own resume, the order a Discord command takes (`enter`). So "start both together" is in
     the test for the delete only: for the pause it would be red. The compare-and-set cannot cover
     it: the stale write is the owner's. A fix would run `pauseLocked`'s read and write on the health
     lock too (`d.health.exclusive`, in the order `resumeLocked` already takes: the task's lock, then
     the health lock), or make its write a compare-and-set. A delete in that order is harmless:
     archived stands, since `release` sets only a `paused` task active. Until then the header's "a
     resume never undoes anything but this mechanism" is untrue in that one order.
   - **Also found, as it is on `main` (fixed in item 11):** `release`, which a resume runs, reads
     the task (`getTask`) and then writes `active` with a plain `updateTask`, an await between and
     no task lock, so an owner's delete landing between the two comes back active, with a `resumed`
     event (reproduced with the delete 6 microtasks ahead of the person's resume). A compare-and-set
     from `paused` to `active` would close it; not done here.
2. **(A and B) A pass that threw part way dropped the notices it had collected.** `lockedThenTell`
   now tells them in a `finally`, then the error goes on to the caller (`tellOwner` catches its
   own). Test: "a pass that throws part way still tells the owners of the tasks it paused before,
   and the error still reaches the caller", through `holdFor` and `recordFailure`: the friend
   receives two tasks with different owners and the second's `addTaskEvent` throws; the first's
   owner is told, and the call rejects with that error.
3. **(B, survivor M23)** Test "a send for a task already finished ... is not paused with a paused
   person: their copy fails after docket's eight deferrals, about two hours on": a notify-lane type
   whose run completes its task (as a research answer does), made while its owner is paused, the
   friend receiving it. The friend's copy goes, the task is `done`, and the owner's copy, deferred,
   settles `failed` with `deferrals` 8 exactly 123 one-minute ticks after the first; the task stays
   `done` with only its `completed` event, no `delivery_pauses` row, and no owner told.
4. **(B, survivor M3)** "owner notices" runs through `recordFailure` and `holdFor` (the person
   paused with no pass run yet, so the held send's pass pauses the task): a resume on the lock
   finishes while the owner's DM is still in flight.
5. **(B) A false comment.** `delivery-health.ts`'s header now says "(making a task there resumes no
   one)", and `web/editor.test.ts`'s comment "Making a task on the web resumes no one".
6. **(B) A false clause in deviation 3.** A hand-written `BEGIN`/`COMMIT` would not make
   `roster.ts`'s `db.transaction` throw: bun:sqlite runs a `db.transaction` opened inside another as
   a savepoint (checked: no throw, and the outer `ROLLBACK` undoes the inner write too). The reason
   that holds is the other one: on the one shared connection, whatever the rest of the event loop
   writes between the pass's awaits would be taken into its transaction, and rolled back with it.
   Deviation 3 is left as written. Item 1's transaction is not that: two synchronous statements,
   no await between them.
7. **(B)** The comment in `notifier.ts`'s `sendDm` and the `holdFor` docstring now carry "(all but a
   send for a task already finished)"; `notifier.ts`'s header used other words for the same
   exception and now uses these.
8. **(B)** README: "Only a send for a task already finished (a research answer, say) is not held".
9. **(A and B)** The CHANGELOG bullet above now carries both facts, in the words given, the rest
   kept.

10. **The other order for an owner's pause (item 1's first finding).** `pauseTask` now runs
    `pauseLocked` inside `d.health.exclusive`, taken after the task's lock, the order `resumeLocked`
    already takes (task lock, then health lock); `exclusive` fits: nothing that holds the health
    lock waits for a task's lock or the queue (the pass, `resume`, `resumeTask`, forget-me's erasure
    in `admin.ts`), and `pauseLocked` calls nothing on that lock, so it does not re-enter it. The
    pass and the owner's pause now run one after the other: whichever is first wins, and a pause
    that finds the task already paused for failed DMs is refused ("That task is paused, not
    active."), as it would be a moment later. Tests:
    - "an owner's pauseTask started between a held send's read of the tasks and its write waits
      for the pass, on the one lock: it is refused, never a pause the recipient's resume undoes"
      (replaces item 1's forced pause test, which ran the owner's act to its end inside the pass:
      with one `DeliveryHealth` it now waits on the pass's lock, so the hook starts it and does not
      await it. Item 1's forced tests had given the owner's act a second `DeliveryHealth`, whose
      lock was not the pass's; they now share one, as production does);
    - "an owner's {deleteTask, pauseTask} started with a held send's pass, or queued behind the
      owner's own resume as `enter` runs it, is never undone by the recipient's resume": the owner's
      act 0 to 8 microtasks ahead, the pass 0 to 4 ahead, and the act queued behind `resume(owner)`.
      What the owner did stands, and a refused pause leaves the person's resume to set the task
      going. Without the fix six of these go red for the pause: the act 0 ahead, the pass 0 to 3
      ahead, and queued behind the owner's resume.
11. **`release` wrote `active` over an owner's delete (item 1's second finding, as on `main`).**
    `pauseIfActive` became `statusIf(taskId, from, to, at)`, the same one-statement
    compare-and-set; `release` sets the task active only from `paused`, and adds the `resumed` event
    and gives the next run only when that applied. (`release` also runs from forget-me's erasure and
    from `resumeTask`, on the same lock; there the compare-and-set only adds a refusal, for a task
    that left `paused` since its read.) It reads the task again for `materialize`, which
    gives no run to a task that is no longer active. Tests: "a delete landing between the resume's
    read of the task and its write stays deleted, with no new run" (a store whose `getTask`,
    `release`'s read, runs the delete to its end before returning): `resume` resumes no task, the
    task is `archived` with no `resumed` event and no queued run. "A delete started with the
    person's resume, either first by a few microtasks, stays deleted and sends nothing more" (the
    delete 0 to 10 ahead, the resume 0 to 4): `archived`, and a notify tick two days on sends
    nothing. When the resume's compare-and-set goes first and the delete lands just after it, the
    delete can drop the queued runs before `materialize` queues the next, which then stays queued
    on the archived task (the delete 2 or 3 microtasks ahead). docket runs none of an archived
    task's runs (`due`), so nothing goes out; the row is inert, as it was on `main`. Not closed:
    `release` would need the task's lock, which nothing on the health lock may wait for.
12. **`locks.ts`'s "which is safe: each Store write is one statement" was not true of the pause.**
    It now says why the pause and the resume may write a task's status without its lock: each such
    write is a compare-and-set (active to paused, paused to active), so an owner's delete landing
    meanwhile stands, and the owner's own pause checks and writes on the health lock, taken after
    the task's, so a pause there never lands between the two. `manage.ts`'s header, the
    `delivery-health.ts` header ("a resume never undoes anything but this mechanism", now true in
    both orders) and the `release` and `statusIf` docstrings say the same. The CHANGELOG bullet
    adds one sentence a user could notice: an owner's own pause or delete is no longer undone by a
    delivery pause or resume running at the same moment.

    Left as it is: a `delivery_pauses` row left on an active task by a crash in older code (row
    written, status not; `7eedddf` and `main` wrote them apart, `ac1ce52` writes them in one
    transaction). If the owner pauses that task before any pass reaches it, the row stays, and the
    person's resume sets the owner's pause going. It takes a crash between two statements, and no
    new one can arise; it is not a race, so the bullet's sentence holds.

Declined, as decided: narrowing `affected()` for cost (A): its cost is bounded, and not this
change's concern. B's M5 and M6: near-equivalent, given `holdFor`. B's M9 and M15: survivors on
unchanged lines, noted only.

Mutations, each alone in a scratch worktree on `ac1ce52`, `bun test plugins/tracker` (518 tests):

| Mutation | Red |
|---|---|
| Compare-and-set dropped: `WHERE seq = ?` without `AND status = 'active'` | 5: the four "landing between ..." tests and "an owner's delete started with ..." |
| The same as the old code: row, then `await this.store.updateTask(...)`, no transaction | the same 5 |
| `finally` dropped in `lockedThenTell` (tell after the lock, skipped on a throw) | 1: "a pass that throws part way ..." |
| M23: `done` treated as `active` in the skip, the branch and the compare-and-set | 1: "a send for a task already finished ... is not paused ..." |
| M3: `holdFor` tells the owners inside the lock | 2: "owner notices ... (holdFor)", and "a pass that throws part way ..." |
| (extra; `delivery-health.test.ts` only) The leftover row's `DELETE` dropped | 2: the two "... (and a row a pause stopped part way left on it goes) ..." |

M23 on the skip and the branch alone, the compare-and-set unchanged, is equivalent (green on
`delivery-health.test.ts`): the compare-and-set refuses a `done` task.

Mutations again on `e81f1a5`, each alone in a scratch worktree, `bun test plugins/tracker` (520
tests):

| Mutation | Red |
|---|---|
| Item 10: `pauseTask` without `d.health.exclusive` | 2: "an owner's pauseTask started between ... waits for the pass ..." and "an owner's pauseTask started with a held send's pass, or queued behind ..." |
| Item 11: `release` writes a plain `updateTask` in place of `statusIf` | 2: "a delete landing between the resume's read ..." and "a delete started with the person's resume ..." |
| The pass as the old code: row, then `await this.store.updateTask(...)`, no transaction | 3: the two "an owner's deleteTask landing between ..." and "an owner's deleteTask started with a held send's pass ..." |
| The pass's compare-and-set alone dropped (an unconditional `UPDATE` in the transaction) | the same 3 |
| `finally` dropped in `lockedThenTell` | 1: "a pass that throws part way ..." |
| M23 (`done` in the skip, the branch and the compare-and-set) | 1: "a send for a task already finished ... is not paused ..." |
| M3: `holdFor` tells the owners inside the lock | 2: "owner notices ... (holdFor)" and "a pass that throws part way ..." |
| (extra; `delivery-health.test.ts` only) The leftover row's `DELETE` dropped | 1: "an owner's deleteTask landing between ... (and a row ... goes) ..." |

The pause's races no longer depend on the pass's compare-and-set: the health lock keeps them
apart. So the compare-and-set's mutations now redden only the delete's tests, and dropping the
`DELETE` only the delete's leftover-row test.

### Review gate round 2

Round 2, on `7583882`: reviewers A and B both **SOUND**. Fixes on `27b4b1b`; this record in the
next commit.

13. **(A, Minor 2) A Store error just after a task's compare-and-set lost its owner's notice for
    good**: the notice went on the list only after the `paused` event was written, and the next pass
    finds the task already paused and leaves it. `pauseAffected` now reads the owner before the
    transaction and puts the notice on the tell-after-the-lock list as soon as `statusIf` applies,
    before `addTaskEvent`; `lockedThenTell`'s `finally` sends it. Test: "a Store error just after a
    task's pause still tells its owner, once: the next pass finds the task paused and leaves it"
    (`addTaskEvent` throws once): the task is paused with its row, `holdFor` rejects with the error,
    the owner is told, and a second pass tells no one again. Round 1's item 2 test now expects both
    owners told: its second task's pause applied before its event write threw. The `paused` event
    of a task whose event write throws is still lost; its row and status say why it is paused.
14. **(B, survivor f) The pass's transaction was untested.** Test "a pass whose pause row cannot be
    written leaves the task active: the status and the row are one transaction": a `BEFORE INSERT`
    trigger on `delivery_pauses` that raises `ABORT`; `holdFor` rejects, the task stays `active`
    with no row, and no owner is told.
15. **(B, survivor g) `release`'s re-read was untested.** Test "a delete landing just after the
    resume's write stands too: no next run is queued for it": the delete runs inside `addTaskEvent`
    once the `resumed` event is written; the task ends `archived` with events `paused`, `resumed`,
    `archived` and no queued run.
16. **(B, Minor 1)** `release`'s docstring now says both: a delete landing between the read and the
    write stands with no `resumed` event and no next run, and one landing after the write stands
    too, with the `resumed` event already written and a run `materialize` queued just before it left
    inert on the archived task.
17. **(B, Minor 2; A's note)** `exclusive`'s docstring names its third user: the owner's own pause
    (`manage.ts` `pauseTask`, after the task's lock).
18. **(B, Minor 3)** The header says "each status checked in the write itself".
19. **(B, scope)** Item 11 now says `release` also runs from forget-me's erasure and `resumeTask`,
    where the compare-and-set only adds a refusal.
20. **Declined: A's Minor 1** (delete a crash-left `delivery_pauses` row in `pauseLocked`). It needs
    a crash in older code between two writes; no new case can arise, since `ac1ce52` writes the
    status and the row in one transaction; and item 12 already records it.

Mutations on `27b4b1b`, each alone in a scratch worktree, `bun test plugins/tracker` (523 tests):

| Mutation | Red |
|---|---|
| Item 13's old order: the owner read and the notice after `addTaskEvent` | 2: "a Store error just after a task's pause still tells its owner, once ..." and "a pass that throws part way ..." |
| Survivor f: the pass's `db.transaction` removed (the two statements run bare) | 1: "a pass whose pause row cannot be written leaves the task active ..." |
| Survivor g: `release` materializes `{ ...task, status: "active" }` instead of reading again | 1: "a delete landing just after the resume's write stands too ..." |
| `pauseTask` without `d.health.exclusive` | 2: "an owner's pauseTask started between ..." and "an owner's pauseTask started with a held send's pass, or queued behind ..." |
| `release` writes a plain `updateTask` in place of `statusIf` | 2: "a delete landing between the resume's read ..." and "a delete started with the person's resume ..." |
| The pass's compare-and-set dropped (an unconditional `UPDATE` in the transaction) | 3: the two "an owner's deleteTask landing between ..." and "an owner's deleteTask started with a held send's pass ..." |

## Review gate round 1: fixes to make (orchestrator, 2026-10-11; execute as written)

Round 1, on `7eedddf`: reviewer A **SOUND**, with Minor findings only; reviewer B **NOT SOUND**, on
three Majors (two false claims and one survivor). Make every fix below as new commits on top. Then
record each as a numbered item under a `### Review gate round 1` heading at the end of "Deviations
as implemented": the finding, then what you did.

**Code (a behaviour change, so the orchestrator re-runs a narrow round 2 on it):**

1. **(A) The pass can overwrite an owner's delete or pause, and the person's resume then restores
   the task.** `pauseAffected` decides from the `listTasks()` snapshot and then writes
   `updateTask(..., paused)` without that task's lock. An owner's `deleteTask` or `pauseTask`
   landing in between is overwritten: archived becomes paused, the resume makes it active again,
   and the deleted task comes back.
   - **Fix:** make the status change a compare-and-set, so it applies only while the task is still
     `active`.
   - **How:** first look for a conditional update on the Store (docket has `updateOccurrenceIf` for
     occurrences; check for a task equivalent in `store.ts` or docket's `Store` port). If there is
     none, run a direct `UPDATE ... SET status = 'paused', updated_at = ? WHERE <id> = ? AND
     status = 'active'` on the tracker's own `tasks` table through `this.db`. Mirror exactly the
     columns `store.ts` `updateTask` writes for a status change; read it.
   - **After the write:** add the `paused` event and the owner notice only when the row changed.
     Insert the `delivery_pauses` row as today, but if the compare-and-set did not apply and the
     task is not paused for this person, delete the row again (or insert it only after the status
     write succeeds; pick the order that keeps the rows and the statuses agreeing).
   - **Test:** an owner's `deleteTask` (and `pauseTask`) racing the pass leaves the task archived
     (or owner-paused). After the person's resume it is still archived (or paused by the owner),
     not active. Drive the race with the same interleaving A used: start both together, and also
     with the delete queued behind `enter`'s resume. Confirm the mutation "plain `updateTask`
     without the condition" turns the test red.
2. **(A and B) A pass that throws part way drops the notices it already collected.**
   `lockedThenTell` must still send the notices collected before the throw, then rethrow (use a
   `finally` for the telling). **Test:** a pass whose second task's write throws still tells the
   first task's owner, and the error still reaches the caller.

**Tests:**

3. **(B, Major: survivor M23, "also pause `done` tasks").** Add a test: a `done` task with an owed
   copy to a paused person. Assert the task stays `done`, it has no `paused` event, and the copy
   settles `failed` after about 123 one-minute ticks (`deferrals` 8). This pins the README's "about
   two hours" and deviation 5.
4. **(B, survivor M3, `holdFor` tells owners inside the lock).** Run the existing owner-notices test
   (or a copy of it) through `holdFor` as well as `recordFailure`.

**Wording (keep each sentence true of the code):**

5. **(B, Major) A false comment.** `delivery-health.ts` ~27 says a task made "on the web or through
   the task API (nothing there resumes them)". That is false: the web's Resume, the API's
   `POST /tasks/<id>/resume` (`manage.ts` `resumeLocked`) and the admin's "Resume delivery" all
   resume a paused person. Reword it to "(making a task there resumes no one)". Fix the same claim
   in the `web/editor.test.ts` comment ("Making a task on the web resumes no one").
6. **(B, Major) A false clause in deviation 3.** It says a hand-written `BEGIN`/`COMMIT` "would
   make `roster.ts`'s own `db.transaction` throw". It would not: bun:sqlite nests it as a
   savepoint. Correct it in this round's item, not by rewriting deviation 3: the reason that holds
   is that writes from the rest of the event loop would be taken into the transaction.
7. **(B) The finished-task exception is missing in two comments.** The `notifier.ts` comment
   ("is held, not failed ... holds it with its task until the resume") and the `holdFor` docstring
   both need it: "(all but a send for a task already finished)".
8. **(B) README.md ~75 is narrower than the code.** It says "only a finished task's last DM". Use
   the header's wording, "a send for a task already finished".
9. **(A and B) The CHANGELOG bullet.** Rewrite it in this plan doc (you may edit that section) to
   add the two facts below, keeping the rest:
   - "Pausing such a task also holds its other recipients' later copies until the person comes back
     or the owner runs `/task resume`, and the owner is told, as at any pause."
   - "A DM for a task that has already finished, a research answer say, is still not held: it fails
     after about two hours, as before."

**Declined (record the reason under the round-1 heading):**

- Narrowing `affected()` for cost (A): bounded, and not this change's concern.
- B's M5 and M6 (near-equivalent, given `holdFor`).
- B's M9 and M15 (survivors on unchanged lines; noted only).

**Checks:** lint, check, build, `generate-index -- --check`, `bun test plugins/tracker`, `bun test`.
Then run, in a scratch worktree:

- the compare-and-set mutation (plain update);
- dropping the `finally` (notices lost);
- M23;
- M3.

Each must be red. Report the new SHAs, the checks and these mutation results.
