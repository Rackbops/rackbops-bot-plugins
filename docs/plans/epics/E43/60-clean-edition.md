# #60 -- count a clean remaster suffix as an exact title

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #59 has merged**; lands before #66.

## Plan (execute as written)

### Decisions

- **Clean edition = a remaster, in every spelling the corpus shows**: after `normalize`, the
  candidate title is the song title followed by one space and a suffix matching
  `^(\d{4} )?remaster(ed)?( \d{4})?( version)?$` -- `2004 remaster`, `2013 remaster`,
  `remastered 2001`, `2017 remaster`, `remastered`, `remastered version`. Parentheses and dashes
  vanish in `normalize`, so `(Remastered)` and `- Remastered 2001` are the same case. Nothing
  else qualifies: `single version`, `radio edit`, `mono`, `retrospective 3 version`, `take 2`,
  `live`, `remix`, `demo`, `instrumental` all stay prefixes (72) -- they are different edits or
  recordings, not the same master.
- **Score 99, not 100.** A clean edition scores `title = 99`: it counts as exact for confidence
  (so with an exact artist it is `high`), but the un-suffixed title, when the page has both, still
  wins the tie by one point rather than by page order. This keeps *Maria*, *Atomic* and
  *(I'm Always Touched by Your) Presence, Dear* on their un-suffixed picks in the corpus without
  leaning on #59's tie-break, and the logged `title: 99` reads as "exact modulo a clean suffix".
- **Confidence** reads exactness through one helper, `isExactTitle(candidateTitle, songTitle)`,
  used by both `titleScore` and `pickBestTrack`, so the two can never disagree.
- **Corpus effect, all named:** *Dreamline* and *Bravado* -> `high`, same picks (`2004 Remaster`,
  139 = 99 + 40); *Union City Blue* -> pick moves from `Single Version` (94) to `Remastered 2001`
  (121), still `medium`, still right; *Rip Her to Shreds* keeps the remaster, now 121. Tally
  unchanged at 14 / 3 / 10, but three baselines change.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`
   - `const CLEAN_EDITION_SUFFIX = /^(\d{4} )?remaster(ed)?( \d{4})?( version)?$/;`
   - `function isExactTitle(candidate: string, song: string): boolean` -- `candidate === song`, or
     `candidate.startsWith(\`${song} \`)` and the remainder matches `CLEAN_EDITION_SUFFIX`.
   - `titleScore`: `if (candidate === song) return 100; if (isExactTitle(candidate, song)) return 99;`
     then the existing prefix/contains rules.
   - `pickBestTrack`: `const exactTitle = isExactTitle(normalize(best.track.name), songTitle);`
   - Doc comments on both, with the reason for 99.
2. `plugins/music/src/matching.test.ts`
   - `matching.test.ts:141` ("a remaster under the right artist is confident enough to add without
     comment") now asserts `"high"`.
   - `describe("scoreCandidate")`: `a clean remaster suffix scores as exact minus one` --
     `Yesterday - Remastered 2009`, `Dreamline - 2004 Remaster`, `Rapture (Remastered)`,
     `Hey Jude - Remastered Version` all `title === 99` via `explainCandidate`; `an edit or a
     re-recording is still a prefix` -- `Dreamline - Retrospective 3 Version`, `You Better Run -
     Single Version`, `Maria - Radio Edit`, `Detroit 442 - Take 2` all `72`.
   - `describe("pickBestTrack")`: `Yesterday - Remastered 2009 / The Beatles and Dreamline - 2004
     Remaster / Rush are high`; `Dreamline - Retrospective 3 Version and Dreamline - Live are not`;
     `the un-suffixed title still beats its own remaster on the same page` (exact 100 vs 99).
3. `plugins/music/src/replay/corpus.json`: baselines for *Dreamline*, *Bravado* (confidence ->
   `high`) and *Union City Blue* (uri -> the `Remastered 2001` track; confirm it is in `right`, else
   stop and report). Paste the tally before/after (14 / 3 / 10 both) and the three changes.
4. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed` (#60).
5. Commit this plan at `docs/plans/epics/E43/60-clean-edition.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Remaster forms are `high`; Retrospective / Live are not | 1, 2 | the two `pickBestTrack` tests | make `isExactTitle` plain equality |
| Replay: *Dreamline*, *Bravado* -> `high`, same picks; other changes named | 3 | replay baseline assertions | revert the baselines |
| `:141` asserts `high` | 2 | that test | -- |
| Mutation check in a scratch worktree | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally and the three named baseline changes.

### Risks

- #66 (suite parts) and #67 (one-edit typos) extend the same title comparison next; both build on
  `isExactTitle` rather than around it.
- A remaster of a *different* recording (a re-recorded "remaster") is indistinguishable by title;
  accepted, it is what the catalogue calls it.
