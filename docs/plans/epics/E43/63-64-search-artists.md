# #63 + #64 -- search each song under every artist name it could be filed under

One PR for both children. #64's whole mechanism is "try the performer-side names #63 derives
before the original artist", so the ordered per-song artist list is designed once here rather
than shipped for uncredited songs in #63 and reshaped for covers in #64. Effort M+M; both carry a
design decision and stay with the orchestrator. Behaviour change: three-reviewer gate.

**Can't start until #61 and #62 have merged.** This plan assumes #61's landed shape: `findSong`
runs the loose query when the filtered one's best is not `high`, keeps the better of the two
(`betterMatch`: confidence first, then score), and `Match` exposes the winning `score`. If #61
lands differently, adapt step 3 to its comparator before anything else -- do not fork a second one.

## Plan (execute as written)

### Decisions

1. **The names a setlist yields** (`artists.ts`, pure, computed once per setlist):
   - `performer` -- `setlist.artistName`.
   - `lead` -- when the performer name joins artists with ` & ` (spaces on both sides), the first
     segment: `Pat Benatar & Neil Giraldo` -> `Pat Benatar`. Undefined otherwise. A single act
     with `&` in its name (`Hall & Oates`) yields a useless `Hall`; it costs nothing when the full
     name matches `high`, and a `Hall` match can only replace a weaker one -- accepted.
   - `credited` -- the artist named by a **strict majority** of the setlist's cover credits, with at
     least **2** credits, after dropping credits that normalise to the performer (a #62 bracketed
     credit is filed under the performer and must not count as "the band covers itself"). On the
     tribute set this is the act being covered; on a band with covers of several artists it is
     undefined.
