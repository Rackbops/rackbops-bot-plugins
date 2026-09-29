# #59 -- break ties without `popularity`, which Spotify search never sends

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #58 has merged**; lands before #60.

## Plan (execute as written)

### Decisions

- **What the original proposal already covers.** "Prefer the un-suffixed title, de-rank variant
  suffixes" is how `titleScore` and `VARIANT_PENALTIES` already rank: an exact title is 100, a
  suffixed one 72, a live/remix/karaoke cut is penalised. Ties that survive that are between
  candidates with the *same* title score -- in the corpus, *All Fired Up*: four exact titles at 100
  (Pat Benatar twice, Fastway, Interpol), no artist agreement because the search artist was the
  original's credit. Today the first in Spotify's order wins, which happened to be right.
- **The new tie-breaker: catalogue depth on the page.** `tieBreak` becomes the number of OTHER
  candidates on the same result page that carry the same primary artist (`artistNames[0]`, after
  `normalize`) and a non-zero title score, divided by 100 (so it never crosses a title or artist
  step; a page has at most 10 rows). The artist whose recording exists in several editions --
  the album cut, a remaster, a compilation -- is the catalogue artist; a one-off cover by someone
  else appears once. On *All Fired Up*: Pat Benatar 2/100, Fastway 0, Interpol 0. Page order stays
  the final tie-breaker, so nothing becomes non-deterministic.
- Fields Spotify does not send (`popularity`) are not read any more; fields it *might* send but
  `spotify.ts` doesn't map (album type, release date) are not introduced -- the issue's own
  warning.
- **`tieBreak` stays a key in `music-match-log.json`**; what it holds changes from `popularity/100`
  (always 0 in practice) to the count above. The CHANGELOG says so. `popularity` stays on
  `TrackCandidate` (spotify.ts still maps it; a test builds it) but no longer feeds a score.
- Checked against the corpus: no `baseline` changes. *All Fired Up* keeps Pat Benatar, now by rule
  rather than by order; every other tie is between editions of one artist, which count each other
  equally and fall through to page order as before.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`
   - `explainCandidate(song, candidate, page: readonly TrackCandidate[] = [])`: `tieBreak` per the
     rule (count others in `page` with the same normalised primary artist and `titleScore > 0`,
     excluding the candidate itself by identity), `/ 100`. Doc comment: what it measures and why
     `popularity` is gone.
   - `scoreCandidate(song, candidate, page = [])` passes it through; `pickBestTrack` passes
     `candidates` as the page.
2. `plugins/music/src/build.ts`: the `CandidateTrace` mapping passes `result.value` as the page so
   the logged `tieBreak` is the number that ranked.
3. `plugins/music/src/matching.test.ts`
   - `describe("scoreCandidate")`: `popularity no longer breaks ties -- Spotify search never sends it`
     (two otherwise identical candidates with different `popularity` score equal).
   - `describe("pickBestTrack")`: `a tie goes to the artist with more editions on the page, even when
     it comes second` -- page `[Fastway "All Fired Up", Pat Benatar "All Fired Up", Pat Benatar "All
     Fired Up - Remastered"]`, song artist `Rattling Sabres` -> Pat Benatar's exact title.
     `page order still decides a genuine tie` -- two single-edition exact titles -> the first.
   - `build.test.ts`: the trace assertion at "a missing song records every query..." expects
     `tieBreak: 0` for the karaoke row -- confirm it still holds (it does: no same-artist sibling)
     and add one trace assertion where a sibling makes `tieBreak: 0.01`.
4. `plugins/music/src/replay/corpus.json`: no baseline change expected; paste the tally (unchanged
   14 / 3 / 10). If any entry changes, stop and report.
5. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed`: the tie-breaker, and that
   `tieBreak` in `music-match-log.json` now holds it (#59).
6. Commit this plan at `docs/plans/epics/E43/59-tiebreak.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Tied score, preferred candidate second in Spotify's order -> the rule picks it | 1, 3 | `a tie goes to the artist with more editions...` | return `0` for `tieBreak` |
| Replay tally no worse; changed entries named | 4 | replay tally assertion | -- |
| Mutation check in a scratch worktree | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 5 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally.

### Risks

- A page where a *wrong* artist has more editions than the right one (a prolific cover act) would
  now win the tie; both would be `low` and flagged. Not seen in the corpus.
- `explainCandidate`'s new parameter defaults to an empty page, so the replay (#56) and any direct
  caller keep working; `tieBreak` is then 0, exactly the old logged value.
