# #133 -- a refresh that fails for any reason but a dead grant keeps the Spotify connection

Standalone S. Behaviour change (what a failed refresh does to stored state, and two reply texts): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `2820afe` (`plugins/music` at 1.6.0 + Unreleased). Cites are to that tree.

### What is wrong

`plugins/music/src/tokens.ts:27-33` removes the user's stored connection on **every** `{ ok: false }` from `spotify.refresh`. `spotify.ts:267-283` returns `{ ok: false }` for a timeout and a connection failure (no `status`) and for every non-2xx (`status` set), so a 429, a 5xx or a ten-second blip deletes the only copy of the refresh token. The party sweep (`runner.ts:257-260`) and every track start (`runner.ts:136`) refresh each member's token every minute, so a Spotify outage silently disconnects everyone in a party and each of them must redo the consent flow. The JSDoc at `tokens.ts:11-15` says a failed refresh "is almost always a revoked or superseded grant", which is only true of HTTP 400 `invalid_grant`.

### Decisions

- **A grant is dead only when Spotify says so: HTTP 400 with the OAuth error code `invalid_grant`** (RFC 6749 section 5.2: the refresh token is invalid, expired or revoked). Everything else keeps the stored connection and tells the person to try again: a timeout or connection failure (no status), 429, any 5xx, and 401 `invalid_client`, which is the app's own client id/secret being wrong (an operator problem the user cannot fix by reconnecting). A 400 whose body carried no readable code keeps the connection too: deleting on ambiguity is the failure this issue is about.
- **Classification reads Spotify's machine-readable `error` field, never the prose.** `describeFailure` (`spotify.ts:244-262`) prefers `error_description` ("Refresh token revoked") for the message, so the code must be surfaced separately: a failed `Result` gains an optional `code` (set only when the body's `error` is a string). `isDeadGrant(failure)` is the one place that decides, exported from `spotify.ts` beside `classifyPlayerError`.
- **`TokenResult`'s failure gains `kind: "not-connected" | "revoked" | "unavailable"`** (additive). Only `tokens.ts` sets it. `runner.ts:137` keeps treating every failed refresh as fatal: that is #154's scope, and `kind` is what #154 branches on; this PR does not touch the runner.
- **No version bump.** The entry goes under `## [Unreleased]` `### Fixed` in `plugins/music/CHANGELOG.md`, as #99 did; `plugins.json` is unaffected (Unreleased is not a release), so `generate-index --check` stays green. The music release that ships this is the operator's bump PR, not this one.
- **The existing `commands.test.ts:698-708` fake becomes an explicit 400 `invalid_grant`.** Today it returns a bare `{ ok: false, error: "Refresh token revoked" }`; after this change that would read as "unavailable" and the test would fail. Making it say `invalid_grant` pins that a dead grant still gets "no longer valid", and a new sibling test pins the transient path at the same consumer boundary.

### Steps

1. `plugins/music/src/spotify.ts`
   - `Result<T>` failure: `{ ok: false; error: string; status?: number; code?: string }`; JSDoc for `code`: Spotify's own `error` code from the accounts host (`invalid_grant`, `invalid_client`, ...) or the API's `error.message`-less bodies, when the body carried a string one.
   - `describeFailure(response)` returns `{ error: string; code?: string }` (the message exactly as before; `code` = `body.error` when it is a string). `call()` returns `{ ok: false, error, status, ...(code ? { code } : {}) }`, so an existing `toEqual` on a failure without a code is unchanged.
   - `export function isDeadGrant(failure: { status?: number; code?: string }): boolean { return failure.status === 400 && failure.code === "invalid_grant"; }` with a JSDoc that cites RFC 6749 section 5.2 and says why 401 is not included.
2. `plugins/music/src/tokens.ts`
   - `TokenResult` failure: `{ ok: false; error: string; kind: "not-connected" | "revoked" | "unavailable" }`.
   - Not connected: unchanged text, `kind: "not-connected"`.
   - `if (!refreshed.ok)`: when `isDeadGrant(refreshed)`, remove the connection and return the existing "no longer valid ... reconnect" text with `kind: "revoked"`; otherwise return `{ ok: false, kind: "unavailable", error: "Spotify couldn't refresh your connection right now (" + refreshed.error + "). Your link is still saved -- try again in a moment." }` and write nothing.
   - Rewrite the JSDoc: a refresh fails for two unrelated reasons, and only a dead grant is dropped here; the rest is left for the next call.
