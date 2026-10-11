# #203 (with #202 core-3) -- the execute lane runs every host tick, a failed start closes its database, and a stop waits for the tick in flight

Part of Epic #265. Effort S. Behaviour change (execute cadence, activate failure, dispose wait):
the three-reviewer gate applies. Closes #203 (core-2 and core-4); part of #202 (its finding
`tracker-core-3` only; core-5 waits on decision 8, core-6 is the docs child).

**Overlap with Epic #266.** The forget-me child there (#172 with #160) may change `lanes.idle`, which
this plan reuses in `dispose()`. Whichever PR lands second rebases onto the other; nothing here
changes `lanes.idle` itself.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name in
`plugins/tracker/src/index.ts` unless another file is named.

### What is wrong

1. **core-2: the execute lane skips about every other round.** The host runs every plugin's checks
   from one 60 s `setInterval` and awaits them in order. So the tracker's `execute` tick is called at
   "round start + the time every earlier check took", which differs per round. The tracker's own
   `poll` tick alone can take up to its 30 s bound. `startExecute` returns early when
   `at - lastExecute < EXECUTE_EVERY_MS` (60 000). Whenever this round's earlier checks were faster
   than the last round's, even by 1 ms, the gap is under 60 s and the lane does not start. Research,
   scout and want-judge hand-offs and Job pickup then wait about two minutes instead of one.
   `executeRun` already prevents two runs at once. Tests advance the clock 61 s, so none of them can
   see this.
2. **core-4: a late failure in `activate()` leaks the database.** Only the first half of `activate()`
   (migrations, admins, `recover()`) is inside the `try { ... } catch { opened.close(); throw }`.
   After it, the closure's handles (`db`, `store`, `inbox`, `delivery`, `jobRecords`, `executeLane`,
   `deps`) are assigned one by one between calls that can throw: `databaseId(opened)` runs SQL,
   `createCityHallExecutor`, `new ExecuteLane`, and the host's log calls. If one throws, `activate`
   rejects with the connection open. The host never calls `dispose()` for a plugin whose `activate`
   threw, so the handle and a WAL reader leak for the process's life. The handles assigned before
   the throw also stay set, so a tick the host still calls finds a live `store`. The one activate
   failure test covers only a migration failure, and it does not check that anything closed.
3. **core-3: `dispose()` waits on the wrong things for the wrong time.**
   - (a) It waits up to 5 000 ms for the execute run. The host bounds each plugin's dispose at
     `PLUGIN_DISPOSE_TIMEOUT_MS` = 2 000 and then moves on to closing the gateway and exiting. So
     the comment's "past 5 s it is asked again after the restart" is untrue past 2 s.
   - (b) It never waits for a notify or poll tick in flight, though forget-me does (`lanes.idle`).
     Such a tick holds the store it read. If it is mid-DM when the database closes, its write that
     settles the delivery throws, the delivery stays `claimed`, and the next start logs "...
     unconfirmed ...; it will not be resent" for a DM the person did get.
   - (c) The comment "a tick the host abandoned ... finds no store and returns" holds only for a tick
     that has not yet read `store`. The test "a tick after dispose, or one the host abandoned across
     it, touches nothing" runs only a tick after dispose.

### Decisions

- **core-2: a half-minute floor, not a minute.** `startExecute` skips only when
  `at - lastExecute < EXECUTE_EVERY_MS / 2`. A second call within one round is still refused, and
  any jitter under 30 s no longer skips a round. Dropping the check would also work, but tests that
  call the ticks twice without moving the clock would then start the lane twice, and the README's
  claim would change. `EXECUTE_EVERY_MS` stays as the cadence that `locks.ts` and `notify-lane.ts`
  name, unchanged.
- **core-4: everything after `openDatabase` is inside the `try`, and the closure's handles are
  assigned only at the end.** Build each handle as a local (`jobRecords`, the executor, the lane, the
  `DeliveryHealth`, the `WantInbox`, `deps`). Make the log lines and every other call that can
  throw. Then assign every closure variable in one block with nothing that can throw in it, and set
  `health.blocked`/`health.activatedAt` last as now. The `catch` closes `opened` and rethrows, as
  it does now. A failed start then leaves every handle null, and the database is closed.
