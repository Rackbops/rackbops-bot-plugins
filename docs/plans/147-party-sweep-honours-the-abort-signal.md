# #147 -- the party sweep honours the host's abort signal, and no timer is armed after dispose

Standalone S. Behaviour change (what the sweep does when the host aborts it; what the runner does after dispose): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`; the cites below are to that tree, so re-find each by function name. Since then #134 (commands.ts only), #153 (commands.ts only) and #234 (PR #241) have landed. #234 touched `runner.ts` in three places you build on: `forgetGuild` and a count reset in `start` and `syncMember` (not yours to change), and, in `sweep`'s drifted loop, a re-read of the party before EACH resync (`const current = getParty(...)`, with a `break` and an info log when the party moved). Your abort check goes at the top of that loop body, before the re-read: a host abort wins over everything else, and the re-read then never runs for nothing. #190's second item (`music-auth-9`, "dispose cancels timers once but in-flight runner work re-arms them") is this plan's stopped flag; say so in the PR body so #190 can be trimmed.

### What is wrong

`plugins/music/src/index.ts:77-81` registers the `party-sweep` tick as `run: () => activeRunner.sweep()`, dropping the `AbortSignal` the host passes to every tick (`packages/api/contract.d.ts:344-358`), and `README.md:267-274` requires ticks to honour it: pass it to `fetch`, check `signal?.aborted` before each write or post, and return early. `sweep` (`plugins/music/src/runner.ts:261-296`) takes no signal. Per party it runs a parallel per-member phase (a token refresh and a playback read, each bounded at 10 s by the client's own timeout) and then sequential `playFor` resyncs (a refresh, a play, a devices read, a transfer and a retry, each up to 10 s), so a sweep with a few drifting members can pass the host's 30 s bound and keeps issuing play commands and writing `parties.json` after the host has abandoned it, and after a stop's 5 s grace. Separately, `stopAll` (`:298-301`, called from `dispose`, `index.ts:161`) only cancels the timers that exist at that moment: an `advanceParty`, `start` or `skip` already awaiting `playCurrent` calls `arm()` afterwards (`:125`, `:244`) and creates a new timer after dispose, with no stopped flag.

### Decisions

- **The sweep takes the signal and checks it at every step boundary:** before each party, before the per-member phase, and at the top of each iteration of the drifted loop (before #234's party re-read and the `playFor` resync). Once aborted, `sweep` returns with one info log (`party sweep aborted by the host; <n> parties left unchecked`). Between a check and the write it guards there is no await the signal could land in, so no write starts after an abort was observed.
- **The sweep's Spotify calls carry the signal.** `SpotifyClient.playbackState`, `play`, `devices` and `transfer` gain an optional trailing `signal?: AbortSignal`; `call(url, init, signal?)` uses `AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])` when one is given (if `AbortSignal.any` is missing in this Bun, compose by hand with an `AbortController` aborted by either source's `abort` event). `playFor(party, id, positionMs, signal?)` threads it to `play`, `devices` and `transfer`. The token refresh (`accessTokenFor`) stays unsignalled: it is the single-flight shared with commands and is bounded at 10 s on its own. A fetch aborted by the host surfaces through `call`'s existing catch as "couldn't reach Spotify", and the next boundary check returns.
- **A stopped flag.** `stopAll()` sets `stopped = true`; `arm()` returns at once when stopped, so nothing re-arms after dispose. `stop(guildId)` is unchanged: a `/party stop` closes the party, and `arm` already finds none.
- **The tick passes the signal through:** `run: (signal) => activeRunner.sweep(signal)`.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/spotify.ts`: `call(url, init, signal?)` composing the signal as decided; the four player methods and their `SpotifyClient` interface entries gain `signal?: AbortSignal` as the last parameter and pass it through; one JSDoc line on the interface saying it is the host's tick signal, honoured by the sweep. No other method changes.
2. `plugins/music/src/runner.ts`: `PartyRunner.sweep(signal?: AbortSignal)` with the three checks and the info log; `playFor(party, discordUserId, positionMs, signal?)` threading the signal to `play`, `devices` and `transfer`; `let stopped = false` inside `createPartyRunner`, set in `stopAll`, checked first thing in `arm`. A comment on each check saying what it protects (the write or call that follows).
3. `plugins/music/src/index.ts:79`: `run: (signal) => activeRunner.sweep(signal)`.
4. `plugins/music/src/runner.test.ts`, `describe("the tick, when the host aborts it")`:
   - "an already-aborted signal makes the sweep do nothing": a token fake that counts its calls; `await runner.sweep(AbortSignal.abort())` -> zero token calls, no plays, no notices, and one info log containing "aborted" (capture `log.info` in `makeRunner` the way `warnings` are captured).
   - "a sweep stops before the resync once the host aborts during its checks": `const controller = new AbortController()`; the `playbackState` fake calls `controller.abort()` and then returns a drifted state (`isPlaying: true, progressMs: 0, trackUri: "spotify:track:one"` at `NOW + 30_000`); `await runner.sweep(controller.signal)` -> no plays, members unchanged.
   - "the sweep's playback read and the resync's play carry the host's signal": the `playbackState` and `play` fakes record their `signal` argument; a drifted state without aborting -> both recorded signals `toBe(controller.signal)`.
   - "no timer is armed after dispose": `await runner.start("G1")`, `runner.stopAll()`, `await runner.skip("G1")` -> `clock.pendingCount()` is 0.
