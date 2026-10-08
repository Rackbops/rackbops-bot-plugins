# #148 -- the connect handshake is driven through activate()'s real redeemState and saveConnection closures

Epic #237 child, S, test-only. No behaviour changes: this PR adds the end-to-end test the review found missing, and the mutation table is its whole evidence. Because nothing it ships has a behaviour surface, the gate is the lighter lane: ONE read-only auditor (see step 5) instead of two adversarial reviewers. No CHANGELOG entry.

## Plan (execute as written)

Written 2026-10-08 against `main` at `d74ecf0`; #189 and #247 have landed since (the `proxy` parameter of `startCallbackServer` is now required, `index.ts` reads the proxy host through `present`, and `redeemPendingAuth` ignores inherited keys), none of which this test touches. Cites are to `d74ecf0`; re-find by name.

### What is wrong

`activate()` builds the callback server's `redeemState` and `saveConnection` closures (`plugins/music/src/index.ts`, inside `startCallbackServer(...)`'s deps): `redeemState` runs `redeemPendingAuth` and commits the pruned state whether or not the token was valid (so a leaked link cannot be replayed), answers the expired and unknown texts, and carries the handshake's asked scopes; `saveConnection` commits `putConnection(..., scopes)` and logs the user id. `store.test.ts` pins `redeemPendingAuth` as a pure function and `server.test.ts` drives `handleCallback` with fake deps, so no test exercises these closures: deleting `await commit(redeemed.state)` (the token stays replayable and expired tokens are never pruned), dropping `scopes` from the `putConnection` call, or dropping the asked-scopes fallback from the answer all leave the suite green. `index.test.ts` reaches the real listener only for a missing state (400 before `redeemState`) and, since #190, for a store write that fails.

### Decisions

- **One real activation, a seeded handshake, a stubbed token endpoint, two callbacks.** The shape is the #190 test at `index.test.ts:146-180` (a temp `dataDir`, `makeRealStorage()`, `freePort()`, `createPlugin` + `activate()`, a real `fetch` against the listener, `dispose()` and `rm` in `finally`), plus a seeded pending handshake committed AFTER `activate()` (`initStore` replaces the in-memory state from the file, so a seed before it would be lost) and a `globalThis.fetch` stub for `https://accounts.spotify.com/api/token` only (every other URL answers 500 "unexpected request", as `stubFetch` at `:346` does; write a small `stubTokenExchange(answer)` helper that records each request's form body and returns `{ calls, restore }`).
- **No source change.** If a test cannot be made red by its row's mutation without changing `index.ts`, say so in the PR instead of changing the source.

### Steps

1. `plugins/music/src/index.test.ts`, `describe("the connect handshake through activate()")`, importing `beginPendingAuth`, `commit`, `musicState` and `PENDING_AUTH_TTL_MS` (or whatever `store.ts` exports for the TTL; read it) from `./store.js`:
   - "a real handshake consumes the token, stores the connection with Spotify's scopes in memory and on disk, and refuses a replay": seed `await commit(beginPendingAuth(musicState(), "T", "424242", Date.now(), "playlist-modify-private"))`; the token stub answers `{ access_token: "AT", refresh_token: "RT1", scope: "playlist-modify-private user-modify-playback-state" }`; `GET http://127.0.0.1:<port>/spotify/callback?code=C&state=T` -> 200 and "Spotify connected"; the stub saw one call whose form body has `grant_type=authorization_code`, `code=C` and `redirect_uri=<FULL_ENV.SPOTIFY_REDIRECT_URI>`; `musicState().connections["424242"]` has `refreshToken` "RT1" and `scopes` equal to Spotify's string; `musicState().pending` has no "T"; the file `<dir>/music.json` (read it back with `Bun.file(...).json()`) has the same connection and no pending "T"; the host's info log carries "connected Spotify for discord user 424242". Then a second `GET ...?code=C2&state=T` -> 400 and "didn't work", the stub still saw exactly one call, and the stored connection is unchanged.
   - "a token response with no scope keeps the scopes the handshake asked for": the same with the stub answering no `scope` -> `connections["424242"].scopes` equals "playlist-modify-private".
   - "an expired handshake is refused with the expired text, and is consumed": seed with `now` set to `Date.now() - <TTL> - 60_000` -> the callback answers 400 containing "expired"; `musicState().pending` has no "T", nor does the file; the stub saw no call; no connection was stored.
2. This file, committed as `docs/plans/148-activate-handshake-closures-are-exercised.md`.
3. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
4. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
5. The lighter gate: ONE read-only auditor (a background Agent subagent with the tool discipline baked in, handed the committed tree and the issue) that re-derives the mutation table by reading `index.ts`'s closures and the new tests, names any mutation from the issue's list that would still survive, and checks every claim in the test names and this plan against the source. Every evidenced finding fixed or declined in writing; at most two rounds, then message the orchestrator.
6. PR `test(music): drive the Spotify connect handshake through activate()'s real closures (#148)`, body per `/work-on` plus the pasted checks, the mutation rows and the audit record; `Closes #148`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The token is consumed in memory and on disk, so the link cannot be replayed | 1 | the first test's replay and file assertions | delete `await commit(redeemed.state)` -- the replay answers 200 and the file keeps "T" |
| Spotify's scopes land on the stored connection | 1 | the first test's `scopes` assertion | drop `scopes` from the `putConnection` call |
| The asked scopes are the fallback | 1 | "a token response with no scope ..." | drop `answer.scopes = redeemed.scopes` |
| An expired handshake is refused with its own text and consumed | 1 | "an expired handshake ..." | answer the unknown text for both; skip the commit on failure |
| The exchange sends the code and the registered redirect | 1 | the first test's stub-body assertion | (regression guard; `exchangeCode` is already pinned in `spotify.test.ts`) |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
