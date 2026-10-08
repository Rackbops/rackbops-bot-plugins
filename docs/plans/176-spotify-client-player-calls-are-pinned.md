# #176 -- the Spotify client's player calls, scope capture and duration guard each have a test that fails when they are mutated

Epic #237 child, S, test-only. No behaviour changes: this PR adds the tests the review found missing, and the mutation table is its whole evidence. Because nothing it ships has a behaviour surface, the gate is the lighter lane: ONE read-only auditor (see step 6) instead of two adversarial reviewers. No CHANGELOG entry (nothing a user can observe changes).

## Plan (execute as written)

Written 2026-10-08 against `main` at `14df9e6` (#147 merged: `call` takes the host's signal and the player methods take a trailing `signal`; `spotify.test.ts:258-348`, `describe("a player call and the host's signal")`, already drives `play` and `playbackState` through a fake fetch for the signal's sake). Cites are to that tree; re-find by name.

### What is wrong

`createSpotifyClient`'s player half -- `play`, `playbackState`, `devices`, `transfer` (`spotify.ts:408-end`) -- the scope capture in `tokenCall` (`:327`, `if (typeof parsed.scope === "string") tokens.scopes = parsed.scope`, which `exchangeCode` and `refresh` both rely on) and the `duration_ms` guard in `toTrackCandidates` (`:134-138`) have no test that fails when they are mutated: `runner.test.ts` and `party.test.ts` use fake clients, and `spotify.test.ts` covers the token, search and playlist calls only (plus #147's signal tests, which assert the signal and not the request). Mutations that keep the suite green today: `transfer`'s `play: false` flipped to `true`; `Math.max(0, ...)` dropped from `play`; the `isFinite`/`> 0` duration check deleted (the comment says a zero or NaN duration would advance a party instantly and burn the queue); a player URL or verb changed; the scope assignment deleted (every connection then looks playlist-only and `/party` always prompts a reconnect).

### Decisions

- **One fake fetch that records every request.** Reuse the file's `json(body, status)` helper and build the client with a fetch fake that pushes `{ url, method, headers, body }` (the `init` as given) onto an array and answers a scripted response; the `describe("a player call and the host's signal")` block shows the shape. Assert on the recorded request, not on the client's return alone.
- **No source change.** If a test cannot be made red by the mutation its row names without changing `spotify.ts`, say so in the PR instead of changing the source: that would be a different child.

### Steps

1. `plugins/music/src/spotify.test.ts`, `describe("the player calls")`:
   - "play PUTs one explicit URI to /me/player/play with the position rounded and never negative": `play("AT", "spotify:track:one", 12_345.6)` -> one request, `method` `PUT`, url `https://api.spotify.com/v1/me/player/play` (no query), `Authorization` `Bearer AT`, body `{ uris: ["spotify:track:one"], position_ms: 12346 }`; `play("AT", uri, -500)` -> `position_ms` 0.
   - "play targets a device through device_id, URL-encoded": `play("AT", uri, 0, "dev/1 2")` -> url ends `?device_id=dev%2F1%202`.
   - "playbackState GETs /me/player and shapes the answer": a 200 `{ is_playing: true, progress_ms: 42_000, item: { uri: "spotify:track:one", duration_ms: 180_000 }, device: { id: "d1" } }` -> `{ isPlaying: true, progressMs: 42000, trackUri: "spotify:track:one", durationMs: 180000, deviceId: "d1" }`; a body with none of those -> `{ isPlaying: false, progressMs: 0 }` and no other keys.
   - "playbackState treats 204 as nothing playing, not a failure": a 204 -> `{ ok: true, value: undefined }`.
   - "devices GETs /me/player/devices and drops a device with no id": `{ devices: [{ id: "d1", name: "Phone", is_active: true }, { id: null, name: "Restricted" }, { id: "d2" }] }` -> `[{ id: "d1", name: "Phone", isActive: true }, { id: "d2", name: "Unnamed device", isActive: false }]`; a body with no `devices` array -> `[]`.
   - "transfer PUTs the device to /me/player with play: false": `transfer("AT", "d1")` -> `PUT https://api.spotify.com/v1/me/player`, body `{ device_ids: ["d1"], play: false }` (read `transfer`'s body in the source and pin exactly what it sends), `{ ok: true, value: undefined }`.
   - "a player call's failure carries the status for classifyPlayerError": `play` against a 404 `{ error: { message: "No active device found" } }` -> `{ ok: false, status: 404, error: "Spotify returned HTTP 404: No active device found" }`.
2. In `describe("createSpotifyClient")`, beside the existing token tests:
   - "exchangeCode records the granted scopes when Spotify reports them, and none when it does not": a token response with `scope: "playlist-modify-private user-modify-playback-state"` -> `value.scopes` equals it; without `scope` -> `value.scopes` is `undefined` (the key absent).
   - "refresh records the granted scopes the same way": the same two cases through `refresh`.
3. In `describe("toTrackCandidates")`:
   - "a duration is kept only when it is a positive finite number": items with `duration_ms` `180000`, `0`, `-1`, `NaN` (as the literal `NaN`, which `JSON.parse` cannot produce; build the body as an object, not a string), `"180000"` and absent -> only the first has `durationMs` (`180000`); every other candidate has no `durationMs` key.
4. This file, committed as `docs/plans/176-spotify-client-player-calls-are-pinned.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR. Then the lighter gate: ONE read-only auditor (a background Agent subagent with the tool discipline baked in, handed the committed tree and the issue) that re-derives the mutation table by reading `spotify.ts` and the new tests, names any mutation from the issue's list that would still survive, and checks every claim in the test names and this plan against the source. Every evidenced finding fixed or declined in writing; at most two rounds, then message the orchestrator.
7. PR `test(music): pin the Spotify client's player calls, scope capture and duration guard (#176)`, body per `/work-on` plus the pasted checks, the mutation rows and the audit record; `Closes #176`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| `play`'s URL, verb, body, rounding and clamp are pinned | 1 | "play PUTs one explicit URI ..." | change the path or verb; drop `Math.round`; drop `Math.max(0, ...)` |
| `device_id` encoding is pinned | 1 | "play targets a device ..." | drop `encodeURIComponent` |
| `playbackState`'s shaping and its 204 are pinned | 1 | the two `playbackState` tests | `isPlaying: true` by default; 204 reported as a failure |
| `devices`' filtering is pinned | 1 | "devices GETs ..." | keep a device with a null id; default name changed |
| `transfer`'s body is pinned | 1 | "transfer PUTs ..." | `play: true` |
| The scope capture on exchange and refresh is pinned | 2 | the two scope tests | delete the `tokens.scopes` assignment |
| The duration guard is pinned | 3 | "a duration is kept only when ..." | drop `Number.isFinite`; drop `> 0`; drop the `typeof` check |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
