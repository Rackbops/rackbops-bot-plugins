# #214 -- the execute lane's errors name the right route and are logged, Job pruning uses the key, and a bad address is a refusal

Part of Epic #265. Effort S. Behaviour change (an error's text, a new log line, a query plan, a
refusal in place of a TypeError): the three-reviewer gate applies. Part of #214:

- all of `tracker-execute-3` and `tracker-execute-4`;
- `tracker-execute-5` except its header-value validation.

**What stays open on #214.** e-5's check that `TRACKER_CITY_HALL_KEY` and the Access pair are
visible ASCII is not done here. It covers the same secret keys as #202 core-5, whose manifest
`format` waits on the epic's decision 8. The epic pairs the two, so the code check and the manifest
check land together, under one convention.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

1. **e-3.** `createCityHallExecutor`'s `call` (`plugins/tracker/src/executor.ts`) names the route in
   a non-2xx error as `path.replace(/\/[^/]+$/, "/:id")`. That suits the GET path
   (`/api/execute/jobs/<id>`). For the POST to `/api/execute/jobs` it replaces `jobs`, so city-hall's
   400 reads "city-hall answered HTTP 400 to POST /api/execute/:id". docket stores that text as the
   run's "the executor failed: ..." event, which the owner and admins read. `executor.test.ts`
   ("a refused submit or an unknown job id is a plain error ...") pins the GET text exactly, but only
   `toContain("HTTP 400")` for the POST.
2. **e-4.** `JobRecords.prune` runs after every execute tick, about once a minute, even with no work.
   Its join `ON 'o' || o.seq = j.occurrence_id` puts an expression on the occurrences side, so SQLite
   cannot use the `seq` key. It scans every occurrence for each `executor_jobs` row kept, and it does
   so synchronously on the bot's event loop.
3. **e-5, the parts done here.**
   - A network failure in `call`'s `fetch` is mapped to "city-hall could not be reached" and
     `ExecutorUnavailableError` with nothing logged. A header value `fetch` refuses throws a
     TypeError before any I/O, so docket holds the lane forever and an operator sees nothing.
   - In `createPageFetch` (`plugins/tracker/src/fetch.ts`), `new URL(raw)` and
     `new URL(location, url)` throw a bare `TypeError("Invalid URL")` for a malformed input or a
     malformed `Location`. They should throw the `FetchRefusedError` the file promises.
     `price.ts` and `want.ts` turn only `FetchRefusedError` into "I cannot read that page: ...".

### Decisions

- **e-3: `call` takes the route's name from its caller.** Pass the route's name as an explicit
  argument (`"POST /api/execute/jobs"`, `"GET /api/execute/jobs/:id"`) and drop the regex. The
  message becomes "city-hall answered HTTP 400 to POST /api/execute/jobs".
- **e-4: join on the key.**
  - Use `LEFT JOIN occurrences o ON o.seq = CAST(substr(j.occurrence_id, 2) AS INTEGER)`. The
    expression is on the `executor_jobs` side, so each row is one lookup by key.
  - It matches the rows the old join matched, because an occurrence id is `o` + its `seq`
    (`schema.ts` header) and `seq` is an integer with no leading zeros.
  - An `occurrence_id` that is not `o` + digits casts to 0 or to an integer no occurrence has, so
    its record is pruned, as before.
  - No hourly gate; the cost is now one lookup per record kept.
- **e-5, network failures.** `call`'s `catch` logs through the existing `warnOnce` (once an hour)
  under the reason `"unreachable"`. The text is
  `city-hall ${why} (${err.name}); research runs wait until it answers`, then the same
  `ExecutorUnavailableError` as now. Use the error's `name` only, never its `message`: a header
  value `fetch` refused can be echoed in the message, and that value is the key.
- **e-5, bad addresses.** In `createPageFetch`'s `get`, a malformed `raw` throws
  `FetchRefusedError("it is not a web address")`. A malformed `Location` throws
  `FetchRefusedError("it redirects to something that is not a web address")`. These follow the
  file's style (lower case, no full stop), so `price.ts`/`want.ts` say "I cannot read that page: it
  is not a web address.". Catch only the `URL` constructor's throw, nothing around it.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/executor.ts`: the route argument; the join; the logged network failure.
   Update `prune`'s JSDoc only if it describes the join (it does not today).
2. `plugins/tracker/src/fetch.ts`: the two refusals.
3. Tests:
   - `executor.test.ts` "a refused submit or an unknown job id is a plain error ...": the POST's
     message is pinned exactly ("city-hall answered HTTP 400 to POST /api/execute/jobs"). The GET
     line stays as it is.
   - `executor.test.ts`, new: **"a fetch that fails before city-hall answers is logged once an hour,
     by the error's name only"**.
     - Use a `fetchImpl` that throws a `TypeError` whose message holds the key.
     - Two calls in the same hour give one `log.error` holding "could not be reached (TypeError)" and
       not the key.
     - A third call over an hour later logs again.
     - Every call still rejects with `ExecutorUnavailableError`.
     - Also cover a timeout (an `AbortSignal.timeout`-style `TimeoutError`): it logs "timed out".
   - `executor.test.ts` "JobRecords.prune (review of #110)":
     - The existing case stays green as it is.
     - New: **"prune looks each record's run up by its key"**. `EXPLAIN QUERY PLAN` of the prune
       query names `o` with a `SEARCH ... USING INTEGER PRIMARY KEY` (or `INTEGER PRIMARY KEY`),
       not a `SCAN` of occurrences. Export the SQL as a module constant only if needed to run the
       plan, and say so under Deviations.
     - New: **"an occurrence id that is not o + digits is pruned"**: a record with `occurrence_id`
       `"x1"` is pruned, and so is one with `"o"`.
   - `fetch.test.ts` (or wherever `createPageFetch` is tested):
     - **"a malformed address is refused, not thrown as a TypeError"**: `get("not a url")` rejects
       with a `FetchRefusedError` whose message is "it is not a web address".
     - **"a redirect to a malformed Location is refused"**: a 302 whose `Location` is `"http://["`
       rejects with `FetchRefusedError("it redirects to something that is not a web address")`.
   - `price.ts` or `want.ts` path: one test that `/price` (or the rule function it calls) with a
     page that redirects to a malformed Location answers "I cannot read that page: it redirects to
     something that is not a web address." Use the nearest existing redirect test as the model. If
     the URL check (`urlProblem`) already refuses every malformed `raw` before `get`, say so under
     Deviations, keep the `get` unit test, and pin the redirect case end to end only.
