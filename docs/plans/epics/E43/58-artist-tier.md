# #58 -- rank the right artist's remaster above an exact title by an unrelated artist

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #57 has merged** (same file, same functions); lands before #59.

## Plan (execute as written)

### Decisions

- **The rule, as the issue proposes it:** in `pickBestTrack`, a candidate with any artist agreement
  (`artistScore > 0`) outranks every candidate with none, whatever the titles score; within a tier
  the score decides as today. The alternative -- raising the artist weights -- was rejected because
  it changes every logged `score` and the `score >= 90` floor for `medium`; a tier changes which
  candidate wins and nothing else, which is what the issue's "confidence is unchanged" asks for.
- **Checked against the corpus** (the 27 pages in `replay/corpus.json`): exactly one entry moves --
  *Rip Her to Shreds*, Boomkat's exact title (100, no artist) -> Blondie's `Rip Her To Shreds -
  Remastered 2001` (94, partial artist), `medium`. Every other page either has all-zero artist
  scores (*Shadows of the Night*, *All Fired Up*, *You Better Run*, *Heroes*, *French Kissin'*) or
  already leads with an artist-agreeing candidate. The existing `low`-when-alone case
  (`matching.test.ts:135`) is untouched: a lone candidate has no one to be outranked by.
- `explainCandidate` / `scoreCandidate` are unchanged, so the match log's parts keep their meaning.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`, `pickBestTrack`: rank by `(tier, score)` where
   `tier = explainCandidate(song, candidate).artist > 0 ? 1 : 0`; keep the first on a full tie
   (page order). Use `explainCandidate` once per candidate (it already yields both numbers). Update
   the doc comment: artist agreement is a tier, not points, and why.
2. `plugins/music/src/matching.test.ts`, in `describe("pickBestTrack")`:
   - `the right artist's remaster outranks an exact title by an unrelated artist, from the logged
     page` -- candidates from the corpus entry for *Rip Her to Shreds* (exact `name`/`artistNames`
     of the Boomkat track and the Blondie remaster; no ids), song
     `{ name: "Rip Her to Shreds", artist: "Totally Blondie" }` -> picks Blondie's, `medium`.
   - `within a tier the score still decides` -- two artist-agreeing candidates, exact title vs
     prefix -> the exact one.
   - `a right title under the wrong artist, alone on the page, still matches at low` stays as is.
3. `plugins/music/src/replay/corpus.json`: *Rip Her to Shreds* `baseline` -> the Blondie remaster's
   uri at `medium`. Replay tally 13 / 4 / 10 -> 14 / 3 / 10; paste before/after; name any other
   changed entry (expected none; if one changes, stop and report rather than re-baselining it).
4. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed` (#58).
5. Commit this plan at `docs/plans/epics/E43/58-artist-tier.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Over the logged page, Blondie's remaster beats Boomkat's exact title | 1, 2 | `the right artist's remaster outranks...` | rank by score alone |
| Replay moves *Rip Her to Shreds* wrong -> right; others named | 3 | replay tally assertion | revert the baseline |
| Existing `pickBestTrack` cases pass unmodified, incl. `:135` | -- | existing tests | -- |
| Mutation check in a scratch worktree | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run, the replay tally before/after.

### Risks

- A right-artist candidate whose title merely *contains* the song (a medley, score 62) now beats an
  unrelated artist's exact title; both are `low` and both are flagged, and the right artist's
  medley is the closer of the two for a setlist playlist.
