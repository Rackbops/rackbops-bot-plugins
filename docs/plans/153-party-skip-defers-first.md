# #153 -- /party skip acknowledges first and needs no Spotify of the skipper's own

Standalone S. Behaviour change (when `/party skip` answers Discord, and what it requires of the caller): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`; the test harness it reuses was added by #134 (merged as `7faecc9`), and the harness details below are written against that commit. On `7faecc9` `handlePartySkip` is at `plugins/music/src/commands.ts:767-792` (the cites in the next paragraph are to `3356230`; re-find by function name).

### What is wrong

`plugins/music/src/commands.ts:753-778` (`handlePartySkip`) awaits `requirePartyAccess` at `:763` -- a refresh against accounts.spotify.com bounded at 10 s, plus a possible store commit -- and only then calls `deferReply()` at `:768`. Discord gives an interaction three seconds (`README.md:221-225`): when the token endpoint is slow the interaction has expired, `deferReply` (or the `replyEphemeral` at `:765`) throws "Unknown interaction", no skip happens, and the user sees "application did not respond". `/party start`, `/party add` and the Join button defer first (`:677`, `:708`, `:854`). The access check is also beside the point: a skip is authorised by membership (`:759`), and the runner's `skip` refreshes every member's token itself when it plays the next track (`runner.ts` `advanceParty` -> `playCurrent` -> `playFor`); the skipper's own connection is never used by the skip.

### Decisions

- **Acknowledge before any await.** The party and membership checks are synchronous and keep their immediate ephemeral replies; then `deferReply()` (public, as today: the "Skipped to" line is for the channel); then the work.
- **A skip needs the runner, not the skipper's Spotify.** `handlePartySkip` takes `runner` from `required()` (`Wiring.runner?: PartyRunner`); if it is `undefined` (Spotify not configured) it answers `formatNotConfigured(config.missing)` ephemerally before deferring, exactly as `requirePartyAccess` would have. No token refresh, no store write, for the skipper.
- **The last-track answer is unchanged** ("That was the last track. `/party add` something else.") and still comes after the defer, as today.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/commands.ts`, `handlePartySkip`: party check, membership check, `const { config, runner } = required(); if (runner === undefined) { await replyEphemeral(interaction, formatNotConfigured(config.missing)); return; }`, `await interaction.deferReply();`, the last-track branch, `const outcomes = await runner.skip(guildId);`, the reply as today. Delete the `requirePartyAccess` call from this handler. A comment: why the defer comes first (the three-second rule) and why the skipper's Spotify is not needed.
2. `plugins/music/src/commands.test.ts`, in the `/party` section #134 added at the end of the file (`fakePartyCommand`, `partyRunnerDouble`, `wireParty`, `handleParty`). Extend the harness so that one array records the interaction's calls, the token fake's refreshes and the runner's skips in the order they happen; existing callers pass nothing new and keep exactly what they get today:
   - `fakePartyCommand(sub, options, userId, guildId = "G1", calls: string[] = [])`: the recorders push "defer" / "edit" / "followUp" / "reply" onto the `calls` array that was passed in, or onto a fresh one when none was. The `reply` recorder keeps `flags` as well as `content` (it keeps only `content` today), so a refusal can assert `MessageFlags.Ephemeral`.
   - `partyRunnerDouble(started, outcomes, calls: string[] = [])`: `skip(guildId)` pushes `skip:${guildId}` onto `calls` and returns `[]`.
   - `wireParty` gains `members` (default `["host"]`), `queue` (default as today: `[Zero]` when playing, `[]` when idle; each entry a `PartyTrack` like `{ uri: "spotify:track:one", name: "One", artist: "Band", durationMs: 180_000 }`) and `configured` (default `true`; `false` wires `spotify: undefined`, `runner: undefined`, no `config.spotify`, and `config.missing: ["SPOTIFY_CLIENT_ID"]`, the way the file's not-configured tests do). It creates one `calls` array, has the `refresh` fake push "refresh" onto it before answering, hands it to `partyRunnerDouble`, and returns `{ started, calls }`.
   - `describe("the party's skip command")`; each test builds `const { calls } = wireParty({...})`, then `const run = fakePartyCommand("skip", {}, USER, "G1", calls)`, then `await handleParty()(run.interaction)`:
     - "a member's skip is acknowledged before anything is awaited, and needs none of their Spotify": `wireParty({ scopes: PARTY_SCOPES, members: ["host", USER], queue: [One, Two] })` (a playing party, `index: 0`) -> `calls` equals `["defer", "skip:G1", "edit"]` (no "refresh" anywhere, the defer before the skip), and `run.edits[0].content` contains "Skipped to **Two**".
     - "a non-member is refused without a defer": `members: ["host"]`, two queued tracks -> `calls` equals `["reply"]`; the reply contains "Only people in the party can skip" and its `flags` equal `MessageFlags.Ephemeral`.
     - "the last track answers after the defer and does not advance": `members: ["host", USER]`, the default one-track playing queue -> `calls` equals `["defer", "edit"]`; the edit contains "last track".
     - "a skip when the feature is not configured is refused ephemerally": `configured: false`, `members: ["host", USER]`, two queued tracks -> `calls` equals `["reply"]`; the reply names `SPOTIFY_CLIENT_ID` and its `flags` equal `MessageFlags.Ephemeral`.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: `/party skip` now acknowledges Discord before it does anything else, so a slow Spotify no longer makes it "not respond", and it no longer refreshes (or risks) the skipper's own Spotify connection -- being in the party is the authorisation, and the next track refreshes every member's token itself (#153).
4. This file, committed as `docs/plans/153-party-skip-defers-first.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every await in `handlePartySkip` relative to the defer, what `runner.skip` does with members whose own refresh fails, the not-configured path, and whether any other `/party` handler still awaits before acknowledging (`grep` every `deferReply(` and `requirePartyAccess(` in `commands.ts`); B: claims-vs-code over this plan, the CHANGELOG and the comment, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
8. PR `fix(music): acknowledge /party skip before any Spotify call, and stop requiring the skipper's own connection (#153)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #153`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The skip is acknowledged before anything is awaited | 1, 2 | "acknowledged before anything is awaited" | move the defer below `await runner.skip(...)` -- `calls` becomes `["skip:G1", "defer", "edit"]` |
| The skipper's own Spotify is never refreshed by a skip | 1, 2 | the same test's `calls` assertion | reinstate `requirePartyAccess` -- "refresh" appears in `calls` |
| A non-member is refused, without a defer | 1, 2 | "a non-member is refused without a defer" | drop the membership check -- "defer" and "skip:G1" appear |
| The last track answers after the defer and does not advance | 1, 2 | "the last track answers after the defer" | drop the last-track branch -- "skip:G1" appears |
| Not configured is refused ephemerally | 1, 2 | "not configured is refused ephemerally" | defer before the runner check -- "defer" appears |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.

## Corrections found by the review gate (added after the plan above, which is kept as it was posted)

- **"The skipper's own connection is never used by the skip" (What is wrong, coverage row 2, step 3's CHANGELOG text) is false as written.** The skipper must be a party member, and `runner.skip` -> `advanceParty` -> `playCurrent` runs `playFor` for every member, the skipper included (`runner.ts:233`, `:144`): their token is refreshed and their player driven, and a dead grant there still removes their stored connection (`tokens.ts:74-76`). What the change removes is the command layer's own refresh of the skipper's token, which sat ahead of the defer (before this change the skipper was refreshed twice, once there and once by the runner). The comment in `handlePartySkip` and the CHANGELOG bullet say that instead. Coverage row 2's test therefore proves "the command layer adds no refresh" (the runner double refreshes nothing), and is named that way.
- **A consequence the plan did not state:** a skipper with a dead grant, no connection or missing scopes used to be refused privately by the access check; now the skip goes ahead, the runner names them in the public "Skipped to" reply (`formatOutcomes`) and drops them from the party on a permanent problem (`runner.ts:150-151`, `:219-224`) -- which closes the party if they are the host (`party.ts:87`). The CHANGELOG says so.
- Step 2's "keeps only `content` today" is imprecise: the recorder already pushed the whole options object, only its type annotation was narrower.
- Tests added by the gate: a synchronous check that the defer is the first call (`calls` is `["defer"]` before the first microtask turn), the public defer (`defers` is `[{}]`), and the "No party here." refusal.