3. Tests
   - `plugins/music/src/spotify.test.ts`, in `describe("createSpotifyClient")`: `refresh on a 400 invalid_grant surfaces the status and the code` (`{ error: "invalid_grant", error_description: "Refresh token revoked" }`, 400 -> `status: 400, code: "invalid_grant"`, error contains "Refresh token revoked"); `a 503 HTML body surfaces the status and no code`; and a new `describe("isDeadGrant")`: true for `{ status: 400, code: "invalid_grant" }`; false for `{ status: 401, code: "invalid_client" }`, `{ status: 400 }` (no code), `{ status: 503 }`, `{}` (timeout).
   - New `plugins/music/src/tokens.test.ts`, driving `accessTokenFor(createSpotifyClient(CONFIG, fakeFetch), "u1")` over the live store (`commit(putConnection(freshState(), "u1", "RT1", 0, SPOTIFY_SCOPES))` in `beforeEach`; the store has no writer in tests, so `commit` is in-memory): `a revoked grant (400 invalid_grant) removes the connection and says reconnect` (asserts `musicState().connections.u1` undefined, `kind: "revoked"`); `a 503 keeps the connection and says try again`; `a 429 keeps it`; `a timeout keeps it` (fake fetch throws an `Error` named `TimeoutError`); `a connection failure keeps it` (fake fetch throws `TypeError`); `a 401 invalid_client keeps it` (each asserts `connections.u1.refreshToken === "RT1"`, `kind: "unavailable"`, error contains "still saved"); `a rotated refresh token and the granted scopes are persisted` (`{ access_token, refresh_token: "RT2", scope }` -> store holds `RT2` and the scope string, result carries them); `nothing connected says connect first` (`kind: "not-connected"`, no fetch call).
   - `plugins/music/src/commands.test.ts:702`: the fake returns `{ ok: false, status: 400, code: "invalid_grant", error: "Refresh token revoked" }`; keep the assertion. New sibling test: `nothing is recorded and the connection is kept when Spotify cannot refresh it right now` (fake `refresh` returns `{ ok: false, status: 503, error: "Spotify returned HTTP 503" }`; reply contains "still saved"; `recorded` is `[]`; the store still holds the connection the helper seeded, read via `musicState()` -- look at how `wireBuild` seeds it, `commands.test.ts` top, before asserting).
4. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`: "A token refresh that fails because Spotify is unreachable, slow, rate-limiting (429) or erroring (5xx), or because the app's own credentials are refused (401), no longer deletes the user's stored connection -- only a dead grant (HTTP 400 `invalid_grant`) does. The reply says the link is still saved and to try again; a party member's token therefore survives a Spotify blip (#133)."
5. This file, committed as `docs/plans/133-keep-connection-on-transient-refresh.md`.
6. Checks: `just check` from the repo root (lint, typecheck, test, build, index-check, contract-check). On this Windows box `bun test` also fails the 212 tracker tests of #232 (EBUSY cleanup); the music suite must be fully green (`bun test plugins/music`) and the full-suite failure set must be exactly the #232 set. Paste the counts. CI is the arbiter for the whole suite.
7. Gate: me plus two read-only reviewers with different lenses (A: correctness and failure modes of the classification and the store writes -- can a dead grant ever arrive without `invalid_grant`, can a transient failure ever carry it, what the party sweep and `/setlist` now do on each path; B: claims-vs-code over this plan, the CHANGELOG entry, the JSDoc and the RFC claim, walking every coverage row and running the mutations in a scratch worktree). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round.
8. PR `fix(music): keep the Spotify connection when a refresh fails for anything but a dead grant (#133)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #133`. Standalone issue: merged after CI (squash, the repository-admin bypass the repo's instructions describe), then `main` fast-forwarded. No tag: the next music bump PR releases it.

### Coverage

| Outcome (the issue has no Acceptance section; these are its observable outcomes) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A timeout, connection failure, 429 or 5xx on refresh keeps the stored connection and answers "unavailable" | 1, 2 | `tokens.test.ts`: the 503, 429, timeout and connection-failure cases | delete the `isDeadGrant` branch in `tokens.ts` so every failure removes |
| A 400 `invalid_grant` still removes the connection and says reconnect | 1, 2 | `tokens.test.ts` revoked case; `commands.test.ts:698` (updated) | make `isDeadGrant` return `false` always |
| The decision reads Spotify's `error` code, not the prose | 1 | `spotify.test.ts` 400 case; the `tokens.test.ts` revoked case drives a real client with a fake fetch | stop setting `code` in `call()`: the revoked case then keeps the connection |
| 401 `invalid_client` keeps the connection | 1, 2 | `tokens.test.ts` 401 case; `isDeadGrant` table | widen `isDeadGrant` to any 4xx |
| `/setlist` on a transient failure says the link is kept and records nothing | 2 | the new `commands.test.ts` sibling | return the "no longer valid" text on the unavailable path |
| A rotated refresh token and the granted scopes still persist on success | -- (existing, previously untested) | `tokens.test.ts` rotation case | drop the `putConnection` commit |

Run each mutation in a scratch worktree (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.
