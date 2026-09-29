# #57 -- compare `&` and `+` as "and" in titles and artist names

Part of Epic #43. Effort XS. Behaviour change: the three-reviewer gate applies to the PR.
**Can't start until #56 (the replay corpus) has merged**; lands before #58 (same file).

## Plan (execute as written)

### Decisions

- `&` and `+` become the word `and` only when they sit **between** two non-space characters
  (ignoring surrounding spaces): `By-Tor & the Snow Dog`, `Rock&Roll`, `1+1`, `(& They Don't Like
  Me)` all gain `and`; a leading or trailing symbol (`Plus +`) is dropped by the existing
  punctuation rule exactly as today, so a title that merely ends in `+` does not sprout a dangling
  `and`. Applied before the punctuation-to-space step, inside `normalize()`, so it covers titles
  and artist names alike (and `preferExactArtist` in `setlistfm.ts`, which uses `normalize`).
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/matching.ts`, `normalize()`: after the apostrophe deletion and before
   `.replace(/[^a-z0-9]+/g, " ")`, add
   ```ts
   // "&" and "+" between two words read as "and": setlist.fm has "By-Tor & the Snow Dog", Spotify
   // "By-Tor And The Snow Dog", and turning the symbol into a space made them different titles.
   // Only between non-space characters, so a symbol on its own edge is still just punctuation.
   .replace(/(?<=\S)\s*[&+]\s*(?=\S)/g, " and ")
   ```
   and extend the doc comment's examples with the `&`/`And` pair.
2. `plugins/music/src/matching.test.ts`
   - In `describe("normalize")`: `treats & and + as the word "and", so setlist.fm's ampersand meets
     Spotify's "And"` -- `normalize("By-Tor & the Snow Dog") === normalize("By-Tor And The Snow Dog")`,
     `normalize("Rock&Roll") === normalize("Rock and Roll")`, `normalize("1+1") === normalize("1 and 1")`;
     `a symbol on the edge of a title is still punctuation, not "and"` -- `normalize("Plus +") === "plus"`,
     `normalize("& Co") === "co"`.
   - In `describe("pickBestTrack")`: `picks the studio By-Tor And The Snow Dog at high over the live
     cut, from the logged page` -- candidates taken from the corpus entry for *By-Tor & the Snow Dog*
     (`plugins/music/src/replay/corpus.json`: the studio track's exact `name`/`artistNames` and the
     live cut's), song `{ name: "By-Tor & the Snow Dog", artist: "Rush" }`; assert the studio uri
     and `"high"`.
   - `an ampersand on both sides still matches exactly` -- song and candidate both
     `I Don't Like People (& They Don't Like Me)` by the same artist -> `high`.
3. `plugins/music/src/replay/corpus.json`: the *By-Tor & the Snow Dog* entry's `baseline` becomes
   the studio track's uri at `high`. Run the replay: the tally must move from 12 / 5 / 10 to
   13 / 4 / 10; paste before and after in the PR, and name any other entry that changed (expected:
   none -- if one does, keep its new baseline only if the pick is in its `right` list, otherwise stop
   and report).
4. `plugins/music/CHANGELOG.md` `## [Unreleased]` (create above `## [1.5.0]`) `### Changed`: the
   `&`/`+` rule (#57).
5. Commit this plan at `docs/plans/epics/E43/57-ampersand-and.md` with the change.

### Testing strategy

All automated; the replay is the regression net for everything not named here.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| `normalize` equality and the logged page picks the studio cut at `high` | 1, 2 | `treats & and + as the word "and"...`; `picks the studio By-Tor And The Snow Dog at high...` | delete the new `.replace` |
| `I Don't Like People (& They Don't Like Me)` still matches exactly | 1, 2 | `an ampersand on both sides still matches exactly` | replace `&` with `""` instead of `" and "` (asymmetric handling would break it) |
| Replay moves *By-Tor* from wrong to right; other changes named | 3 | replay tally assertion (13 / 4 / 10) | revert the corpus baseline |
| Mutation check in a scratch worktree: reverting the `&` mapping fails the new test | -- | first mutation above, in a detached worktree | -- |
| Checks green; CHANGELOG | 4 | paste output | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music
bun run generate-index -- --check
bun run check-contract
```
plus the mutation run and the replay tally before/after.

### Risks

- `normalize` also feeds `preferExactArtist` (#65): `Simon & Garfunkel` now equals `Simon and
  Garfunkel` there too -- the intended direction.
- Lookbehind in the regex needs a modern engine; bun's JavaScriptCore has it.