- **core-3: `dispose()` waits for every tick in flight, up to `DISPOSE_WAIT_MS` = 1 500, then closes.**
  - It nulls the handles first, as now.
  - Then it does `await lanes.idle(DISPOSE_WAIT_MS)`. That covers notify, poll and execute: all
    three go through `tracked`.
  - This replaces the execute-only 5 s wait. 1 500 leaves the host's 2 000 bound room for the
    close.
  - Export `DISPOSE_WAIT_MS` from `index.ts` for the tests.
  - Reword the comments to what is true:
    - A tick that starts after the handles are nulled finds no store and returns.
    - A tick already running keeps the store it read, so dispose waits for it.
    - A tick still running after 1.5 s can fail its last write. A send it made is then logged
      unconfirmed at the next start and not resent.
    - The host stops waiting at 2 s.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/index.ts`: the three changes above.
   - `startExecute`'s JSDoc says "at most once per host tick (a second call within half a minute is
     skipped)" in place of "at most once per `EXECUTE_EVERY_MS`". Give the reason in one line: the
     host's ticks are a minute apart from each round's start, and this tick runs after every earlier
     check of the round.
2. `plugins/tracker/src/execute-lane.ts` header ("at most once per `EXECUTE_EVERY_MS`"): the same
   correction. `plugins/tracker/README.md` Execute lane row: "(one at a time, at most once a minute)"
   becomes "(one at a time, once per host tick, about a minute)".
3. Tests (`plugins/tracker/src/index.test.ts` unless a nearer harness drives the execute tick; the
   tests that advance 61 s, e.g. `web/admin.test.ts` ~633 and `wantjudge.test.ts` ~45, show how):
   - **"the execute lane starts on a host tick that comes a little under a minute after the last"**:
     with an injected executor, run the `execute` tick, let its run settle, advance the clock
     59 950 ms, and run it again. The lane starts a second time (count starts with
     `options.executeStarted`, or the executor's calls).
   - **"a second execute tick within half a minute starts nothing"**: advance 29 999 ms, and nothing
     starts. Then advance 1 ms more (30 000 in all), and it starts.
   - **"a start that fails after the database opened closes it and keeps nothing"**: use a fake host
     whose `log.warn` throws on the "TRACKER_GUILD_ID is unset" line. That is the last call in
     `activate()`, after every handle used to be set; leave `TRACKER_GUILD_ID` unset to reach it.
     Then check:
     - `activate()` rejects with that error.
     - `/healthz` is 503.
     - A `notify` tick with a reminder due sends no DM. Seed the reminder through a first, healthy
       activate and dispose, if that is the simplest way.
     - The database is closed. Pick the observable that would fail without the fix: the `-wal` file
       is gone after the failed activate (SQLite removes it when the last connection closes; WAL is
       on for a file database, `schema.ts` `openDatabase`), or another one you find. Record which one
       under Deviations if it is not the `-wal` file.
     - Also add the same check with a throw in the middle (the "execute lane on: city-hall" info
       line, with `TRACKER_CITY_HALL_*` set as the existing tests set them), so a handle assigned
       part way is covered too.
   - **"dispose waits for a notify tick in flight, so its DM is recorded as sent"**:
     - Use a fake host whose `dm` waits on a gate the test holds.
     - Start a `notify` tick with a reminder due, and wait until `dm` is called.
     - Call `dispose()` without awaiting it, release the gate, then await `dispose()`.
     - Reopen the database: the delivery is `sent`, not `claimed`.
     - A second start logs no "unconfirmed" line.
   - **"dispose stops waiting after `DISPOSE_WAIT_MS`"**: the same, but the gate is released only
     after `dispose()` resolves. `dispose()` resolves in under 2 000 ms of real time, and in at least
     `DISPOSE_WAIT_MS` - 50. Release the gate afterwards so the tick ends; its failed write is
     expected and must not fail the test.
   - **Rename** "a tick after dispose, or one the host abandoned across it, touches nothing" to "a
     tick that starts after dispose touches nothing", with its body unchanged.
4. This file, committed as `docs/plans/203-the-tracker-starts-ticks-and-stops-cleanly.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
6. Mutations from the table, each in a scratch worktree (foreground, removed after), never in the
   tree under test.
7. Review gate: you plus two read-only reviewers.
   - **A, correctness and failure modes:** whether any path still leaves a handle set or the database
     open on a failed `activate`; whether `lanes.idle` in `dispose` can hang or reject; a second
     `activate` after a failed one; forget-me's `excludeExecute` against the new gap; whether
     `DISPOSE_WAIT_MS` fits the host's bound (rackbops-discord-bot `src/index.ts`
     `PLUGIN_DISPOSE_TIMEOUT_MS`, read from the network if needed).
   - **B, claims against the code:** comments, README, the bullet, every coverage row, mutation
     survivors.
   - The gate passes at 2 of 3. Every evidenced finding is fixed or declined in writing, in four
     rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A tick a little under a minute after the last starts the lane | 1 | "... a little under a minute after the last" | restore `< EXECUTE_EVERY_MS` |
