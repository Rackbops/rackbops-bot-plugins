# #92 -- `/setlist` reply names the show date

Standalone XS (not part of Epic #43). Behaviour change (reply text): the three-reviewer gate applies.

## Plan (execute as written)

### Decisions

- The date goes on the reply's first bold line, after the venue, in the same `yyyy-MM-dd` form
  the playlist name already uses (`isoDate` in `build.ts`): `**Band - The Venue, Leeds, United
  Kingdom (2026-09-08)**`. An empty `eventDate` appends nothing -- no empty parentheses.
- `describeShow` itself is left alone (it is the show-without-date description); the date is added
  in `formatBuildReply`'s head only, so the picker prompt is unchanged.
- No version bump; `## [Unreleased]` `### Changed`.

### Steps

1. `plugins/music/src/commands.ts`
   - Extend the existing `./build.js` import with `isoDate`.
   - In `formatBuildReply`, build the head as
     `**${describeShow(setlist)}${setlist.eventDate === "" ? "" : ` (${isoDate(setlist.eventDate)})`}**`
     (the rest of the head unchanged). One sentence in the doc comment: the date is there because
     the reply was the only surface without it.
2. `plugins/music/src/commands.test.ts`, in `describe("formatBuildReply")`:
   - `names the show date after the venue, in the playlist name's ISO form` -- the fixture setlist
     (`eventDate: "08-09-2026"`) yields a first line containing `United Kingdom (2026-09-08)**`.
   - `omits the date when the setlist has none` -- `setlist({ eventDate: "" })` yields a first
     line ending `United Kingdom**` with no `(`.
   - The existing long-artist clipping test stays as is and must still pass.
3. `plugins/music/CHANGELOG.md` `## [Unreleased]` `### Changed`: the reply head now carries the
   show date (#92).
4. Commit this plan at `docs/plans/92-show-date.md` with the change.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| Head carries `(2026-09-08)`; nothing when `eventDate` is `""` | 1, 2 | the two new tests | drop the date expression / always append |
| Clipping test still passes | -- | existing clipping test | -- |
| Mutation check in a scratch worktree | -- | first mutation, detached worktree | -- |
| Checks green; CHANGELOG | 3 | paste output | -- |

### Verification

`bun run check`, `bun test plugins/music`, `bun run generate-index -- --check`, `bun run check-contract`,
the mutation run.

### Risks

- The head is not clipped (only notes are), so a pathologically long artist + venue + date could
  in theory exceed 2000; the existing test with a 200-character artist name is the guard and the
  date adds 13 characters.
