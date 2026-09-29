# #56 -- replay the logged candidate pages as a matching regression corpus

Part of Epic #43. Effort S. Tests and a fixture only: no shipped behaviour, no version bump, no
CHANGELOG entry, no three-reviewer gate -- green checks plus one claims-vs-fixture audit pass are done.

**Input:** the 2026-09-25 match-log copies at `C:\Repos\Scratch\tmp\music-match-log\*-2026-09-25.json`
(three files: `-debug-` and `-prod-` copies of each bot's log; a `music-match-log-2026-09-21.json`
beside them is NOT input -- the suffix filter excludes it). Together they hold 4 runs, 68 songs,
27 non-`high`. Each is a `music-match-log.json` (`MatchLogFile`: `{ v: 1, runs: MatchRun[] }`, see
`plugins/music/src/matchlog.ts` and `SongTrace` in `build.ts`). The 27 songs whose `outcome` is
not `high` carry `queries[]` -- every query issued with its candidate page in Spotify's order.

## Plan (execute as written)

### Decisions

- **Fixture** at `plugins/music/src/replay/corpus.json`, one entry per non-`high` song:
  ```json
  {
    "name": "<song title>",
    "searchArtist": "<artist the query used>",
    "isCover": false,
    "queries": [{ "query": "<exact query string>", "candidates": [{ "uri": "...", "name": "...", "artistNames": ["..."] }] }],
    "right": ["<uri>", "..."],
    "baseline": { "uri": "<picked uri>", "confidence": "medium" }   // or "missing"
  }
  ```
  `right` lists every candidate on the song's pages that is the recording a setlist playlist wants
  (may be empty). `baseline` is what today's code picks -- the replay asserts it, so any later
  change has to be named. **No setlist identity**: no id, url, date, venue, city, tour, timestamp,
  and no `score`/`tieBreak` parts (they are derived, and re-derived by the replay).
- **Fake client** keyed by the exact query string. A query with no logged page returns an empty
  page and is collected into `unserved: string[]`; the test prints them under
  `replay: N queries had no logged page` and does not guess. Candidates carry `popularity: 0`
  (Spotify sent none -- #59).
- **Verdict** per song from the replay's own pick: `missing` when `findSong` returns no match;
  `right` when the picked uri is in `right`; else `wrong`. The tally is printed as
  `replay: right R, wrong W, missing M` so every later PR can paste before/after.
- **Labelling `right`** from the 2026-09-25 read (`#43`, the "Match-log read across both bots"
  comment): the wrong picks among the 27 are exactly *Heroes* (Shinedown), *You Better Run* (The
  New Rascals), *Rip Her to Shreds* (Boomkat), *By-Tor & the Snow Dog* (the 1980 live cut) and
  *Heartbreaker* (the Dolly Parton duet); the 10 misses are *Get It On*, *Denis*, *Fan Mail*,
  *I Want That Man*, the three *2112* parts, *Detroit 422*, *Come On People* and *Ring of Fire*;
  every other logged pick is right. For each song, `right` = the candidate uris whose artist is the
  setlist's performer (or, for a credited cover, the original artist; both for the Benatar set's
  covers she recorded) and whose title is the song in a clean edition -- studio, remaster, single
  version -- never live, karaoke, tribute or a different song. *Detroit 422*'s `right` is Blondie's
  `Detroit 442` cuts (#67's target); *2112* parts' `right` is Rush's whole-suite track (#66's);
  *Come On People* and *Ring of Fire* have none.
- The extraction is a scratch script, not committed: the fixture is the artefact, and this plan
  is the procedure.

### Steps

1. Extract: read the four files, flatten `runs[].songs[]`, keep `outcome !== "high"`, map each to
   the fixture shape above (`queries[].candidates[]` -> `uri`, `name`, `artists` -> `artistNames`),
   set `baseline` from `picked.uri` + `outcome` or `"missing"`. Expect exactly 27 entries; if not,
   stop and report the count. Hand-fill `right` per the labelling rule; check the resulting verdicts
   against the read: 12 right, 5 wrong, 10 missing.
2. `plugins/music/src/replay/corpus.json` -- committed, formatted, ASCII-safe (`\u` escapes are
   fine; a real apostrophe or accent in a title must round-trip through `normalize` exactly as the
   log had it).
3. `plugins/music/src/replay.test.ts`
   - Load the corpus (`import corpus from "./replay/corpus.json"` with bun's JSON import, typed via
     a local `CorpusSong` interface).
   - `servePages(song)` builds a `SpotifyClient` like `build.test.ts`'s `fakeSpotify` (the
     non-search methods return `{ ok: false, error: "not used" }`), whose `searchTracks` looks up
     the exact query string, else returns `[]` and records it.
   - `test("the corpus is the 27 non-high songs of the 2026-09-25 logs")`: `corpus.length === 27`.
   - `describe.each(corpus)("replay: %s")` -> `test("picks the baseline")`: run
     `findSong(client, "T", { name, searchArtist, isCover })`; assert
     `match?.track.uri === baseline.uri && match?.confidence === baseline.confidence` (or
     `match === undefined` for `"missing"`).
   - `afterAll`: compute verdicts, `console.log` the tally line and the unserved-queries line, and
     `expect(tally).toEqual({ right: 12, wrong: 5, missing: 10 })`.
   - A guard that no fixture entry carries a key outside the shape above (so identity can't creep
     back in): `expect(Object.keys(entry).sort()).toEqual([...])`.
4. Commit this plan at `docs/plans/epics/E43/56-replay-corpus.md` with the change.

### Testing strategy

Automated throughout. The single audit pass (one read-only agent): every `right` label against the
labelling rule and the read; the fixture against the identity ban; the 27 count.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| `bun test plugins/music` green with the replay covering all 27 songs | 1-3 | `the corpus is the 27 non-high songs...` + `describe.each` | delete one fixture entry |
| Printed tally for today's code is 12 / 5 / 10 | 1, 3 | the `afterAll` tally assertion | relabel one `right` |
| Mutation check in a scratch worktree: removing the live penalty fails the replay on *By-Tor & the Snow Dog* | -- | `replay: By-Tor & the Snow Dog > picks the baseline` | delete the `live|concert` row of `VARIANT_PENALTIES` in a detached worktree |
| `bun run check` passes | -- | paste output | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music/src/replay.test.ts     # shows the tally and unserved lines
bun test plugins/music
```
plus the mutation run.

### Risks

- If the extracted count is not 27, the logs differ from the ones the read used -- report, don't
  pad or trim.
- A later child that changes a baseline must edit `corpus.json`'s `baseline` for that song and name
  it in its PR; that is the point.
