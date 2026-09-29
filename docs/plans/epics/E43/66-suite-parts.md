# #66 -- match suite parts listed separately ("2112 Part I: Overture") to the suite's recording

Part of Epic #43. Effort M. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #60 has merged** (same title comparison); lands before #67.

## Plan (execute as written)

### Decisions

- **What a suite part is.** After `normalize`, a song title of the shape
  `<stem> part <n> <part name>` with `n` Roman (`i`, `ii`, `vii`, ...) or Arabic: regex
  `^(.+?) part ([ivxlcdm]+|\d+) (.+)$`. `2112 Part I: Overture` -> stem `2112`, part `overture`
  (the colon is gone by then). A title with a part number but no part name (`Another Brick in the
  Wall, Part 2`) is not a suite part and is unaffected; neither is `Parts I-V`.
- **What it matches.** A candidate whose normalised title starts with the stem and contains the
  part name -- the whole-suite medley (`2112: Overture / The Temples Of Syrinx / ... / Grand Finale
  - Medley`), a two-part track (`2112 Overture / The Temples Of Syrinx`), a single-part edit
  (`2112 Overture - Retrospective Edit`), a live cut (`2112 (Overture) - Live`, which then pays the
  live penalty). Title score **60**: below a prefix match (72), above a bare contains (40), so a
  suite match only ever wins when nothing names the part's own title more directly.
- **Which recording wins when Spotify has both the whole suite and per-part tracks: no special
  preference.** They all score 60 on title; the artist tier (#58), variant penalties and the
  editions tie-break (#59) decide, then page order. On the logged pages that gives *Part I* ->
  `2112 Overture - Retrospective Edit` (the only non-live Rush cut on its page -- the medley is not
  on it), *Part II* -> `2112 Overture / The Temples Of Syrinx`, *Part VII* -> the whole-suite
  medley. A rule preferring the whole suite would change nothing for *Part I* and only pick a
  longer track for *Part II*; not worth its own complexity.
- **Confidence: never above `medium`.** A suite match is not an exact title, so with an exact
  artist it lands `medium` (60 + 40 = 100 >= 90) and the reply lists it under "worth a check";
  with a partial artist it is `low`. A suite mapping is exactly the kind of pick a user should
  eyeball.
- **Adding once.** In `buildPlaylist`, two *different* song titles that both parse as parts of the
  same stem and resolve to the same uri add it once; the second is counted as `folded`. Two entries
  with the *same* title (a genuine repeat) still add twice (`build.ts`'s existing duplicate rule).
  The reply gains one note, `N suite parts share a recording already added.`, so "Added 22 of 24"
  is not read as two misses. `BuildOutcome.folded: number` is additive.
- **Corpus:** the three *2112* parts move from `missing` to `medium` picks. Their `right` lists
  are updated to every non-live Rush track on their pages whose title names the part (the plan
  above defines what "the suite's recording" means; #56's placeholder labelled only the medley).
  Tally 14 / 3 / 10 -> 17 / 3 / 7; no other entry moves.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`
   - `export function parseSuitePart(normalizedTitle: string): { stem: string; part: string } | undefined`.
   - `titleScore(candidate, song, suite?)`: after the prefix rule and before the contains rule,
     `if (suite && candidate.startsWith(suite.stem) && candidate.includes(suite.part)) return 60;`.
     `explainCandidate` parses the song title once and passes it. Doc comments: the shape, the
     60, why no whole-suite preference.
2. `plugins/music/src/build.ts`
   - `BuildOutcome.folded: number`.
   - `buildPlaylist`: while collecting `resolved`, keep `seenSuite: Set<string>` of
     `${stem}|${uri}`; a song whose `parseSuitePart(normalize(song.name))` is defined and whose
     `(stem, uri)` is already in the set is not pushed to `resolved` and increments `folded`.
     `attempted` unchanged; `added` comes from Spotify as today.
   - Doc comment on the duplicate rule (`build.ts` "Duplicates are kept deliberately") extended
     with the suite exception.
3. `plugins/music/src/commands.ts`: `formatBuildReply` appends
   `${folded} suite part(s) share a recording already added.` when `folded > 0`, after the
   tape note. `commands.test.ts`'s `outcome()` helper gains `folded: 0`; one test for the note.
4. `plugins/music/src/matching.test.ts`
   - `describe("parseSuitePart")`: Roman and Arabic numerals; colon/dash forms; `Part 2` with no
     name -> undefined; `Parts I-V` -> undefined; an ordinary title -> undefined.
   - `describe("pickBestTrack")`: `a suite part matches the suite's recording that names it, at
     medium` -- *Part VII* against the medley and a live cut (names from the corpus entry) -> the
     medley, `medium`; `a suite part does not match a track of the suite that omits the part` --
     *Part VII* against `2112 Overture / The Temples Of Syrinx` alone -> undefined;
     `an exact or prefix title still beats a suite match` (a candidate literally titled
     `2112 Part I: Overture` wins over the medley).
5. `plugins/music/src/build.test.ts`: `three parts of one suite resolving to one track add it
   once and are counted as folded` (fake page: the medley for every `2112` query; `added` 1,
   `folded` 2, `uncertain` lists the one added); `the same song listed twice still adds twice`;
   `two parts resolving to different tracks both add`.
6. `plugins/music/src/replay/corpus.json`: `right` and `baseline` for the three *2112* entries per
   the decisions; paste the tally before/after and the three picks (the acceptance asks for them).
7. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed` (#66).
8. Commit this plan at `docs/plans/epics/E43/66-suite-parts.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Replay: each *2112* part resolves to a Rush track carrying its part name (picks pasted) | 1, 6 | the three replay baseline assertions | delete the suite clause in `titleScore` |
| Three parts -> one track add it once; a song listed twice adds twice | 2, 5 | the two `build.test.ts` tests | drop the `seenSuite` check / key the set on uri alone |
| Mutation check in a scratch worktree: removing the part rule fails the replay on the three parts | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 7 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally before/after with the three picks.

### Risks

- A stem as short as `2112` could prefix an unrelated title (`2112 Overture / Royal Philharmonic
  Orchestra` does); the artist tier keeps such a candidate below any Rush one, and alone on a page
  it would land `low`, flagged.
- `folded` parts are neither added nor missing; the note is what keeps the counts honest.