| Two calls within 5 s start one run (round 1: was half a minute) | 1 | "a second execute tick within 5 s starts nothing" | drop the time check |
| A round after one whose earlier checks ran 30 s longer still starts the lane (round 1) | 1 | "a round after a slow one still starts the lane" | restore `EXECUTE_EVERY_MS / 2` |
| A late failed start closes the database | 1 | "a start that fails after the database opened ..." | move the `catch`'s end back to after `recover()` |
| A late failed start keeps no handle (no tick runs; round 1: no command reads) | 1 | the same | assign `store` before the log lines again; (round 1) assign `deps` before the guild log line |
| Dispose waits for a notify tick in flight | 1 | "dispose waits for a notify tick in flight ..." | wait only on `executeRun`, as before |
| Dispose's wait is bounded below the host's 2 s | 1 | "dispose stops waiting after `DISPOSE_WAIT_MS`" | `DISPOSE_WAIT_MS` = 5 000; (round 1) `DISPOSE_WAIT_MS` = 10 |
| A tick after dispose touches nothing | -- | the renamed test | drop the `if (!store) return` in `tick` |

## CHANGELOG bullet (for the PR body)

- The execute lane no longer skips about every other host tick when the bot's other checks take
  longer one minute than the next, so research, scout and want-list judging are picked up each minute
  again (#203).
- A start that fails part way now closes the database it opened (#203).
- Stopping the bot now waits up to 1.5 s, before closing the database, for tracker work the host's
  own stop no longer waits on (an execute-lane run, or a reminder or page tick past the host's 5 s
  grace), so a DM it sent is recorded as sent rather than reported unconfirmed at the next start
  (#202).

## Deviations as implemented

1. **The due reminder is seeded straight into the data file, not through a first healthy start.**
   Finding: the plan left this open ("if that is the simplest way"), and `index.test.ts` already
   seeds a data file before any start with `openDatabase` and `SqliteStore` (its recovery tests).
   What I did: a `seedDueReminder(dataDir)` helper does that, closes its connection, and returns the
   occurrence's id; the failed-start and both dispose tests share it. Why: one helper and no second
   plugin, and nothing else is open on the file when the start under test begins, so the `-wal`
   check sees only that start's connection. The `-wal` file is the observable, as planned.
2. **`health.activatedAt`'s time is read just before the assignment block.** Finding: the handles
   are assigned "in one block with nothing that can throw in it", with `health.*` set last "as now",
   but `health.activatedAt = clock.now()` calls the clock. What I did: `const activatedAt =
   clock.now()` after the last log line, and `health.activatedAt = activatedAt` last in the block.
   Why: the block stays free of calls; the instant is the same with the injected clock and within
   microseconds with the real one.
3. **The failed-start test runs every tick the plugin has, and also checks the execute lane starts
   nothing.** Finding: the part-way case sets `TRACKER_CITY_HALL_*`, so that plugin has an `execute`
   tick, and `executeLane` was one of the handles set before that throw. What I did: both cases run
   `notify`, `poll` and (when present) `execute`, then expect no DM and no `executeStarted` call. The
   two cases are one `it` through a local `failedStart(line, env)`. Why: it covers `store` and the
   close on the city-hall path (`JobRecords`, `databaseId` and the executor are built); `executeLane`
   set alone cannot be seen through a tick, since `startExecute` checks `store` first. One `it` keeps
   the Coverage table's single test name. (This Why corrected in round 1, item 11.)
4. **"dispose stops waiting after `DISPOSE_WAIT_MS`" has a 10 s test timeout.** Finding: bun's
   default per-test timeout is 5 s, the same as the mutation's `DISPOSE_WAIT_MS` = 5 000, so that
   mutation would fail on the timeout rather than on the bound. What I did: `it(..., 10_000)`. Why:
   the mutation then fails on `expect(took).toBeLessThan(2_000)`, the assertion its row names.

### Review gate round 1

Reviewers A and B: SOUND, Minors only. Everything above this heading stays as written, except the
Coverage rows marked "(round 1)", the third CHANGELOG bullet (replaced, since the PR body takes it)
and deviation 3's Why (corrected); each change is listed here.

5. **(A, Minor M1) The half-minute floor still skips a round after a slow one.** Finding: a round
   whose earlier checks ran 30 s or more longer than the next round's (the tracker's own `poll` tick
   can take its 30 s bound; the host's `guardedTick` already skips a round while one runs) puts the
   next execute call under 30 s after the last, e.g. +30.5 s then +60.1 s, a gap of 29.6 s. Fix
   (the orchestrator's decision): `execute-lane.ts` exports `EXECUTE_MIN_GAP_MS` = 5 000, well under
   a host round, and `startExecute` skips only within it of the last start. So the Decision "core-2:
   a half-minute floor, not a minute" now reads, as implemented: a 5 s floor; a second call in one
   round is still refused, and only a round whose earlier checks ran 55 s or more longer than the
   next's still costs the next its run (the constant's doc says so). `startExecute`'s JSDoc and the
   `execute-lane.ts` header name the constant. `EXECUTE_EVERY_MS` stays exported as the round's
   cadence, now referenced by no code. Tests: "a second execute tick within half a minute starts
   nothing" became "a second execute tick within 5 s starts nothing" (4 999 ms refused, 5 000 ms
   starts), and "a round after a slow one still starts the lane" is new (a start, then a call
   29 600 ms later starts again). The Coverage rows are updated in place.
6. **(B, Minor 4) The README row overstated the cadence.** Fix: `README.md` Execute lane row now
   says "(one at a time, at most once per host tick, about a minute)".
7. **(A N1, B Minor 3) The host's stop already waits for notify and poll ticks.** Finding: the host
   aborts its ticks on stop and drains them for up to 5 s (`PLUGIN_TICK_ABORT_GRACE_MS`) before it
   calls `dispose()`, so the new wait matters for the background execute run and for a tick past
   that grace. Fix: the third CHANGELOG bullet is replaced with the text above. `dispose()`'s comment
   says the host aborts and drains its ticks first and that 2 s is the host's per-plugin bound on
   dispose. Note on What is wrong 3(b): it holds for what the host's stop does not already wait on,
   that is, a notify or poll tick still mid-DM after the host's 5 s grace, and the execute lane's
   background run, which the host never waits on.
8. **(A N2) The "nothing can throw" block read `typeof host.dm`.** Fix: `health.blocked = dm ? null :
   "..."`, from the `dm` the closure already holds.
9. **(B Minor 1, survivor S6) Assigning `deps` before the guild log line survived.** Fix: the
   failed-start test also expects `/tasks` to answer "The tracker is starting up; try again in a
   minute." (`slash` from `web/harness.ts`). Mutation row added to the Coverage table.
10. **(B Minor 2, survivor S3b) `DISPOSE_WAIT_MS` = 10 survived.** Fix: the bounded-wait test also
    expects `DISPOSE_WAIT_MS` to be 1 500, so the bound is pinned absolutely, not only relative to
    itself. Mutation added to the Coverage table.
11. **(B Minor 5) Deviation 3's Why claimed the test covers `executeLane`.** Fix: corrected in place
    to what the test does cover (`store` and the close on the city-hall path); `executeLane` set
    alone cannot be seen through a tick, since `startExecute` checks `store` first.
12. **(B nits 6, 7) Two lines of the plan's own text were wrong.** Recorded here; the text above is
    left as written. Decisions, core-2: "`EXECUTE_EVERY_MS` stays as the cadence that `locks.ts` and
    `notify-lane.ts` name" should read "`EXECUTE_EVERY_MS` stays as the host's 60 s round, which
    execute-lane.ts's header ('they send a minute later') and locks.ts's `TASK_BUSY` ('try again in
    a minute') describe". What is wrong 2: the first half of `activate()` inside the `try` was "(the
    vacuum, admins, `recover()`)", not "(migrations, admins, `recover()`)"; the migrations run in
    `openDatabase`, before it.
13. **Declined as harmless or equivalent:** survivors S2b, S8, S9, S11, S12 and S13, for the reasons
    reviewer B gave in round 1:
    - S2b (`DISPOSE_WAIT_MS` = 1 900): still under the host's 2 s bound. It no longer survives:
      item 10's pin fails it (expected 1 500, received 1 900).
    - S8 (`executeLane` assigned part way): equivalent through ticks, since `startExecute` checks
      `store` first.
    - S9 (`lastExecute` set before the `executeRun`/`store` guard): harmless and unchanged from
      `main`; with the floor, the next host tick still starts the lane.
    - S11 (`inbox`, `delivery` or `jobRecords` assigned part way): harmless, as they are read only by
      ticks that check `store` first, or through `deps`.
    - S12 (`db` assigned part way): harmless, as only `dispose` reads it and the host never disposes
      a plugin whose `activate` threw.
    - S13 (`dispose` nulls `store` after the close): not changed by this PR, and harmless, since the
      host starts no tick once a stop is under way.
