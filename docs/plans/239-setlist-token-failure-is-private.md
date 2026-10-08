# #239 -- a failed Spotify refresh during /setlist, and during its picker, is told to the caller privately

Epic #237 child, S. Behaviour change (which reply carries the caller's connection state): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `b7fd15f` (#242 merged); #241 and #243 have landed since and touch neither of the functions below. Cites are to `b7fd15f`; re-find by function name if the numbers have shifted.

### What is wrong

`/setlist` defers publicly (`plugins/music/src/commands.ts:430`) and hands `buildInto` an edit of that reply (`:449-456`); when the caller's Spotify refresh fails, `buildInto` edits `token.error` into it (`:301-304`), so "You haven't connected Spotify yet ..." or "... no longer valid (HTTP 400 ...)" goes to the channel. The picker's second half has the same shape: `handlePick` answers with `update` on the public picker message (`:501`) and `buildInto` edits the same text into it (`:509-511`). No authorize link is minted on either path (that was #134's High; `/setlist` sends the caller to `/spotify connect` instead), so what leaks is the caller's connection state, not a sign-in token. `buildInto` has exactly these two callers.

### Decisions

- **`buildInto` gets two outputs, and the token failure uses both.** `buildInto(setlist, discordUserId, out: { edit: (content: string) => Promise<void>; whisper: (content: string) => Promise<void> }, askedArtist?: string)`. On `!token.ok`: `logStop("token", token.error)` as today, then `await out.edit(PRIVATE_FAILURE_NOTE)`, then `await out.whisper(token.error)`. `PRIVATE_FAILURE_NOTE` is `"Couldn't build that playlist for you. The reason is in a note only you can see."`, a module constant beside the other reply texts. Edit first, whisper second: the edit resolves the public deferred reply (or the picker's "Building the playlist..." message), and a follow-up sent before that would take the reply's place instead of landing as its own message (the order #134 established for `/party`).
- **`whisper` is an ephemeral follow-up on both interactions.** `handleSetlist` and `handlePick` pass `{ edit: async (content) => { await interaction.editReply({ content }); }, whisper: async (content) => { await interaction.followUp({ content, flags: MessageFlags.Ephemeral }); } }`. A component interaction that has been `update`d accepts `followUp` and `editReply` the same way a deferred command does.
- **Everything else in `buildInto` is unchanged:** the not-configured branch (configuration, not personal state) and the build result or `built.error` (Spotify API outcomes, meant for the channel) keep editing the public reply.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/commands.ts`: `buildInto` as decided (the other `edit(...)` calls become `out.edit(...)`), `PRIVATE_FAILURE_NOTE`, and the two call sites in `handleSetlist` and `handlePick` passing `{ edit, whisper }`. A comment above the token branch: the text names the caller's connection state and the reply it would edit is public (the deferred `/setlist` reply, or the picker message), so it goes in an ephemeral follow-up; the public reply still has to be resolved, hence the neutral edit first.
2. `plugins/music/src/commands.test.ts`:
   - `fakeCommand` (`:326-347`) and `fakePick` (`:478-504`) gain `followUps: { content?: string; flags?: unknown }[]` with a `followUp` recorder, and `calls: string[]` recording "defer" / "reply" / "edit" / "update" / "followUp" in the order they happen (as `fakePartyCommand` does); both are returned.
   - `shown(run)` (`:349-352`) includes `followUps`: it is "what the user is shown, wherever the handler chose to put it", and an ephemeral follow-up is shown to the caller. That keeps the existing "recording a build" tests at `:708-735` passing unchanged (they assert "no longer valid" / "still saved" through `shown`); the new tests assert placement explicitly.
   - `wirePicker(getSetlist, { connected = false, spotify }: { connected?: boolean; spotify?: SpotifyClient } = {})`: `connected: true` stores a connection for "user-1" (`putConnection(freshState(), "user-1", "RT", 1)`, as `wireBuild` does) and `spotify` replaces the `{}` stand-in. Existing callers pass nothing and keep what they get.
   - `describe("a failed Spotify refresh during /setlist stays with the caller")`, each test driving `handleSetlist()` with `fakeCommand({ artist: "Band" })`:
     - "a caller who hasn't connected is told privately": `wireBuild(async () => {}, buildSpotify(), { connected: false })` -> `run.edits` is exactly one entry whose content equals `PRIVATE_FAILURE_NOTE` (export it, or assert on "only you can see"), `run.followUps` is exactly one entry with `flags` equal to `MessageFlags.Ephemeral` and content containing "/spotify connect", `run.calls` equals `["defer", "edit", "followUp"]`, and `expectOneStop("token")`.
     - "a dead grant is told privately": `wireBuild(async () => {}, buildSpotify({ refresh: async () => ({ ok: false, status: 400, code: "invalid_grant", error: "Refresh token revoked" }) }))` -> the same shape, the follow-up containing "no longer valid".
     - "a refresh Spotify can't do right now is told privately too": the 503 shape from `:726` -> the same shape, the follow-up containing "still saved".
     - "a successful build still answers in the channel": `wireBuild(async () => {}, buildSpotify())` -> `run.edits[0].content` contains "Added 1 of 2 songs." and `run.followUps` is empty.
   - In `describe("the show picker", ...)` (`:809`), or a sibling describe, driving `handlePick` the way that block does (`fakePick(pickerCustomId("user-1"), [<id>], "user-1")` with a `getSetlist` that answers `{ ok: true, setlist: setlist() }`):
     - "a picked show whose caller hasn't connected is told privately": `wirePicker(getSetlist)` (not connected by default) -> `run.updates` is one entry ("Building the playlist..."), `run.edits` one entry equal to the note, `run.followUps` one ephemeral entry containing "/spotify connect", `run.calls` equals `["update", "edit", "followUp"]`.
     - "a picked show whose grant is dead is told privately": `wirePicker(getSetlist, { connected: true, spotify: buildSpotify({ refresh: <the dead-grant answer> }) })` -> the same shape with "no longer valid".
     - "a picked show that builds still answers in the channel": `wirePicker(getSetlist, { connected: true, spotify: buildSpotify() })` -> `run.edits[0].content` contains "Added" (the `setlist()` fixture's songs against `buildSpotify`'s search: read `:63-77` and `:536-539` and assert the exact count) and `run.followUps` is empty.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: `/setlist` and its show picker now answer a failed Spotify refresh in a note only the caller can see, instead of editing "haven't connected" / "no longer valid" into the public reply; the public reply says the playlist could not be built (#239).
4. This file, committed as `docs/plans/239-setlist-token-failure-is-private.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every path out of `buildInto`, the edit-then-followUp order on a deferred command and on an updated component interaction (discord.js 14.27), whether any other public reply in `commands.ts` still carries `token.error` or `access.message` (`grep token.error` and `access.message`), and the `/setlist` picker's "stale control" and "not owner" refusals staying ephemeral; B: claims-vs-code over this plan, the CHANGELOG and the comment, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
8. PR `fix(music): tell a /setlist caller about a failed Spotify refresh privately, not in the channel (#239)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #239`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Acceptance) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The connection-state text is sent only in an ephemeral message on the command path | 1, 2 | the not-connected, dead-grant and can't-refresh tests | drop the `Ephemeral` flag from `handleSetlist`'s whisper -- the `flags` assertion; edit `token.error` into the public reply as before -- the edit-equals-note assertion |
| The same on the picker path | 1, 2 | the two picker "told privately" tests | wire `handlePick`'s whisper as a no-op -- no follow-up recorded; drop its flag -- the `flags` assertion |
| The public reply is resolved before the private note | 1, 2 | the `calls` assertions in both describes | whisper before edit -- the order |
| A successful build and a successful pick still answer publicly | 1, 2 | the two "still answers in the channel" tests | send the build result through `whisper` -- the edit assertion and the empty-followUps assertion |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
