# #55 -- log every `/setlist` that stops before a build

Part of Epic #43. Effort S. Behaviour change (new log lines): the three-reviewer gate applies to
the PR.

## Plan (execute as written)

### Decisions

- **Line shape.** One `log.info` line per stop, ASCII only:
  `setlist stopped stage=<stage>: <reason>` where `<reason>` is exactly the sentence the user was
  shown. Every one of those sentences is already free of Discord ids and tokens (they name env keys,
  the typed artist/date, setlist.fm's or Spotify's error text). A Loki query counts by stage with
  `|= "setlist stopped" | regexp "stage=(?P<stage>[a-z-]+)"`.
- **Stage vocabulary** (a closed union type, so a new exit cannot invent a spelling):
  `not-configured`, `usage`, `lookup`, `stale-control`, `not-owner`, `no-pick`, `token`.
- **Picker lifecycle** is two non-stop lines with their own prefixes, so the stop query never counts
  them: `setlist picker offered: <shown> of <total> shows` when the menu goes out, and
  `setlist picked` the moment the menu's owner makes a valid selection (after the owner check, before
  the configured / nothing-picked / lookup checks, which are stops of a picked run). Abandoned
  pickers = offered - picked, and runs = builds + stops + abandoned pickers. This is the one place
  the plan departs from the scope's letter ("a run that reaches `buildPlaylist` logs nothing new"):
  a picked run that builds logs `setlist picked` plus its summary line. Its intent -- no run counted
  twice as a stop -- holds, because `setlist picked` is not a stop line.
- **Level** is `info`: a stop is a normal outcome, not a fault.
- **No version bump in this PR.** CHANGELOG entry under `## [Unreleased]`; the orchestrator cuts the
  `chore(release)` PR right after this merges, since the operator step needs a release.

### Steps

1. `plugins/music/src/commands.ts`
   - `import type { PluginCommand, PluginLog } from "../../../packages/api/contract.js";`
   - `Wiring` gains `/** The plugin's logger; absent only in tests that don't read it. */ log?: PluginLog;`
   - Add, under "Shared plumbing":
     ```ts
     /** Where a `/setlist` can stop before any build. Closed so a Loki count by stage stays exact. */
     export type StopStage =
       | "not-configured" | "usage" | "lookup" | "stale-control" | "not-owner" | "no-pick" | "token";

     /** One line per stop: the only record a `/setlist` that never built leaves anywhere. */
     function logStop(stage: StopStage, reason: string): void {
       required().log?.info(`setlist stopped stage=${stage}: ${reason}`);
     }
     ```
   - Call `logStop` at every exit in the issue's table, with the sentence sent to the user:
     - `handleSetlist`: not configured -> `not-configured`; no url/artist (both usage sentences)
       -> `usage`; `resolved.kind === "error"` -> `lookup` (`resolved.error`).
     - `handleSetlist` picker: `required().log?.info(\`setlist picker offered: ${shown} of ${total} shows\`)`
       beside the `editReply` that sends the menu.
     - `handlePick`: bad control -> `stale-control`; other user's menu -> `not-owner`; then
       `required().log?.info("setlist picked")`; setlist.fm not configured -> `not-configured`;
       no value -> `no-pick`; `getSetlist` failed -> `lookup`.
     - `buildInto`: Spotify not configured -> `not-configured`; no usable token -> `token`
       (`token.error`).
   - Update the `buildInto` doc comment: the not-configured and token paths "record nothing" -> they
     log a stop line and record nothing in the match log.
