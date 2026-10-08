# #234 -- party runner: fresh failure counts per start and per Join, a truthful Join reply, and a sweep that re-reads the party before it resyncs

Standalone XS (the three edges #154's and #146's review gates surfaced). Behaviour change (when a member is dropped, what the Join button replies, what the sweep does after a boundary moved under it): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`. Cites are to that tree.

### What is wrong

1. `plugins/music/src/runner.ts:92` keeps `failures` (keyed `guild:user`, `:94-96`), and only `noteOutcome` touches it (`:206-219`). `start` (`:241-246`), `stop` (`:303-306`), `stopAll` (`:298-301`) and `syncMember` (`:252-259`) never clear it, and `/party leave` and `/party stop` (`commands.ts:787`, `:810`) cannot reach it. A member who took one non-fatal strike, then left or saw the party stopped, then joined a new party in the same process is dropped on their next single blip; a host in that state closes the new party on one blip (`party.ts:87`).
2. `plugins/music/src/commands.ts:860-867` commits `addMember`, calls `syncMember`, and builds the reply from `outcome.ok` alone. A fatal outcome (Premium, a missing scope, a dead grant, a disconnect) has already removed the member inside `noteOutcome` (`runner.ts:219-220`), and the ephemeral reply still says "Joined, but ...". No test drives the Join button (#195 names the same gap).
3. `runner.ts:262` captures `party` at the top of the sweep's loop body, awaits `accessTokenFor` and `playbackState` per member (`:278-287`), then calls `playFor(party, ...)` with that stale object (`:292`). If the track boundary fires inside that window (the timer's `advanceParty`), the resync targets the previous track at an out-of-range position and can add a spurious failure count. Inferred from the code when filed; the test in Step 3 reproduces it before the fix (run it once against the unfixed tree and paste the red output in the PR).

### Decisions

- **A party's counts start fresh at `start`, and a member's at Join.** `start(guildId)` clears every entry for that guild (a new party, or an idle one restarted by `/party add`); `syncMember(guildId, userId)` clears that member's entry before it plays (pressing Join is a fresh start for that member, and Join is idempotent). `stop` and `stopAll` are left alone: the next `start` clears anyway, and a clear there could not be guarded by a test that `start`'s clear does not already satisfy.
- **Join's reply reads the party after `syncMember`.** A new exported pure function `formatJoinReply(outcome: MemberOutcome, stillMember: boolean): string`: `ok` -> "You're in. Your Spotify should be playing along."; `!ok && stillMember` -> today's "Joined, but your Spotify didn't take the command: <error>"; `!ok && !stillMember` -> "Couldn't join the party: <error>" (the channel already carries the runner's drop-out line). `handlePartyJoin` passes `getParty(partiesState(), guildId)?.members.includes(interaction.user.id) ?? false`.
- **The sweep re-reads the party before it resyncs and skips the tick when the party moved.** After the `drifted` `Promise.all`, `const current = getParty(partiesState(), party.guildId)`; when it is `undefined`, or its `index` or `trackStartedAt` differ from the captured party's, every resync for that party is skipped with one info log (`party in guild <id> moved during the sweep; skipping resync`). The boundary that moved it has just played everyone the new track, and the next sweep checks again.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/runner.ts`
   - A module-private `forgetGuild(guildId)` inside `createPartyRunner`: delete every `failures` key whose prefix is `${guildId}:`. Call it first thing in `start`.
   - `syncMember`: `failures.delete(failureKey(guildId, discordUserId))` before the early returns.
   - `sweep`: after the `drifted` `Promise.all`, re-read the party as decided; `continue` with the info log when it moved; otherwise resync as today. Comment why (the boundary can fire during the per-member awaits).
2. `plugins/music/src/commands.ts`
   - `export function formatJoinReply(outcome: MemberOutcome, stillMember: boolean): string`, next to `formatOutcomes`, with the three texts above.
   - `handlePartyJoin`: after `syncMember`, compute `stillMember` from the party as stored now and reply with `formatJoinReply(outcome, stillMember)`.
3. `plugins/music/src/runner.test.ts` (reuse `tokenSequence`, `UNAVAILABLE`, `GOOD` and `makeRunner` from the #154 block; `commitParties`, `removeMember`, `addMember`, `resetPartiesForTest`, `openParty`, `freshParties` from `./party.js`):
   - "a strike does not survive the party being stopped and started again": `tokenSequence("friend", [UNAVAILABLE])`; `start` (friend strike 1, still a member); `runner.stop("G1")`; `resetPartiesForTest(openParty(freshParties(), party()))` (a fresh unstarted party with the same members); `start` again (friend unavailable again) -> friend still a member, since the new party's counts started fresh.
   - "pressing Join again starts a member's count afresh": `tokenSequence("friend", [UNAVAILABLE])`; `start` (strike 1); `commitParties(removeMember(partiesState(), "G1", "friend"))` (they leave); `commitParties(addMember(partiesState(), "G1", "friend"))` and `runner.syncMember("G1", "friend")` (they press Join; unavailable again) -> friend still a member.
   - "a boundary that fires during the sweep's checks cancels that tick's resync": `resetPartiesForTest(openParty(freshParties(), party({ members: ["host"] })))`; a `let runner: PartyRunner` binding; `fakeSpotify({ playbackState: async () => { await runner.skip("G1"); return { ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }; } })` (the first and only call fires the boundary, then reports drift against the stale snapshot); `clock.advanceTo(NOW + 30_000)`; `await runner.sweep()`; assert `plays` is exactly the skip's play of `spotify:track:two` at `positionMs: 0` and nothing for `spotify:track:one`; the party's `index` is 1; `warnings` is empty. Run this test once against the tree BEFORE Step 1's sweep change and paste its red output in the PR (that is the reproduction the issue asked for).
4. `plugins/music/src/commands.test.ts`
   - `describe("formatJoinReply")`: the three cases, asserting "You're in", "Joined, but" plus the error text, "Couldn't join" plus the error text.
   - `describe("the Join button")`: a fake `MessageComponentInteraction` built like `fakePick` (add `fakeButton(customId, userId, guildId)` with `guildId`, `channelId`, `client: {}`, `user: { id }`, and recorders for `deferReply`, `editReply`, `reply`); `initCommands` wired like `wireBuild` but with a `spotify` whose `refresh` answers `{ ok: true, value: { accessToken: "AT", scopes: PARTY_SCOPES } }` and a `runner` double (every `PartyRunner` method a no-op except `syncMember`); the party seeded with `resetPartiesForTest(openParty(freshParties(), { guildId: "G1", channelId: "C1", hostId: "host", members: ["host"], queue: [one track], index: 0, trackStartedAt: 1 }))`; the joiner connected (`putConnection(freshState(), USER, "RT", 1, PARTY_SCOPES)`). Two cases through `musicInteractions(interaction)` with `customId: PARTY_JOIN_ID`:
     - fatal: `syncMember` removes the member (`await commitParties(removeMember(partiesState(), guildId, userId))`) and returns `{ discordUserId: userId, ok: false, fatal: true, error: "Spotify Premium is required to control playback" }` -> the edit says "Couldn't join" and the Premium text, never "Joined, but"; the member is not in the party.
     - non-fatal: `syncMember` returns `{ discordUserId: userId, ok: false, error: "no Spotify player is awake -- open Spotify and press play on anything once, then rejoin" }` without removing -> the edit says "Joined, but"; the member is in the party.
5. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, one new first bullet covering the three: a member's failure count starts fresh with every party and every Join (a strike no longer follows them into the next party or back through Join); the Join button says "Couldn't join" when the first sync dropped them, instead of "Joined, but"; a party sweep no longer resyncs against a track that ended while it was checking (#234).
6. This file, committed as `docs/plans/234-party-runner-counts-join-reply-sweep-snapshot.md`.
7. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
8. Mutations from the table, each in a scratch worktree of your clone (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.
9. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every path into `playFor`, the counter's lifecycle with the two clears, the sweep's moved check against `advanceParty` and `stop`, what Join does on each outcome; B: claims-vs-code over this plan, the CHANGELOG and the comments, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
10. PR `fix(music): fresh party failure counts per start and Join, a truthful Join reply, and a sweep that re-reads the party before it resyncs (#234)`, body per `/work-on` plus the pasted checks, the reproduction output from Step 3, the mutation rows and the gate's rounds; `Closes #234`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's three items) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A strike does not survive `stop` followed by `start` | 1, 3 | "a strike does not survive the party being stopped and started again" | drop `forgetGuild` from `start` -- the friend is dropped on the second start's blip |
| Pressing Join starts the member's count afresh | 1, 3 | "pressing Join again starts a member's count afresh" | drop the delete in `syncMember` -- the friend is dropped on the join's blip |
| A boundary firing during the sweep's checks cancels that tick's resync | 1, 3 | "a boundary that fires during the sweep's checks cancels that tick's resync" | drop the re-read (resync against the captured party) -- a play of track one appears |
| Join's reply says "Couldn't join" when the sync dropped the member | 2, 4 | the Join-button fatal case | pass `true` for `stillMember` always -- "Joined, but" |
| Join's reply still says "Joined, but" when the member stays | 2, 4 | the Join-button non-fatal case | pass `false` always -- "Couldn't join" |
| `formatJoinReply`'s three texts | 2, 4 | `describe("formatJoinReply")` | swap the two failure texts |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
