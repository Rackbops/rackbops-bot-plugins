# #155 -- /party add matches a "track and artist" query the way its option promises

Standalone S. Behaviour change (which `/party add` queries find a track): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`; #134 lands first and adds the `/party` command test harness this plan reuses (`fakePartyCommand`, `wireParty` in `commands.test.ts`). Re-find cites by function name if lines have shifted.

### What is wrong

The `query` option of `/party add` is described as "Track name, or track and artist" (`plugins/music/src/commands.ts:937`), but `handlePartyAdd` scores the whole string as a title: `pickBestTrack({ name: query, artist: "" }, found.value)` (`:723`). `titleScore` (`matching.ts:164-171`) credits a candidate only when its title equals, starts with, or contains the full query, so for "Bohemian Rhapsody Queen" every candidate scores 0 (`:285-288`), `pickBestTrack` returns `undefined` (`:341`) and the user is told "Nothing on Spotify matched", even though Spotify's own search returned the right track first. The advertised input form fails for the most common query shape.

### Decisions

- **The matcher learns the "title artist" and "artist title" shapes, as a fallback.** A new exported `pickTrackFromQuery(query: string, candidates: readonly TrackCandidate[]): Match | undefined` in `matching.ts`, next to `pickBestTrack`: first `pickBestTrack({ name: query, artist: "" }, candidates)` (today's behaviour, unchanged); when that yields nothing, split: with `q = normalize(query)`, for each candidate with `t = normalize(candidate.name)` (skip empty `t`), the query matches as title-then-artist when `q.startsWith(\`${t} \`)` and `artistScore(candidate.artistNames.map(normalize), q.slice(t.length + 1)) > 0`, and as artist-then-title when `q.endsWith(\` ${t}\`)` and the leading rest scores likewise. Among split matches, prefer the higher artist score, then the longer title (a longer title consumed more of the query), then page order. The split match returns `{ track, confidence: artist score 40 ? "high" : "medium", score: 100 + artist score }` so `/party add`'s existing `match.track` use needs no change.
- **`/setlist` is untouched.** It builds `SongQuery`s with a real artist and never hits this path; `pickBestTrack` is not modified.
- **The option description stays** -- it is now true.
- **No version bump.** The CHANGELOG bullet travels in the PR body (see the steps); `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/matching.ts`: `pickTrackFromQuery` as decided, documented as the free-text entry point (`/party add`), reusing `normalize`, `artistScore` and `pickBestTrack`; nothing else changes.
2. `plugins/music/src/commands.ts:723`: `pickTrackFromQuery(query, found.value)`.
3. `plugins/music/src/matching.test.ts`, `describe("pickTrackFromQuery")` with candidates built like the file's existing fixtures:
   - "a plain title still matches exactly as before": "Bohemian Rhapsody" against `[{ name: "Bohemian Rhapsody", artistNames: ["Queen"] }, ...]` -> the same track `pickBestTrack` returns, same confidence.
   - "title then artist finds the track the title alone would not": "Bohemian Rhapsody Queen" -> the Queen track, confidence "high".
   - "artist then title too": "Queen Bohemian Rhapsody" -> the same track.
   - "a partial artist still counts, with medium confidence": "Bohemian Rhapsody Que" is NOT a match (the artist half must score: `artistScore` gives 22 only when one string contains the other, and "que" is contained in "queen" -- check `artistScore`'s rule and set the expectation from it; if it matches at 22, assert "medium").
   - "the longer title wins when two candidates both fit": "Rhapsody Queen" against `[{ name: "Rhapsody", artistNames: ["Queen"] }, { name: "Bohemian Rhapsody", artistNames: ["Queen"] }]` -> "Rhapsody" (the only candidate whose full title heads the query); and "Bohemian Rhapsody Queen" against the same two -> "Bohemian Rhapsody".
   - "nothing matches when neither half fits": "Bohemian Rhapsody Beatles" -> `undefined`.
4. `plugins/music/src/commands.test.ts`, in the `/party` section: "a 'title artist' query is queued": `searchTracks` returns `[{ ...track("Bohemian Rhapsody", "Queen"), durationMs: 180_000 }]` for the query "Bohemian Rhapsody Queen" -> the public followUp says `queued **Bohemian Rhapsody**`.
5. The CHANGELOG bullet goes in the PR body under `## CHANGELOG bullet` (no edit to `plugins/music/CHANGELOG.md`; the orchestrator lands every bullet in one docs PR at the end of the epic). Its text: `/party add` now finds a track typed as "title artist" or "artist title", as its option always promised; a title on its own matches exactly as before (#155).
6. This file, committed as `docs/plans/155-party-add-title-and-artist-query.md`.
7. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
8. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
9. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- `normalize`'s edge cases on the split (empty titles, punctuation-only strings, which #150 covers separately and this plan must not widen into), ties, a query that is both a full title and a split, `/setlist` untouched; B: claims-vs-code over this plan, the CHANGELOG bullet, the option description and the JSDoc, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
10. PR `fix(music): let /party add match a "title artist" query, as its option promises (#155)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #155`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| "title artist" finds the track | 1, 2, 3, 4 | "title then artist finds the track"; the `/party add` case | drop the fallback -- `undefined` |
| "artist title" finds the track | 1, 3 | "artist then title too" | drop the `endsWith` half |
| A plain title behaves exactly as before | 1, 3 | "a plain title still matches exactly as before" | skip `pickBestTrack` and go straight to the split -- the confidence changes |
| The longer title wins a tie | 1, 3 | "the longer title wins" | prefer the shorter title, or page order only |
| Neither half fitting is no match | 1, 3 | "nothing matches when neither half fits" | accept any candidate whose title heads the query regardless of the artist |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.

## Corrections found by the review gate (added after the plan above, which is kept as it was posted)

- **Three gaps in the design, found by running the split against realistic pages and fixed in `pickTrackFromQuery`:**
  - *An artist that normalizes to nothing matched any rest.* `normalize` strips everything outside `a-z0-9`, so a name written in a script it cannot read (or pure punctuation) becomes `""`, and `artistScore` counts `""` as contained in anything (`wanted.includes("")`). In the title pass a full-query title match gates that; in the split the title only has to head or end the query, so "Lemon Tree Fools Garden" matched a track `Lemon` by `米津玄師`. Empty normalized artists are now dropped before scoring.
  - *The split had no variant guard.* The title pass penalises a karaoke credit (and a live or remix cut the query did not ask for) through `variantPenalty`; the split did not, so a page holding only `Bohemian Rhapsody` by `Queen Karaoke` answered "Bohemian Rhapsody Queen". The split now skips any candidate `variantPenalty` would penalise. In the split only the karaoke credit can ever fire: a title that heads or ends the query shares its marker words (live, remix, ...) with it, so the title-side half of the guard has nothing to catch (a reviewer's fuzz of 400,000 cases reached about 38,800 head or tail matches and fired the title-side penalty in none).
  - *A clean-edition title never matched the split.* The split needed the candidate's whole title to head or end the query, so `Bohemian Rhapsody - Remastered 2011` -- a spelling the catalogue uses for many classic recordings (the `CLEAN_EDITION_SUFFIX` comment cites the #56 corpus) and one the title pass accepts at 99 -- did not answer "Bohemian Rhapsody Queen", the issue's own example. The candidate's title with a clean-edition suffix taken off now counts too, and the unsuffixed title wins a tie against a suffixed one (as it does by score in the title pass). I could not check live Spotify data from here; how often the catalogue returns only the suffixed spelling is inferred.
- **Coverage row 3's mutant is described wrongly.** Skipping `pickBestTrack` and going straight to the split does not make "the confidence change": a whole title is never a split (the title is never followed by a space and an artist), so "Bohemian Rhapsody" returns `undefined`. The row is guarded all the same, by "a plain title still matches exactly as before" and "a query that is a whole title wins over a reading of it as title and artist".
- **The "longer title wins" bullet's two examples are not a tie.** For "Rhapsody Queen" only `Rhapsody` fits (`Bohemian Rhapsody` neither heads nor ends it), and for "Bohemian Rhapsody Queen" only `Bohemian Rhapsody` fits, so both pass under "prefer the shorter title". They are kept as a test of "only the candidate whose whole title heads the query fits"; the tie is tested with `Hey` / `Hey Jude` against "Hey Jude Band", in both page orders, and the artist-before-length ordering with a shorter title whose artist is exact against a longer title whose artist is partial.
- **"'Bohemian Rhapsody Que' is NOT a match" is false of the code**: it matches at 22 (`que` is contained in `queen`), medium, score 122, and the test asserts exactly that.
- **"The option promises both" overclaims.** The option text is "Track name, or track and artist"; it promises "track and artist", not an order. "Artist title" is accepted as a convenience of the same split. The code comment and the PR say so.
- **"Spotify's own search returned the right track first"** is inferred (the issue says nothing was executed and the repo has no fixture); the search sends the free-text query with a limit of 10.
- **"A title on its own matches exactly as before"** is true wherever `pickBestTrack` finds anything. A title-only query that used to miss can now hit a split reading ("Bohemian Rhapsody e" reaches `Queen` through `artistScore`'s containment).
- **Cites** are to `3356230` (the option description at `commands.ts:937`, the call at `:723`); at this PR's base (`9de5f29`) they are `:1058` and `:785`.
- **Known limits of reading the split, declined here:**
  - *Decorated titles match only as a whole.* "Rockstar Post Malone" does not find `rockstar (feat. 21 Savage)`, and `- Radio Edit` / `- Single Version` titles stay out by design (`CLEAN_EDITION_SUFFIX` excludes them): `normalize` drops the parentheses, and stripping a credit or an edit would need a rule of its own. The title pass finds such a track from its title alone, as before. A follow-up could strip a trailing `feat.` / `with` credit as a further head.
  - *A title whose last word is a four-digit number and that carries a bare `Remaster(ed)` suffix is cut one word early.* `withoutEditionSuffix` cuts at the first space whose remainder is a clean-edition suffix, and the suffix pattern's optional leading year swallows the real title's last word: "Year 3000 - Remastered" is read as base "year", so "Busted Year 3000" misses it (and "Year 3000 Busted" matches at medium instead of high). Trying every valid cut would fix it; the reach is tiny and nothing regresses, so it is left.
- **Looser than the title pass, accepted:** `artistScore`'s partial rule (22) has no minimum length and works in both directions ("Yesterday B" reaches `The Beatles`; "Bohemian Rhapsody Queens of the Stone Age" reaches `Queen`), it is shared with `/setlist` and changing it is out of scope here, and `/party add` ignores `confidence`, so such a pick is queued without a flag. The title pass still wins whenever it finds anything, even when a split reading would have picked better (a cover whose title starts with the query). Both are as before for the title pass and only newly reachable for queries that used to miss.
- **Tests beyond the plan's list:** a whole-title query beating a split reading; accents on both sides (the accents test of the first commit had none; it does now, in the artist); whole-word boundaries at the head and the tail; a candidate that matches both readings; exact-versus-partial artist in both page orders; artist-before-length; clean-edition spellings and the plain-title tie; non-clean editions; a karaoke credit; empty-normalized artists; an empty page and a punctuation-only query.
