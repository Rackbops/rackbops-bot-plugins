# #151 -- a rejection inside a timer-fired track advance is caught, logged and re-armed, never unhandled

Standalone S. Behaviour change (what happens when a boundary's disk write fails): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`; the cites below are to that tree, so re-find each by function name. Since then #234 (PR #241) and #147 (PR #245) have landed in `runner.ts`: `arm` now begins with `if (stopped) return;` (keep that first; your change is to the callback it schedules), `sweep` takes an optional `AbortSignal` (call it with none), and `makeRunner` in `runner.test.ts` already captures `log.info` lines beside `warnings`; add `errors` the same way. Subordinate #3's #190 (in flight) also edits `makeRunner` (a `mentions` capture), so expect a both-sides conflict there when you merge main; keep both.

### What is wrong

`plugins/music/src/runner.ts:105-109` arms the end-of-track timer as `deps.schedule(delay, () => { void advanceParty(guildId); })`. `advanceParty` (`:113-127`) awaits `commitParties` (`party.ts:195-198`: the host writer's `save` rejects on a failed atomic write, ENOSPC or EACCES), then `playCurrent`, whose `playFor` awaits `accessTokenFor` (whose own commit can reject) and whose `noteOutcome` awaits `commitParties` again. A rejection there is unhandled: nothing awaits the voided promise and this repo has no `unhandledRejection` handler, and the bot's own source says an unawaited rejection ends the process (rackbops-discord-bot `src/announce.ts:261`, `src/redeploy.ts:609`), taking every plugin and the gateway connection down. Command and tick paths are wrapped by the host; this timer is the plugin's own. The failed advance also leaves the party with no timer (`advanceParty` cancels it first, `:114-115`, and re-arms only after `playCurrent`, `:125`), so the party stalls until the next sweep re-arms it.

### Decisions

- **The timer's callback catches, logs through the host's logger, and re-arms.** `deps.schedule(delay, () => { advanceParty(guildId).catch((err: unknown) => { deps.log.error(\`party in guild ${guildId}: advancing to the next track failed; re-arming\`, err); arm(guildId); }); })`. `commitParties` sets the in-memory state before it awaits the writer, so by the time it rejects the party has already moved to the next track; `arm` therefore lands the next timer at the next boundary, and a persistent disk failure retries once per track rather than in a loop.
- **`start` and `skip` are unchanged.** Their callers await them and the host wraps the command.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/runner.ts`, `arm`: the catch as decided, with a comment: the plugin's own timer is the one path the host does not wrap, and an unawaited rejection ends the process.
2. `plugins/music/src/runner.test.ts`: a `flush()` helper (`await new Promise<void>((resolve) => setTimeout(resolve, 0))`, since the rejection path has more awaits than `advanceTo`'s two microtask turns), and `errors: string[]` captured from `log.error` in `makeRunner` beside `warnings`; `describe("a boundary whose disk write fails")`:
   - "is logged, does not escape the timer, and re-arms the party": seed the parties store with a writer whose `save` rejects -- read `resetPartiesForTest`'s signature in `party.ts` (it mirrors `resetStoreForTest(state, storage?, path?)`) and build the storage from the test kit's `makeRealStorage()` with `createJsonWriter` overridden to `() => ({ save: async (): Promise<void> => { throw new Error("disk full"); } })`, as `tokens.test.ts` does; seed the party already playing (`party()` has `trackStartedAt: NOW`), arm it with `await runner.sweep()` (a fresh runner re-arms a timerless party without writing), then `await clock.advanceTo(NOW + TRACK_MS)` and `await flush()` -> `errors` has exactly one entry containing "advancing to the next track failed" and "G1"; `clock.pendingCount()` is 1 (re-armed); the party's `index` is 1 (the in-memory state moved on). The test completing green is itself the guard that nothing escaped: bun reports an unhandled rejection as a failure of the run.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: a disk write that fails at a track boundary is now logged and the party re-armed for the next track, instead of surfacing as an unhandled rejection from the party's own timer, which could end the whole bot (#151).
4. This file, committed as `docs/plans/151-timer-advance-rejection-is-caught.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every rejection source inside `advanceParty` (`commitParties`, `accessTokenFor`'s commit, `noteOutcome`'s commit, `deps.notify`), whether `arm` inside the catch can itself throw or loop, what the party looks like in memory versus on disk after the failure, and whether any other voided promise exists in the plugin (`grep` for `void ` in `plugins/music/src`); B: claims-vs-code over this plan, the CHANGELOG and the comment, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
8. PR `fix(music): catch a failed disk write at a track boundary instead of letting it end the process (#151)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #151`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A rejection in a timer-fired advance is caught and logged, never unhandled | 1, 2 | "is logged, does not escape the timer, and re-arms the party" | drop the `.catch` -- the rejection escapes and bun reports it |
| The party is re-armed after the failed advance | 1, 2 | the same test's `pendingCount` assertion | drop `arm(guildId)` from the catch -- no pending timer |
| The error reaches the host's logger, naming the guild | 1, 2 | the same test's `errors` assertion | log through `warn`, or drop the guild id from the message |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
