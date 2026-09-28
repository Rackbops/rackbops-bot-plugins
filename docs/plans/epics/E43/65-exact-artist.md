# #65 -- `/setlist artist:` prefers the exact artist over a tribute act

Part of Epic #43. Effort S. Behaviour change: the three-reviewer gate applies to the PR.
Branch from `main` **after #74 (#62) merged** -- both edit `setlistfm.ts`.

## Plan (execute as written)

### Decisions

- **Exact** means equal after `normalize()` from `matching.ts` (case, accents and punctuation
  ignored), so `metallica` and `Metallica` are the same artist and `Some Kind of Metallica` is not.
- **When any result matches exactly, only the exact ones are considered** -- in both
  `latestForArtist` and `showsOn`. If the exact artist's shows are all stubs, the reply says so
  ("shows but none with a song list filled in yet") rather than building a tribute act's show: an
  honest miss beats a confident wrong playlist. Only when **no** result matches exactly does the
  loose pool stand, in setlist.fm's order, exactly as today.
- **Naming the artist used.** The build reply already leads with the show's artist; what it lacks
  is that this is not who was asked for. When the run came from `artist:` (no `url`) and the built
  setlist's artist is not an exact match for it, the reply's first line is
  `setlist.fm has no exact "<asked>"; this is the nearest match, <artist used>.` It is part of the
  head, so the 2000-character clipping never drops it. The picker path needs nothing: its prompt
  already names the artist whose shows are listed, and with the preference above that is the exact
  one whenever it exists.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/setlistfm.ts`
   - `import { normalize } from "./matching.js";`
   - Add and export, above the client:
     ```ts
     /**
      * setlist.fm's `artistName=` search is a loose match, so a tribute act's newer show can sit
      * ahead of the real artist's. When any result IS the artist asked for (after `normalize`),
      * only those count; otherwise the whole page stands, in setlist.fm's order.
      */
     export function preferExactArtist(setlists: readonly Setlist[], artistName: string): Setlist[] {
       const wanted = normalize(artistName);
       const exact = setlists.filter((s) => normalize(s.artistName) === wanted);
       return exact.length > 0 ? exact : [...setlists];
     }
     ```
   - `latestForArtist`: `const pool = preferExactArtist(found.setlists, artistName);` then iterate
     `pool` for the first with songs; the two error sentences keep their wording, the second one
     judged on `pool` (so an exact artist with only stubs reports "shows but none filled in").
   - `showsOn`: return `preferExactArtist(found.setlists, artistName)`.
   - Update the `SetlistFmClient.latestForArtist` and `showsOn` doc comments with one sentence each.
2. `plugins/music/src/commands.ts`
   - `import { normalize, pickBestTrack } from "./matching.js";` (extend the existing import).
   - `formatBuildReply(setlist, outcome, askedArtist?: string)`: when
     `askedArtist !== undefined && normalize(askedArtist) !== normalize(setlist.artistName)`, the head
     starts with `setlist.fm has no exact "${askedArtist}"; this is the nearest match, ${setlist.artistName}.\n`.
   - `buildInto(setlist, discordUserId, edit, askedArtist?: string)` passes it through.
   - `handleSetlist`: pass `url === null ? artist ?? undefined : undefined` to `buildInto`.
     `handlePick` passes nothing.
3. `plugins/music/src/setlistfm.test.ts`
   - `describe("preferExactArtist")`: exact wins over loose; normalisation (`metallica` vs
     `Metallica`, accents); nothing exact -> input unchanged and in order.
   - In `describe("createSetlistFmClient")`, with the `json()` helper and the fake fetch pattern at
     line 274: `latestForArtist prefers the exact artist over a newer tribute act's show` (page:
     `Some Kind of Band` with songs first, `Band` with songs second -> `Band`'s id);
     `latestForArtist builds from the nearest loose match when nothing matches exactly` (only the
     tribute -> its id); `latestForArtist reports an exact artist whose shows are all stubs instead
     of building a tribute act's` (exact stub + tribute with songs -> `ok: false`, "none with a song
     list"); `showsOn keeps only the exact artist's shows when any match exactly`; `showsOn returns
     every loose match when none is exact`.
4. `plugins/music/src/commands.test.ts`
   - `formatBuildReply`: `names the artist used when it is not the one asked for` (asked `Band`,
     setlist `Some Kind of Band` -> first line contains both); `says nothing extra when the artist
     matches, whatever the case` (`band` vs `Band`); the long-artist clipping test still passes.
   - End to end, with the build wiring around line 436 (fake Spotify, `putConnection`):
     `/setlist artist: built from a loose match names the artist it used` -- `latestForArtist`
     returns a `Some Kind of Band` setlist for `artist: "Band"`; `shown(run)` contains
     `no exact "Band"`. `/setlist url: never adds the note` -- same setlist via `url`, no note.
5. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed`: the exact-artist preference in
   both lookups and the reply's first line when a loose match was used (#65).
6. Commit this plan at `docs/plans/epics/E43/65-exact-artist.md` with the change.

### Testing strategy

All automated. Manual, orchestrator, after the next release: `/setlist artist:Metallica` on
`debug`, summary line from `docker logs` showing `Metallica`.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Tribute's newer show ahead of the real artist's -> `latestForArtist` returns the real artist's | 1, 3 | `latestForArtist prefers the exact artist over a newer tribute act's show` | `preferExactArtist` returns its input |
| Only loose matches: build goes ahead, reply names the artist used | 1-4 | `latestForArtist builds from the nearest loose match...`; `/setlist artist: built from a loose match names the artist it used` | drop the head line in `formatBuildReply` |
| `showsOn` applies the same preference | 1, 3 | `showsOn keeps only the exact artist's shows when any match exactly` | call `preferExactArtist` in `latestForArtist` only |
| Mutation check in a scratch worktree | -- | first mutation above, in a detached worktree | -- |
| Operator step on `debug` | -- | manual, orchestrator, after release | -- |
| Checks green; CHANGELOG | 5 | paste output | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music
bun run generate-index -- --check
bun run check-contract
```
plus the mutation run.

### Risks

- `normalize` is `matching.ts`'s and #57 will teach it `&` = `and`; that only widens "exact" in
  the right direction.
- An exact artist whose only page-1 shows are stubs now yields the "none filled in" sentence where
  it used to build a tribute act's show. That is the intended trade and the CHANGELOG says so.
