# #67 -- tolerate a one-character typo in a setlist.fm title ("Detroit 422")

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #66 has merged** (same title comparison).

## Plan (execute as written)

### Decisions

- **The rule.** A candidate whose title earns 0 by every other rule may still match when (a) the
  song's normalised title is at least **8 characters**, (b) the candidate's normalised title is
  within **Levenshtein distance 1** of it (one substitution, insertion or deletion), *or* starts
  with such a title followed by a space (so `detroit 442 remastered` matches `detroit 422`), and
  (c) the candidate has artist agreement (`artistScore > 0`). Title score **30**: with an exact
  artist that is 70, under the `medium` floor of 90, so a typo match is always `low` and the reply
  always asks the user to check it. Without artist agreement the rule does not apply at all -- a
  one-edit title from a stranger is a different song.
- **Why 8.** One edit on `maria`, `atomic`, `denis` is another word; on `detroit 422` it is a typo.
  8 is the shortest length at which every one-edit neighbour in the corpus is the same song, and
  the corpus's genuinely-missing short titles (*Denis*, 5) stay missing rather than guessing.
- **Corpus:** *Detroit 422* -> Blondie's `Detroit 442 - Remastered` (first non-live Blondie cut on
  the page; 30 + 22 = 52, `low`). Tally 17 / 3 / 7 -> 18 / 3 / 6; no other entry moves (the other
  misses -- *Get It On*, *Denis*, *Fan Mail*, *I Want That Man*, *Come On People*, *Ring of Fire*
  -- have no one-edit neighbour with artist agreement on their pages).
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`
   - `export function withinOneEdit(a: string, b: string): boolean` -- length difference > 1 ->
     false; equal length -> at most one differing position; else one-pointer scan allowing a single
     skip. O(n), no matrix.
   - `const MIN_TYPO_TITLE_LENGTH = 8;`
   - In `explainCandidate`, when `title === 0` and `songTitle.length >= MIN_TYPO_TITLE_LENGTH`:
     compute `artist` first; if `artist > 0` and (`withinOneEdit(candidateTitle, songTitle)` or
     the candidate's title up to its first space-delimited prefix of the same length +/- 1 is within
     one edit and followed by a space) then `title = 30` and score as usual. Keep the existing
     early return for every other zero-title case so unrelated pages still reject wholesale.
     Doc comment: the three conditions and why `low` is the ceiling.
2. `plugins/music/src/matching.test.ts`
   - `describe("withinOneEdit")`: substitution, insertion, deletion true; two edits false; equal
     strings true.
   - `describe("pickBestTrack")`: `a one-edit title with an agreeing artist matches at low` (song
     `Detroit 422` / `Totally Blondie`, candidates from the corpus entry -> `Detroit 442 -
     Remastered`, `low`); `with an unrelated artist it does not` (same titles, artist
     `Someone Else` -> undefined); `a title under 8 characters never does` (`Maria` vs `Mario`,
     same artist -> undefined); `a live one-edit cut still pays the live penalty` (ranking within
     the typo matches).
3. `plugins/music/src/replay/corpus.json`: *Detroit 422* baseline -> the `Detroit 442 - Remastered`
   uri at `low` (already in `right`). Tally before/after; name any other change (expected none).
4. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed` (#67).
5. Commit this plan at `docs/plans/epics/E43/67-one-edit-typo.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Replay: *Detroit 422* -> Blondie's `Detroit 442` at `low`; other changes named | 1, 3 | replay baseline assertion | disable the typo clause |
| One-edit + agreeing artist -> `low`; unrelated artist -> no match; short title -> no match | 1, 2 | the three `pickBestTrack` tests | drop the `artist > 0` condition / drop the length floor |
| Mutation check in a scratch worktree: disabling the fallback fails *Detroit 422* | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally before/after.

### Risks

- The typo rule runs only for candidates that scored 0 on title, on pages where the artist agrees,
  so it never changes an existing pick -- it can only turn a miss into a flagged `low`.
- Numbers are one-edit-prone (`422`/`442`) and so are years; a wrong year in a title would match a
  same-artist track with the right year, which is the intended behaviour.