2. **The order for one song** (`searchArtistsFor`): `[performer, lead, credited, song.searchArtist]`,
   empties dropped, de-duplicated by `normalize()` keeping the first. For an uncredited song the last
   entry is the performer again and drops out; for a cover it is the original artist, searched
   **last** (#64). The credited name is tried for covers too: on a tribute set it is the recording
   the show mirrors (*The Tide Is High* -> Blondie, not The Paragons).
3. **When the next name is tried, and who wins.** Within one name, #61's rule. Across names: the
   next name is searched only while the best so far is not `high`; a later name's best replaces
   the best so far only when its confidence is **strictly** higher. So a band on Spotify keeps its
   own `medium` remaster over the credited artist's `medium`, and for a cover "credible" means
   `high` -- a `high` under the performer side ends the search and the original artist is never
   queried; a `medium` under the performer side is overtaken by a `high` original. `low` vs `low`
   keeps the earlier name.
4. **Disclosure.** The reply gains one note listing every added song whose winning name is not
   `song.searchArtist` (the name setlist.fm gave): `Matched under a different artist than
   setlist.fm names: Heartbreaker -> Pat Benatar, You Better Run -> Pat Benatar.` A wrong inference
   is therefore visible for both children's cases. It is the last note, so it is the first dropped
   at the 2000-character ceiling.
5. **Trace.** `SongTrace` gains `foundUnder?: string` (the artist name in the winning query).
   `searchArtist` keeps its meaning (setlist.fm's name). `queries` is kept whenever more than one
   query was issued, so a `high` reached under a fallback name still shows the path (a first-query
   `high` still omits it: the common case stays small). Existing keys are neither renamed nor
   removed; the CHANGELOG states the change to what `queries` holds (if #61 has not already made it).
6. **Cost.** Worst case per song after #61: 2 requests (50 for 25 songs). After this: up to 4 names
   x 2 queries = 8 for a cover on a duo tribute set, 6 for an uncredited song there, 4 for a cover
   on an ordinary band -- 200 worst case for 25 covers, unchanged 50 for an ordinary band whose
   songs match under its own name, and still 1 for any song whose first query is `high`. Searches
   stay sequential; the `buildPlaylist` doc comment's "up to 50 requests" is updated.
7. No version bump; `## [Unreleased]`. `findSong`'s new parameter defaults to
   `[song.searchArtist]`, so #56's replay and the existing tests keep their meaning.

### Steps

1. **`plugins/music/src/artists.ts`** (new, pure; kept out of `matching.ts`, which #57-#60/#66/#67
   edit in series):
   ```ts
   export interface SetlistArtistNames { performer: string; lead?: string; credited?: string }
   export function leadArtist(performer: string): string | undefined
   export function creditedArtist(songs: readonly SetlistSong[], performer: string): string | undefined
   export function artistNamesFor(setlist: Setlist): SetlistArtistNames
   export function searchArtistsFor(song: SetlistSong, names: SetlistArtistNames): string[]
   ```
   `leadArtist`: `performer.split(/\s+&\s+/)`; return the first segment when there are 2+ and it
   has 2+ characters. `creditedArtist`: tally `normalize(searchArtist)` over `songs.filter(isCover)`
   excluding those equal to `normalize(performer)`; return the original spelling of the top name
   when `count >= 2 && count * 2 > credits.length`. `searchArtistsFor` per decision 2.

2. **`plugins/music/src/artists.test.ts`**: `leadArtist` (joined name -> first; plain name, `&`
   without spaces, one-letter segment -> undefined); `creditedArtist` (5 of 7 -> named; 3 of 6 ->
   undefined; 1 of 1 -> undefined; performer's own credits excluded); `searchArtistsFor` (uncredited
   song on a tribute set -> `[performer, credited]`; cover on a duo -> `[performer, lead, original]`;
   de-duplication; ordinary band uncredited -> `[performer]`).

3. **`plugins/music/src/build.ts`**
   - `findSong(spotify, accessToken, song, artists: readonly string[] = [song.searchArtist])`:
     outer loop over `artists`, inner loop over `buildQueries({ name: song.name, artist })` exactly as
     #61 left it; track `best: { match, artist, hitQuery }`; after each name, replace per decision 3;
     `return` as soon as `best.match.confidence === "high"`. Error handling unchanged (an `ok: false`
     search still aborts with the queries so far).
   - `SongTrace.foundUnder`; `queries` retention per decision 5; `hitQuery` stays the index into
     `queries` of the winning query.
   - `ResolvedSong.foundUnder: string`; `BuildOutcome.foundElsewhere: ResolvedSong[]` = resolved
     songs where `normalize(foundUnder) !== normalize(song.searchArtist)`.
   - `buildPlaylist`: `const names = artistNamesFor(setlist)` once; call
     `findSong(spotify, accessToken, song, searchArtistsFor(song, names))`.
   - Doc comments: `findSong` (names, order, stop rule) and `buildPlaylist` (request bound).
4. **`plugins/music/src/setlistfm.ts`**: `SetlistSong.searchArtist` doc comment -- it is the artist
   setlist.fm names (performer, or a cover's original artist); which names are actually searched,
   and in what order, is `artists.ts`'s. No logic change (#62 already landed the bracket rule).
5. **`plugins/music/src/commands.ts`**: `formatBuildReply` appends the decision-4 note when
   `outcome.foundElsewhere.length > 0`, via `listNames(... \`${r.song.name} -> ${r.foundUnder}\`)`.
6. **`plugins/music/src/build.test.ts`** -- fake client keyed by `artist:"..."` substring as well
   as title where needed; generic names only (no real ids/dates/venues; artist names may be
   generic like `Tribute Act`, `Duo A & Duo B`):
   - `an uncredited song by a performer Spotify doesn't know is found under the artist most credits name`
     (#63 a): tribute set -- 3 credited covers of `Originals`, 1 of `Other`; performer queries
     return `[]`; `Originals` query returns the exact track -> `high`, `foundUnder: "Originals"`,
     trace `queries` lists the performer queries then the `Originals` one.
   - `a band on Spotify with covers of several artists gets no fallback search` (#63 b): 2 credits
     to different artists; the uncredited song's only queries are under the performer (assert the
     query list), and a `low` result stays `low` with no further search.
   - `a band whose own song matches high keeps it even when most credits name one other artist`
     (#63 c): 3 of 3 credits to `Originals`; performer's first query `high`; exactly one search.
   - `an "A & B" performer whose full name finds no high match is searched under A` (#63 d):
     full name -> a `medium` duet; `A` -> `high`; pick is `A`'s, `foundUnder: "A"`, both names in
     the trace, and `foundElsewhere` lists the song.
   - `a fallback name replaces the performer's match only when it is more confident`: performer
     `medium`, credited `medium` with a higher score -> performer's pick stands; credited `high` ->
     replaced.
   - `a cover the performer has recorded picks the performer's recording` (#64 a): cover credited to
     `Originals`; performer query returns the performer's exact track -> `high`; the `Originals`
     query is never issued; `foundElsewhere` lists it.
   - `a cover the performer never recorded falls back to the original artist's` (#64 b): performer
     queries `[]`; `Originals` -> `high`; `foundUnder: "Originals"`; not in `foundElsewhere`.
   - `a cover's performer-side medium is overtaken by the original's high`.
   - Update `a cover is searched under its original artist` (line 217): it now asserts the order --
     performer's queries first, `artist:"The Originals"` last. Name the change in the PR.
   - `a high match reached under a fallback name keeps its queries`; the existing
     `a high match records the pick and hitQuery but no candidate lists` (first-query `high`) stays.
   - `findSong` called with no `artists` argument searches only `song.searchArtist` (the replay's
     contract).
7. **`plugins/music/src/commands.test.ts`**: `outcome()` helper gains `foundElsewhere: []`; a test
   that the note lists `Song -> Artist` pairs and is absent when empty; the clipping test still
   drops it first.
8. **`plugins/music/CHANGELOG.md`** `## [Unreleased]`: `### Changed` -- the names a song is searched
   under and the order (both issue numbers), the reply note, `foundUnder` and the `queries`
   retention in `music-match-log.json`.
9. Commit this plan at `docs/plans/epics/E43/63-64-search-artists.md` with the change.

### Testing strategy

All behaviour above is automated with fake clients. Manual, after the next release and a plugin
update on `debug` (orchestrator, host access): re-run the two baseline setlists and paste the
traces the two issues name -- *Heartbreaker* -> Pat Benatar; a search under `Blondie` for *Get It
On*, *Denis*, *Fan Mail*, *I Want That Man* (found or not); *The Tide Is High* and *Hanging on the
Telephone* -> Blondie; *You Better Run*, *Shadows of the Night*, *All Fired Up* -> Pat Benatar.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #63: unknown performer, credits mostly one artist -> uncredited songs searched under it | 1, 3, 6 | `an uncredited song by a performer Spotify doesn't know...` | `searchArtistsFor` returns `[song.searchArtist]` |
| #63: band on Spotify, covers of several artists -> no fallback | 1, 6 | `a band on Spotify with covers of several artists gets no fallback search` | drop the strict-majority test in `creditedArtist` |
| #63: band's own `high` kept despite a dominant credit | 3, 6 | `a band whose own song matches high keeps it...` | remove the `high` early return |
| #63: `A & B` with no `high` under the full name -> searched under `A` | 1, 3, 6 | `an "A & B" performer whose full name...` | `leadArtist` returns undefined |
| #63: fallback replaces only when more confident | 3, 6 | `a fallback name replaces the performer's match only when...` | change strictly-greater to greater-or-equal |
| #63: reply says when a fallback was used | 3, 5, 7 | commands.test note test; build.test `foundElsewhere` assertions | never populate `foundElsewhere` |
| #63: worst-case count stated | -- | decision 6 (plan text) | -- |
| #64: cover the performer recorded -> performer's recording | 1, 3, 6 | `a cover the performer has recorded picks the performer's recording` | put `song.searchArtist` first in `searchArtistsFor` |
| #64: cover never recorded by the performer -> original's | 3, 6 | `a cover the performer never recorded falls back...` | drop `song.searchArtist` from the list |
| #64: `matching.test.ts:152` still passes | -- | unchanged (`matching.ts` untouched) | -- |
| Mutation checks in a scratch worktree (#63 first test; #64 first test) | -- | the two mutations above, run in a detached worktree | -- |
| Operator step on `debug` (both issues) | -- | manual, orchestrator, after release | -- |
| Checks green; CHANGELOG | 8 | paste output | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music
bun run generate-index -- --check
bun run check-contract
```
plus both mutation runs, and the replay tally before/after (#56) with every changed entry named.

### Risks

- The replay (#56) calls `findSong` without names, so it cannot see this change: every replay
  entry is expected to be unchanged, and that is asserted, not assumed.
- `Hall & Oates`-style names spend up to two extra requests on every non-`high` song; noted, accepted.
- A tribute act whose credits are split evenly gets no `credited` name and stays where it is today.
- `foundElsewhere` and `foundUnder` are additive; `music-match-log.json` readers that ignore unknown
  keys are unaffected.
