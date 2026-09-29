# #99 -- a karaoke upload phrased "originally performed by" can win an empty page

Standalone XS (surfaced by Epic #43's exit run). Behaviour change: the three-reviewer gate applies.

## Plan (execute as written)

### Decisions

- Two additions to the 100-point tier of `VARIANT_PENALTIES` in `plugins/music/src/matching.ts`:
  the title phrases `originally performed by` / `originally by`, and -- new kind of rule -- a
  candidate whose **primary artist name** (`artistNames[0]`, after `normalize`) contains the word
  `karaoke` pays 100 whatever its title says. Both are applied inside `variantPenalty`, which
  gains the candidate's artist names as a parameter, so the match log's `penalty` part keeps
  carrying the whole reason a row sank.
- The title-side rule keeps the existing "only when the marker is absent from the song's own
  title" guard; the artist-side rule has no such guard (a song title never names its artist).
- Corpus effect: none expected. The karaoke rows on the logged *Heroes* page already scored 0 via
  `karaoke` in their titles; no baseline changes. The tally stays 18 / 3 / 6.
- No version bump; `## [Unreleased]` (new heading above `## [1.6.0]`) `### Fixed`.

### Steps

1. `plugins/music/src/matching.ts`
   - `VARIANT_PENALTIES`: extend the second row's pattern to
     `/\b(made popular by|in the style of|tribute|originally (performed )?by)\b/`.
   - `const KARAOKE_ARTIST = /\bkaraoke\b/;`
   - `variantPenalty(candidateTitle, songTitle, candidateArtists: readonly string[])`: after the
     title loop, `if (candidateArtists.some((a) => KARAOKE_ARTIST.test(a))) total += 100;`
     (callers pass the already-normalised names). Doc comment: a karaoke label's uploads carry the
     original artist in the title, so the title rules alone can miss them.
   - `explainCandidate`: pass `candidate.artistNames.map(normalize)` (already computed for
     `artistScore` -- compute once, reuse).
2. `plugins/music/src/matching.test.ts`
   - `describe("scoreCandidate")`: `an "originally performed by" upload is rejected like any other
     karaoke` -- `I Want That Man (Originally Performed by Blondie) [Instrumental Version]` by
     `Karaoke Collective` scores 0 for `{ name: "I Want That Man", artist: "Blondie" }`; and the
     variant `I Want That Man (Originally by Blondie)` by an unrelated artist also 0.
   - `a karaoke label's upload is rejected by its artist name alone` -- `I Want That Man` (plain
     title) by `Zoom Karaoke` scores 0.
   - `describe("pickBestTrack")`: page `[the Karaoke Collective row, "I Want That Man" by Debbie
     Harry]` for song `I Want That Man` / `Blondie` -> Debbie Harry's, `low` (no artist overlap
     -- exactly what the reply should flag).
   - Existing `'in the style of' tribute uploads are rejected too` and the `Live and Let Die`
     own-title guard stay unmodified.
3. `plugins/music/src/replay.test.ts`: tally unchanged (18 / 3 / 6); paste it.
4. `plugins/music/CHANGELOG.md`: `## [Unreleased]` `### Fixed` (#99).
5. Commit this plan at `docs/plans/99-karaoke-originally-performed-by.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| The Karaoke Collective instrumental scores 0; Debbie Harry's plain title wins the page | 1, 2 | the `scoreCandidate` and `pickBestTrack` tests | remove `originally (performed )?by` from the pattern |
| A `Zoom Karaoke` upload with a plain title scores 0 | 1, 2 | `a karaoke label's upload is rejected by its artist name alone` | drop the artist-side rule |
| Replay tally no worse; changes named | 3 | replay tally assertion | -- |
| Mutation check in a scratch worktree | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification

`bun install --frozen-lockfile` (fresh worktree), `bun run check`, `bun test plugins/music`,
`bun run generate-index -- --check`, `bun run check-contract`, the mutation run, the replay tally.

### Risks

- An artist genuinely named with the word "karaoke" (a novelty act) is unmatchable; accepted.
- `variantPenalty`'s signature change touches one caller (`explainCandidate`); `build.ts` does not
  call it directly.
