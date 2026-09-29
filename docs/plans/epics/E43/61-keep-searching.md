# #61 -- keep searching when the first query's best match isn't confident

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #56 has merged** (the replay runs through `findSong`). Independent of the
`matching.ts` chain (#57-#60): it edits `build.ts` only, and may run in parallel with them.

## Plan (execute as written)

### Decisions

- **Better** = higher confidence first (`high` > `medium` > `low`), then higher score; on a full
  tie the earlier query's match stands (the filtered query is the more precise one). Exported as
  `betterMatch(a, b)` from `build.ts` so #63/#64 reuse the same comparator across artist names.
- **Stop at `high`.** The loose query runs only when the filtered query's best is not `high` or
  there is none. Worst case per song stays 2 requests (50 for a 25-song setlist, the number the
  `buildPlaylist` comment already states); the common case stays 1. What changes is that a
  `medium`/`low` on the first query no longer *prevents* the second.
- **`Match` gains `score: number`** (the winning candidate's `scoreCandidate`), so `betterMatch`
  needs no re-scoring; additive.
- **Trace:** `queries` is recorded whenever more than one query was issued, so a `high` found by
  the second query keeps the page that missed and the page that hit (this is what the operator step
  reads). A first-query `high` still omits `queries`. `hitQuery` stays the index into `queries` of
  the winning query. The CHANGELOG states the change to what `queries` holds.
- Corpus effect: the replay serves the logged pages by exact query string; songs whose second
  query was never issued in the log get an empty page for it, so their picks cannot change. The
  tally stays 14 / 3 / 10 (or whatever it is when this lands -- paste it). *Heartbreaker* stays on
  the duet until #63 (its loose query was never logged, so the replay cannot show otherwise).
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`: `Match` gains `score`; `pickBestTrack` sets it from the winning
   candidate's score. (One line each -- no ranking change; coordinate by landing after whichever of
   #57-#60 is open, or rebase.)
2. `plugins/music/src/build.ts`
   - `export function betterMatch(a: Match, b: Match): Match` per the decision (rank map
     `{ high: 2, medium: 1, low: 0 }`, then `score`, then `a`).
   - `findSong`: keep `best: { match: Match; hitQuery: number } | undefined`; for each query:
     search, record, `const found = pickBestTrack(...)`; if found, `best = best === undefined ||
     betterMatch(found, best.match) === found ? { match: found, hitQuery: i } : best`; `break`
     when `best.match.confidence === "high"`. After the loop build the trace as today from `best`;
     `queries` attached when `queries.length > 1 || outcome !== "high"`. Error handling unchanged.
   - Doc comments on `findSong` (the rule and the cost bound) and `SongTrace.queries`.
3. `plugins/music/src/build.test.ts`
   - `a medium on the first query keeps searching and a high on the second wins` -- q0 page yields
     a partial-artist exact title (`medium`), q1 the exact track (`high`); pick is the `high`,
     `hitQuery: 1`, `queries` has both.
   - `a high on the first query issues exactly one search` -- count `searchTracks` calls.
   - `two loose matches: the more confident wins, then the higher score, then the first` -- three
     small cases through `betterMatch` directly plus one through `findSong`.
   - `a high reached by the second query keeps both pages in the trace`.
   - Existing `a high match records the pick and hitQuery but no candidate lists` (first query
     empty, second `high`) now expects `queries` to be present with two entries -- update it and
     name the change; `a loose match keeps its candidate lists` is unchanged.
4. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed` (#61), including the `queries`
   retention.
5. Commit this plan at `docs/plans/epics/E43/61-keep-searching.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| First query `medium`, second `high` -> the `high` is picked, both queries traced | 2, 3 | `a medium on the first query keeps searching...` | `break` on any match |
| A first-query `high` issues exactly one search | 2, 3 | `a high on the first query issues exactly one search` | remove the `high` break |
| Mutation check in a scratch worktree: restore stop-at-first-match | -- | first mutation, detached worktree | -- |
| Operator step on `debug` (Heartbreaker trace with both queries) | -- | manual, orchestrator, after release | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally.

### Risks

- Quota: a setlist full of `medium` picks now costs 2 requests per song instead of 1 -- the bound
  the code already documents, sequential as before.
- `Match.score` touches `matching.ts` by two lines; if a chain PR is open, rebase rather than wait.