2. `plugins/music/src/index.ts`: pass `log: host.log` in the `initCommands({...})` call.
3. `plugins/music/src/commands.test.ts`
   - Module-level `let logged: string[] = [];` and
     `const captureLog = { info: (m: string) => { logged.push(m); }, warn() {}, error() {} };`
     Add `logged = [];` and `log: captureLog` to `wire()`, `wirePicker()` and the build wiring
     (the `initCommands` around line 436). `resetStoreForTest` already runs there.
   - Helpers: `stops = () => logged.filter((l) => l.startsWith("setlist stopped"))` and
     `expectOneStop(stage)` asserting `stops()` has exactly one entry containing `stage=${stage}:`.
   - Use a user id that would be tempting to log: `const USER = "424242424242424242";` and pass it to
     `fakeCommand`/`fakePick` in the new tests.
   - New `describe("/setlist stop lines")`, one test per table row:
     - `not configured` -- wiring with `setlistFm` undefined and `config.missing: ["SETLISTFM_API_KEY"]`.
     - `usage` -- `fakeCommand({})` and `fakeCommand({ date: "2026-09-08" })`, each exactly one line.
     - `lookup` -- `test.each` over: bad link (`url: "nope"`); `getSetlist` error; unreadable date;
       no show; shows but no songs; `latestForArtist` error. Each exactly one `stage=lookup` line
       whose reason equals `shown(run)`.
     - `picker offered` -- two filled-in shows: one `setlist picker offered: 2 of 2 shows` line, no stop.
     - `handlePick`: `stale-control` (`isSelect=false`), `not-owner` (different user), `picked` line
       present after a valid pick, `not-configured` (setlistFm undefined), `no-pick` (`values: []`),
       `lookup` (`getSetlist` fails).
     - `buildInto`: `not-configured` via the picker path with `spotify` undefined; `token` via the
       command path with a filled-in show and no Spotify connection (the existing "/spotify connect"
       case).
   - `test("no stop line ever carries the user's id")`: walk every exit above in one loop with
     `USER`, assert no entry of `logged` contains `USER`.
   - `test("a build that ran logs no stop line, whether it succeeded or failed")`: in the build
     wiring, one successful build and one where `buildPlaylist` fails (`searchTracks` returns
     `{ ok: false, error: "Spotify returned HTTP 429" }`); assert `stops()` is empty both times and
     the match-log `record` was called (the run is counted once, by the summary line).
   - Every existing reply-text assertion stays byte-identical.
4. `plugins/music/CHANGELOG.md`: `## [Unreleased]` / `### Added`: the stop lines, the picker lines,
   the stage vocabulary and the Loki query (#55). State that the match log file is untouched.
5. Copy this plan into the worktree at `docs/plans/epics/E43/55-stop-lines.md`; commit with the change.

### Testing strategy

Everything above is automated against the fake interactions already in `commands.test.ts`. Manual,
orchestrator-run after release: the operator step (two stop lines in `docker logs` and Loki) --
it needs the deployed `debug` bot and host access.

### Coverage table

| Acceptance bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| A test per exit in the table, exactly one line with that stage | 1-3 | the `/setlist stop lines` describe (one test per row; `lookup` is a `test.each`) | delete any one `logStop` call; or log two lines on one exit |
| No logged line contains the user id, across every exit | 1, 3 | `no stop line ever carries the user's id` | append `${interaction.user.id}` to the `not-owner` reason |
| A build that runs logs no stop line | 1, 3 | `a build that ran logs no stop line, whether it succeeded or failed` | add a `logStop("token", ...)` after `buildPlaylist` returns |
| Existing reply-text assertions pass unmodified | -- | whole file, `git diff` shows no edited assertion | -- |
| Mutation checks in a scratch worktree | -- | remove the `logStop` on the `resolveSetlist` error path -> `lookup` test fails; add the user id to the line -> id test fails. `git worktree add --detach`, mutate, `bun test plugins/music/src/commands.test.ts`, `git worktree remove` | -- |
| `bun run check`, `generate-index -- --check`, `check-contract` pass; CHANGELOG entry | 4 | paste output | -- |
| Operator step on `debug` | -- | manual, orchestrator, after the release PR | -- |

### Verification (paste real output in the PR)

```
bun run check
bun test plugins/music
bun run generate-index -- --check
bun run check-contract
```
plus both mutation runs showing the failing assertion.

### Risks

- `resolved.error` for the date path embeds the artist name and date the user typed. That is user
  input, not an identifier, and it is what makes the line diagnosable; it is deliberate.
- A wiring without `log` (older tests, `index.test.ts`) must keep working: every call is
  `required().log?.info`, never `required().log.info`.