5. `plugins/music/src/spotify.test.ts`: "a player call given the host's signal is aborted with it": a fake fetch that records `init.signal`; `const controller = new AbortController()`; `await client.playbackState("AT", controller.signal)` (the fake answers a 204 or an empty state); `controller.abort()` -> the recorded `init.signal.aborted` is `true`. And "a player call without a signal is bounded only by the client's own timeout": the recorded signal is not aborted after the test's controller aborts.
6. `plugins/music/src/index.test.ts`: "the party-sweep tick hands the host's signal to the sweep": seed a playing party with one member whose connection is stored (`resetPartiesForTest(openParty(freshParties(), {...}))`, `commit(putConnection(...))` as the file already does around line 155), build the plugin, `await plugin.ticks[0].run(AbortSignal.abort())` -> the file's fetch stub was never called (an aborted sweep makes no token call) and the host's log carries "aborted". Read how `index.test.ts` stubs `fetch` (around line 269) and reuse it.
7. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: the party sweep now honours the host's abort signal (it stops between steps at the 30 s bound and on shutdown, and its Spotify calls are cancelled with it) and the runner arms no timer after the plugin is disposed (#147).
8. This file, committed as `docs/plans/147-party-sweep-honours-the-abort-signal.md`.
9. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
10. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
11. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every await inside `sweep` and `playFor` and where an abort can land in each, whether any write or post can follow an observed abort, what the host does with the signal and the grace (`contract.d.ts:330-358`), `AbortSignal.any` in Bun 1.4.2, the stopped flag against `start`/`skip`/`advanceParty` in flight; B: claims-vs-code over this plan, the CHANGELOG, the README rule and the comments, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
12. PR `fix(music): let the party sweep honour the host's abort signal, and arm no timer after dispose (#147)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #147`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix, both reports) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| An aborted signal stops the sweep before any Spotify call | 2 | "an already-aborted signal makes the sweep do nothing" | drop the check before the per-member phase -- a token call happens |
| An abort during the checks stops the sweep before the resync | 2 | "a sweep stops before the resync once the host aborts during its checks" | drop the check before each resync -- a play appears |
| The sweep's reads and the resync's play carry the signal | 1, 2 | "the sweep's playback read and the resync's play carry the host's signal" | do not pass the signal to `playbackState` or `play` |
| The client aborts a player call with the given signal | 1 | the `spotify.test.ts` case | ignore the parameter in `call` -- the recorded signal never aborts |
| The tick passes the host's signal through | 3 | the `index.test.ts` case | `run: () => activeRunner.sweep()` -- the stub is called |
| No timer is armed after dispose | 2 | "no timer is armed after dispose" | drop the stopped guard in `arm` -- one pending timer |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
