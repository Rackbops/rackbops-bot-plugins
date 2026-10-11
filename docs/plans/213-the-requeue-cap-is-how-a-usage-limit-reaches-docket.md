# #213 -- the docs name city-hall's requeue cap as the way a `usage_limit` result reaches docket

Part of Epic #265. Effort XS. Docs plus one test, with no behaviour change, so the single-auditor
lane applies. Closes #213 (finding `tracker-execute-2`).

**Stacked on #214.** This branch, `ccr-de9d9c44-hgkav1-213`, starts from `ccr-de9d9c44-hgkav1-214`
(PR #282, at `f4ce109`), because both edit the `executor.ts` header and the README's city-hall
paragraphs. Its PR's base is that branch; once #282 merges, the base becomes `main`.

## Plan (execute as written)

Written 2026-10-11 against `ccr-de9d9c44-hgkav1-214` at `f4ce109`, and against city-hall `main` at
`074cda1` (2026-10-05). city-hall is cloned read-only at `/home/user/city-hall`: read it there, and
never write in it.

### What city-hall does (verified at `074cda1`)

- **The requeue cap.** `src/server/lib/jobs.ts` `outcome()`: a run that ends in `auth_failed` or
  `usage_limit` (`REQUEUE_KINDS`) requeues the job, with its result stored, until the number of
  runs ending that way exceeds `maxRequeues`. `maxRequeues` is `CITY_HALL_MAX_REQUEUES`, default 10
  (`src/server/lib/config.ts:64`; README line 38). Past that cap the job ends `failed`, with that
  run's result kept and the error `requeued <n> times after auth_failed or usage_limit`.
- **The lease cap.** `expireLeases()`: an expired lease requeues the job until `expired >=
  maxExpiredLeases` (`CITY_HALL_MAX_EXPIRED_LEASES`, default 3). Then the job ends `failed` with
  the error `lease expired <n> times`. The `result` column is left as it was, so a result stored by
  an earlier requeued run stays.

### What is wrong

- `plugins/tracker/src/executor.ts`'s header says, unscoped, that city-hall requeues a claim that
  ended in `usage_limit` or `auth_failed`, "so docket never sees that result".
- The README paragraph **A runner that stops: city-hall requeues, the tracker waits** names only
  the lease cap (`CITY_HALL_MAX_EXPIRED_LEASES`). It says docket's usage-limit pause applies only
  when a job "later fails at its maximum of expired leases" with the result still stored.
- The main route is the requeue cap: past `CITY_HALL_MAX_REQUEUES` (default 10) such claims, the
  job fails with the `usage_limit` (or `auth_failed`) result kept, and docket sees it. An operator
  reading the docs looks only at the lease setting.

### Changes

1. **`executor.ts` header.**
   - The `queued` bullet becomes: city-hall requeues a claim that ended in `usage_limit`,
     `auth_failed` or an expired lease, so docket does not see that result while the job is
     requeued.
   - Add a clause, or a line in the `failed` bullet: past `CITY_HALL_MAX_REQUEUES` (city-hall's
     default 10) such claims, or `CITY_HALL_MAX_EXPIRED_LEASES` (default 3) expired leases,
     city-hall fails the job and keeps the last stored result. `failed` then answers that result
     (`answerFor`), so a `usage_limit` reaches docket and its usage-limit pause applies.
   - Keep the header's other sentences.
2. **README**, the paragraph named above.
   - Name both caps, the requeue cap first, as the main way a `usage_limit` or `auth_failed` result
     reaches docket. The lease cap is the other way (with the result an earlier requeued run left).
   - Keep "under city-hall#18 as merged" only if it is still true. Otherwise cite city-hall `main`
     by behaviour, not a commit.
   - Say that at the default 10 requeues the job can fail well before the tracker's own 48-hour
     hold (`PAUSED_CAP_MS`) runs out. Say it only if the code shows it; otherwise leave it out.
3. **Test**, in `executor.test.ts` beside the existing `failed`-job tests: **"a job city-hall failed
   at its requeue cap answers its stored usage_limit result, so docket's usage-limit pause
   applies"**.
   - City-hall answers `status: "failed"`, a `usage_limit` result in the shape city-hall stores, and
     the error `requeued 10 times after auth_failed or usage_limit`.
   - `executor.run(null, ...)` resolves with a `usage_limit` JobResult, not an `error` result
     carrying the error text.
   - Add the same for `auth_failed` if it is one more line.
   - If the existing tests already pin exactly this, say so under Deviations and add only what is
     missing.
4. **Not changed:** `plugins/tracker/CHANGELOG.md`. A released entry is not rewritten, and the epic's
   one docs PR lands the Unreleased bullets.

### Steps

1. The edits and the test above. This file is committed as
   `docs/plans/213-the-requeue-cap-is-how-a-usage-limit-reaches-docket.md`.
2. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
3. One mutation, in a scratch worktree (foreground, removed after): make `answerFor` answer a
   `failed` job with an `error` result whenever `job.error` is set. The new test must go red.
4. Single auditor (read-only): every changed sentence is checked against the tracker's code and
   city-hall `main` at `/home/user/city-hall`.

## CHANGELOG bullet (for the PR body)

Docs: the README and the executor's notes now say that city-hall fails a job, with its
`usage_limit` or `auth_failed` result kept, once more than `CITY_HALL_MAX_REQUEUES` of its claims
(default 10) have ended that way. That, more than the lease limit, is how docket's usage-limit
pause comes into play (#213).

## Deviations as implemented

City-hall cites are `/home/user/city-hall` at `074cda1` unless a commit is named; tracker cites are
this branch.

1. **The two caps count differently, so the lease cap is "at", not "past".** The plan's header
   clause read "past `CITY_HALL_MAX_REQUEUES` (default 10) such claims, or
   `CITY_HALL_MAX_EXPIRED_LEASES` (default 3) expired leases". The requeue cap fails a job when
   its claims ending in `usage_limit` or `auth_failed` *exceed* the maximum (`misses >
   maxRequeues`, `src/server/lib/jobs.ts:161-162`: the eleventh such claim, with the error
   `requeued 10 times ...`, `:165`); the lease cap fails it when its expired leases *reach* the
   maximum (`expired >= maxExpiredLeases`, `:185-186`: the third). "Such claims" also read back to
   the `queued` bullet's list, which includes an expired lease. -> The header says "once more than
   `CITY_HALL_MAX_REQUEUES` of its claims ... have ended in `usage_limit` or `auth_failed`, or once
   `CITY_HALL_MAX_EXPIRED_LEASES` of its leases ... have expired"; the README says the next claim
   after the maximum number of requeues fails the job, "as does the expiry that brings its expired
   leases to their configured maximum". -> "Past three expired leases" would mean a fourth.
2. **At the lease cap there may be no stored result.** The plan: city-hall "keeps the last stored
   result". `expireLeases()` never writes `result` (`jobs.ts:189-191`), so a job whose claims all
   lost their leases fails with `result` null, and `failed` then answers an `error` carrying
   `lease expired 3 times` (`executor.ts:379`, already pinned at `executor.test.ts:179-180`). ->
   The header says "keeping the last result stored for it, if any". -> Without "if any" it claims
   a result that is not always there.
3. **"Reaches the tracker" became "reaches docket".** city-hall stores a requeued claim's result
   too (`jobs.ts:163-172` writes `result` with status `queued`) and `GET /api/execute/jobs/:id`
   returns it (`job-rows.ts:48`, `routes/execute.ts:72-76`), so it does reach the tracker while
   the job is queued; the tracker just does not answer it (`requeuedBy`, `executor.ts:365`). ->
   The README says "a `usage_limit` result that reaches docket", this plan's own words. -> Once
   the paragraph describes the requeue path, "reaches the tracker" is loose.
4. **"under city-hall#18 as merged" is dropped (the plan's own condition).** At `90a06ec`
   (city-hall#18 as merged) `outcome()` requeued `usage_limit` and `auth_failed` with no limit
   (`jobs.ts@90a06ec:153-154`; there is no `maxRequeues`); the cap came with city-hall#22
   (`8866b35`, 2026-10-02). The phrase is true of #18 but not of city-hall now. -> Dropped; the
   README describes city-hall's behaviour and names no commit. -> As the plan directs.
5. **"Can fail well before the 48-hour hold runs out" is left out (the plan's own condition).**
   city-hall's cap counts claims, not time (`jobs.ts:161-162`), and a requeued job can be claimed
   at once (`claim()`, `jobs.ts:97-129`), so how soon the eleventh such claim comes is how often
   the runner claims again: docket-runner's code, in neither repo. -> Not written. -> The plan says
   to say it only if the code shows it. For the auditor: a cap reached after the tracker's hold
   has run out is never collected. Past `PAUSED_CAP_MS` the Job answers pending
   (`executor.ts:514-519`) and docket's give-up, counted from the submission, ends the run on that
   ask (docket-core 0.7.0 `dist/dispatch.js`, `collect()`, `:917-929`). So "reaches docket" holds
   while docket still asks; a runner that waited out a five-hour window before each new claim
   would reach the default cap after the hold. The docs do not say this, since it turns on the
   runner; a reviewer may want it raised.
6. **The test also asks once while the job is still queued, and covers `auth_failed`.** The plan's
   test answers `failed` only. -> The new test first answers the job `queued` with the same result
   stored and `lastOutcome` set, as city-hall does after a requeue, and checks it is unavailable;
   then it answers `failed` with the cap's error and checks the stored result comes back as it is;
   it loops over `usage_limit` and `auth_failed`. -> That is the order city-hall goes through, and
   it covers `pausedOrAnswer` handing a `failed` Job to `answerFor` after a pause
   (`executor.ts:513`). No existing test had a failed job with both a result and an error (the one
   with an error has `result: null`, `executor.test.ts:179-180`): under step 3's mutation only the
   new test goes red (tracker: 510 pass, 1 fail; it received `{ kind: "error", detail: "city-hall:
   requeued 10 times after auth_failed or usage_limit", durationMs: 0 }`).
7. **The CHANGELOG bullet above says "once more than ... have ended that way".** It read "after
   `CITY_HALL_MAX_REQUEUES` such claims", which reads as the tenth; city-hall fails the job on the
   eleventh (1 above). -> Reworded, same sense otherwise.
8. **The header's `queued` bullet is rewrapped.** Its words after the changed parenthetical are
   unchanged (`git diff --word-diff` moves only the `*` markers).
