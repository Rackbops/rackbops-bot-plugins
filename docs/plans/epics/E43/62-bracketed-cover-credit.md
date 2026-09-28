# #62 -- don't search a bracketed cover credit like `[traditional]` as an artist

Part of Epic #43. Effort XS. Behaviour change: the three-reviewer gate applies to the PR.

## Plan (execute as written)

### Decisions

- A cover credit is a pseudo-artist when, trimmed, it is **entirely** in square brackets:
  `[traditional]`, `[unknown]`, `[ Traditional ]`. `[traditional] folk` is not (it is treated as an
  artist name, as today) -- the rule is "not an artist at all", not "contains brackets".
- `isCover` stays `true` for such a song: setlist.fm did mark it a cover, and later children (#64)
  read that flag. Only `searchArtist` changes, to the performing artist.
- No version bump. The CHANGELOG entry goes under `## [Unreleased]` (`scripts/generate-index.ts`
  skips that heading, so `generate-index -- --check` stays green with no `plugins.json` change). A
  separate `chore(release)` PR, cut by the orchestrator, ships it.

### Steps

1. `plugins/music/src/setlistfm.ts`
   - Add and export, above `flattenSetlist`:
     ```ts
     /**
      * setlist.fm writes a cover of no particular artist as a bracketed pseudo-artist --
      * `[traditional]`, `[unknown]`. Searching that as an artist matches nothing sensible
      * (`artist:"[traditional]"` landed an unrelated folk medley), so it is not one.
      */
     export function isPseudoArtist(name: string): boolean {
       return /^\[.*\]$/.test(name.trim());
     }
     ```
   - In `flattenSetlist` (currently lines 181-187), replace the `coverArtist` handling with:
     ```ts
     const credited = str(song.cover?.name);
     const coverArtist = credited !== undefined && !isPseudoArtist(credited) ? credited : undefined;
     for (const part of splitMedley(name)) {
       songs.push({
         name: part,
         searchArtist: coverArtist ?? performingArtist,
         isCover: credited !== undefined,
       });
     }
     ```
   - Update the `SetlistSong.isCover` doc comment (line 24): it is "True when setlist.fm flagged
     the song a cover" -- no longer "when `searchArtist` is not the performing artist", which a
     bracketed credit now breaks.
   - Extend the `flattenSetlist` doc comment's list of entry kinds with one sentence on the
     bracketed credit.

2. `plugins/music/src/setlistfm.test.ts`, inside `describe("flattenSetlist")`:
   - `test("a bracketed cover credit like [traditional] is not an artist: searched under the performer, still a cover")`
     -- `flattenSetlist({ artist: { name: "Band" }, sets: { set: [{ song: [{ name: "Whiskey in the Jar", cover: { name: "[traditional]" } }] }] } })`
     yields `[{ name: "Whiskey in the Jar", searchArtist: "Band", isCover: true }]`. Also assert
     `[unknown]` and `[ Traditional ]` (spaces inside, trimmed outside) behave the same.
   - `test("a credit that merely contains brackets is still an artist")` --
     `cover: { name: "[traditional] folk" }` keeps `searchArtist: "[traditional] folk"`.
   - The existing `a cover is searched under the ORIGINAL artist, and flagged` (line 96) is the
     "flattens exactly as before" guard; leave it unmodified.
   - `describe("isPseudoArtist")`: true for `[traditional]`, false for `Traditional` and `""`.

3. `plugins/music/CHANGELOG.md`: add `## [Unreleased]` above `## [1.4.0]` (if absent) with
   `### Fixed` -- "A cover credit setlist.fm writes entirely in square brackets (`[traditional]`,
   `[unknown]`) is no longer searched as an artist; the song is searched under the performing artist
   and still counts as a cover (#62)."

4. Copy this plan file into the worktree at `docs/plans/epics/E43/62-bracketed-cover-credit.md`
   and commit it with the change.

### Testing strategy

| Behaviour | Kind | Where |
|---|---|---|
| Bracketed credit -> performer, `isCover: true` | automated | step 2, first test |
| Ordinary credit unchanged | automated | existing `setlistfm.test.ts:96` |
| Partial brackets stay an artist | automated | step 2, second test |
| `isPseudoArtist` edge cases | automated | step 2, `describe("isPseudoArtist")` |

No manual verification: the change is pure and has no operator-visible surface until the next
release.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| `[traditional]` flattens to `searchArtist` = performer, `isCover: true` | 1, 2 | `a bracketed cover credit like [traditional] is not an artist...` | delete the `!isPseudoArtist(credited)` guard (or make `isPseudoArtist` return `false`) |
| An ordinary cover credit flattens exactly as before | 1 | `a cover is searched under the ORIGINAL artist, and flagged` (existing) | make `isPseudoArtist` return `true` |
| Mutation check in a scratch worktree | -- | run the first test against the mutated tree: `git worktree add --detach <path> HEAD`, apply the mutation there, `bun test plugins/music/src/setlistfm.test.ts` fails, `git worktree remove <path>` | -- |
| `bun run check`, `bun test`, `bun run check-contract`, `bun run generate-index -- --check` pass | 3 | -- (commands, paste output in the PR) | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music
bun run generate-index -- --check
bun run check-contract
```
plus the mutation run above, showing the failing assertion.

### Risks

- #64 later reads `isCover` for these songs and will search them under the performer-side names
  anyway; nothing here pre-empts it.
- `check-contract` needs network to `rackbops-discord-bot`; a failure to reach it is not drift.
