# #195 (trimmed) -- the party handlers nobody drives, the runner's remaining failure cases and a party's survival across a restart are pinned

Epic #237 child, S, test-only. The review's list has shrunk under this epic: the add and skip handlers (#134, #153, #152), the Join button (#234), `/spotify connect` (#189), the access check's ephemeral defer (#134), the sweep race (#234), a rejecting dependency during a fired timer (#151), the failure counter surviving a party (#234), the party-sweep wiring and dispose (#147) and a host failure (#194) are all tested now. This plan is what is left. The mutation table is its whole evidence, so the gate is the lighter lane: ONE read-only auditor (see step 6). No CHANGELOG entry. Lands AFTER #194 (its handler and runner changes are what these tests pin).

## Plan (execute as written)

Written 2026-10-08 against `main` at `098dee2`, with #194 assumed merged. Cites are to that tree; re-find by name.

### What is wrong

- `commands.test.ts` drives `/party add`, `/party skip`, the Join button and `/spotify connect`, but not `/party start`, `/party leave`, `/party stop` (beyond #194's admin case), `/party status`, nor the "only makes sense in a server" refusal of `handleParty`. The host-only stop, the host's leave ending the party and cancelling its timer, a member's leave keeping it, the ephemeral access failure on start, the public Join-button follow-up, and the status text through the handler are all unpinned: delete any of them and the suite is green.
- `runner.test.ts` has no case for a token failure at a boundary (a `REVOKED` answer when the next track plays: the member must be dropped at once, not counted), for two transient failures across a boundary (the second strike at the next track drops the member), for `stop(guildId)` cancelling an armed timer, for a `notify` that rejects (the runner's contract says it never throws; a rejecting one must not take the boundary down), or for the no-device rescue's own failures (`devices` failing, `transfer` failing, the retried `play` failing: each ends in the "no Spotify player is awake" outcome, never a throw).
- Nothing tests that a party written to `parties.json` is loaded by a fresh activation and re-armed by the first sweep (`initParties`, `index.ts`'s `activate`, `sweep`'s re-arm branch).

### Decisions

- **Handler tests use the `/party` harness as it stands after #194** (`fakePartyCommand` with `calls`, `deferred`/`replied`, `manageGuild`; `wireParty` with `members`, `queue`, `index`, `configured`, `search`, `outcomes`, `skipOutcomes`). A `stop:<guild>` entry recorded by `partyRunnerDouble.stop` is the one addition.
- **Runner tests use `makeRunner`, `fakeClock`, `tokenSequence` and the fixture party as they stand.** No source change anywhere; if a case cannot be driven without one, say so in the PR instead of changing the source.
- **The restart test lives in `index.test.ts`,** in the shape of the #148 activation tests: write a playing party into `<dir>/parties.json` before `createPlugin`, activate, run `plugin.ticks[0].run()` once, and read the runner's effect through what the tick does (the fetch stub records the playback-state read for the member).

### Steps

1. `plugins/music/src/commands.test.ts`:
   - `partyRunnerDouble.stop(guildId)` records `stop:<guild>` on `calls`.
   - `describe("the party's start command")`: "a server that already has a party is refused before any defer" (`calls` equals `["reply"]`, "already a party"); "a caller without party access is told privately and no party opens" (`scopes: SPOTIFY_SCOPES`: ephemeral defer, one edit containing "Grant it here", no follow-up, `getParty` still undefined -- seed no party); "a start opens the party, confirms privately and posts the Join button publicly" (no party seeded: `calls` equals `["defer", "edit", "followUp"]`, the follow-up has `components` with one row, its content names the caller, the party exists with the caller as host and sole member, `channelId` "C1").
   - `describe("the party's leave command")`: "someone not in the party is refused" (`members: ["host"]`, USER -> one ephemeral reply "not in a party", party unchanged); "a member's leave removes them and keeps the party" (`members: ["host", USER]` -> party remains with `["host"]`, reply "Left the party", no `stop:` call); "the host's leave ends the party and cancels its timer" (USER as host: seed `hostId: USER`; -> party gone, `calls` contains `"stop:G1"`, reply "leaving ended the party").
   - `describe("the party's stop command")`: "no party is refused" (`calls` equals `["reply"]`); "a member who is not the host and cannot manage the server is refused" (the #194 case, if not already there; otherwise skip); "the host's stop closes the party, cancels its timer and answers publicly" (`hostId: USER` -> party gone, `"stop:G1"` recorded, the reply is public: no `Ephemeral` flag, text "Party over").
   - `describe("the party's status")`: "with no party" -> ephemeral "No party here"; "with a playing party" -> the ephemeral reply contains the track name and "In the party:"; "outside a server" (`guildId` null in `fakePartyCommand`) -> "only makes sense in a server" for any subcommand.
2. `plugins/music/src/runner.test.ts`:
   - "a dead grant at a boundary drops the member at once": `tokenSequence("friend", [GOOD, REVOKED])`, `start`, advance to the boundary -> `members` is `["host"]`, one notice naming friend, `plays` for track two name the host only.
   - "two transient failures across a boundary are the second strike": the friend's `play` fails (a 5xx) on track one and on track two -> after the first, still a member and one warning "1 of 2"; after the boundary, dropped and one notice.
   - "stop cancels an armed timer": `start`, `stop("G1")` -> `pendingCount()` 0, and `advanceTo(NOW + TRACK_MS)` plays nothing more.
   - "a notify that rejects does not take the boundary down": `makeRunner` with a `notify` that rejects; a member fails fatally at the boundary -> the advance's promise settles, the member is dropped, the next timer is armed, the error reaches `log.error` (through #151's catch) -- read `arm`'s catch and assert what it logs.
   - "the no-device rescue's own failures end in the awake-your-player outcome": `play` answers 404 "No active device" and (a) `devices` fails, (b) `devices` lists one but `transfer` fails, (c) `transfer` succeeds but the retried `play` fails -> each outcome is `ok: false` with "no Spotify player is awake", no throw, exactly the expected number of `play` calls.
3. `plugins/music/src/index.test.ts`, `describe("a party survives a restart")`: "a party in parties.json is loaded and re-armed by the first sweep": write `{ parties: { G1: <a playing party for one connected member with a track started a minute ago> } }` to `<dir>/parties.json` and the member's connection to `<dir>/music.json` before `createPlugin`; activate; the fetch stub answers the token refresh and a playback state that is in sync; `await plugin.ticks[0].run()` -> the stub saw one playback-state read for the member, and the host's info log carries "re-arming party in guild G1"; dispose.
4. This file, committed as `docs/plans/195-party-handlers-runner-cases-and-restart-pinned.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR. Then the lighter gate: ONE read-only auditor (a background Agent subagent with the tool discipline baked in, handed the committed tree and the issue) that re-derives the mutation table by reading the source and the new tests, names any mutation from the issue's list that would still survive, and checks every claim in the test names and this plan against the source. Every evidenced finding fixed or declined in writing; at most two rounds, then message the orchestrator.
7. PR `test(music): pin the remaining party handlers, the runner's boundary and rescue failures, and a party's survival across a restart (#195)`, body per `/work-on` plus the pasted checks, the mutation rows and the audit record; `Closes #195`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix, what is left of it) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| Start: the already-a-party refusal, the private access failure, the public Join post | 1 | the three start tests | drop the refusal; make the defer public; drop the follow-up |
| Leave: a member leaves, the host's leave ends the party and cancels the timer | 1 | the three leave tests | drop the membership check; drop `runner.stop` on a host leave |
| Stop: host-only (or admin), closes, cancels, answers publicly | 1 | the stop tests | drop the host check; drop `runner.stop`; make the reply ephemeral |
| Status and the server-only refusal | 1 | the status tests | drop the guild check |
| A dead grant at a boundary drops at once | 2 | "a dead grant at a boundary ..." | treat `revoked` as a strike |
| Strikes persist across a boundary | 2 | "two transient failures across a boundary ..." | clear the count at each boundary |
| `stop` cancels the timer | 2 | "stop cancels an armed timer" | drop the cancel |
| A rejecting `notify` does not take the boundary down | 2 | "a notify that rejects ..." | (guarded by #151's catch; the test pins the contract) |
| The rescue's own failures end in the awake-your-player outcome | 2 | the three rescue tests | return the raw error on a failed `devices`/`transfer`/retry |
| A party on disk is loaded and re-armed | 3 | "a party in parties.json is loaded ..." | skip `initParties`; drop the sweep's re-arm branch |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