4. This file, committed as `docs/plans/214-execute-errors-say-what-happened.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
6. Mutations from the table, each in a scratch worktree (foreground, removed after), never in the
   tree under test.
7. Review gate: you plus two read-only reviewers. The gate passes at 2 of 3. Every evidenced finding
   is fixed or declined in writing, in four rounds at most.
   - **A, correctness and failure modes:**
     - whether the new join can match a different row than the old one;
     - whether `warnOnce`'s hour gate can hide a credential error or be hidden by one (they have
       separate reasons);
     - whether any `err.name` can carry the key;
     - whether a caught `URL` throw can mask another error;
     - every caller of `createPageFetch().get`.
   - **B, claims against the code:** comments, README, the bullet, every coverage row, mutation
     survivors.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A refused POST names its own route | 1 | "a refused submit ..." (exact POST text) | restore the regex |
| A refused GET keeps its text | 1 | the same (exact GET text) | pass the POST's route to the GET |
| Prune looks runs up by key | 1 | "prune looks each record's run up by its key" | restore `'o' \|\| o.seq = j.occurrence_id` |
| Prune drops what it dropped before | 1 | the existing prune case, and "... not o + digits is pruned" | `CAST(substr(j.occurrence_id, 1) ...)` |
| A network failure is logged, once an hour | 1 | "a fetch that fails before city-hall answers ..." | drop the `warnOnce` call |
| The log never holds the error's message | 1 | the same (the key is absent) | log `err.message` in place of `err.name` |
| A malformed address is a refusal | 2 | "a malformed address is refused ..." | remove the `new URL(raw)` catch |
| A malformed Location is a refusal | 2 | "a redirect to a malformed Location ..." and the end-to-end case | remove the `new URL(location, url)` catch |

## CHANGELOG bullet (for the PR body)

- A research run that city-hall refuses on submission now names the right route ("POST
  /api/execute/jobs") in the run's error (#214).
- When city-hall cannot be reached at all, the tracker logs it once an hour instead of saying
  nothing (#214).
- The minute's clean-up of finished Job records no longer reads every run in the database (#214).
- A page address, or a redirect, that is not a web address gets "I cannot read that page" instead
  of an unexplained error (#214).

## Deviations as implemented

1. **The join keeps the old comparison as a filter.**
   - Finding: `o.seq = CAST(substr(j.occurrence_id, 2) AS INTEGER)` alone matches rows the old
     join did not. `substr` drops whatever the first character is, and `CAST` takes the leading
     integer, so `x1`, `o01`, `o1abc`, `o 1`, `o1.5` and `o1e3` all find occurrence 1 (checked in
     Bun 1.4.2's SQLite; the old join finds none of them). The Decisions bullet "casts to 0 or to
     an integer no occurrence has" is false for `x1`, and the plan's own "x1 is pruned" test fails
     against this join when occurrence 1 is a run still out.
   - What I did: the join is
     `ON o.seq = CAST(substr(j.occurrence_id, 2) AS INTEGER) AND j.occurrence_id = 'o' || o.seq`,
     with a two-line comment in `prune` (its JSDoc is unchanged). The "x1" test points `x1` at a
     queued occurrence 1 beside a kept `o1`, so it fails if the second term goes.
   - Why: the first term is still the key lookup. `EXPLAIN QUERY PLAN` still reads
     `SEARCH o USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN`. The second term then checks only the
     one row found. With it, the join matches exactly the rows the old one did: for an integer
     `seq`, `id = 'o' || seq` already implies the first term.
2. **A thrown value that is not an `Error` is logged by its `typeof`.**
   - Finding: `catch (err)` gives `unknown`, so `err.name` does not type-check, and a non-`Error`
     has no name.
   - What I did: the text is `(${err instanceof Error ? err.name : typeof err})`.
   - Why: this is the smallest guard that never logs the thrown value itself.
3. **Only the redirect case runs end to end.**
   - Finding: `urlProblem` refuses every malformed `raw` before `get` is called. `/price` runs it in
     `startPrice` and `/want` in `startWant`, and the web editor calls both.
   - What I did: kept the `get` unit test for a malformed address. The end-to-end case is the
     redirect only: `/price` over the real `createPageFetch` and a fake network.
   - Why: to run that case, `tracked.test.ts`'s `world()` takes an optional `reader` in place of
     its fake page reader.
4. **Comments outside the named steps now say what the code does.**
   - Finding: four comments described logging and routes that this change alters.
   - What I did:
     - `warnOnce`'s JSDoc and `CREDENTIAL_LOG_EVERY_MS`'s doc say "credential, edge or network
       problem".
     - The module header says an unreachable or timed-out city-hall is logged once an hour, by the
       error's name only.
     - `call`'s JSDoc names the `route` argument.
   - Why: they would be wrong otherwise.

The plan allowed exporting the prune SQL. That was not needed: the plan test wraps the test
database's `query` to get the SQL `JobRecords` sends, then asks SQLite for its plan.
