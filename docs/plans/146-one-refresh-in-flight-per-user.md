# #146 -- one refresh in flight per user, and no write against a stale connection snapshot

Standalone, labelled M; the change itself is one function and its tests. Behaviour change (what a refresh writes to the stored connection when something else moved it meanwhile, and how overlapping refreshes for one user are served): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `b14824c` (`plugins/music` at 1.6.0 + Unreleased, with #133 and #154 in). Cites are to that tree.

### What is wrong

`plugins/music/src/tokens.ts:43` reads the stored connection once, `:51` awaits `spotify.refresh` (up to ten seconds), and every write after it trusts that snapshot: `:63` removes the connection by user id, `:72-76` writes `rotated ?? connection.refreshToken` with `connection.connectedAt`. Three other writers can move the store inside that window: `/spotify disconnect` (`commands.ts:538`, `removeConnection`), the connect callback (`index.ts:137-139`, `putConnection` with a fresh token), and another refresh for the same user -- the party runner refreshes a member at every track start (`runner.ts:141`) and in every sweep (`runner.ts:277`), through `index.ts:50`, and a command can land during either (`commands.ts:300`, `commands.ts:611`). So:

- (A) a disconnect during the await is undone by the success path's `putConnection`: the user was told the bot forgot the token, and a moment later it is back;
- (B) a reconnect during the await has its fresh token overwritten -- by the old one (the refresh answered without a rotation, and `scope` is always present, so the commit condition holds) or by a rotation of the old grant;
- (C) two refreshes for one user overlap: the first rotates the stored token, and the loser's `invalid_grant` on the old token removes the connection that now holds the live one, or its success without rotation writes the old token back. (C) is reproduced on the issue, identically at `2820afe` and after #133.

### Decisions

- **One refresh in flight per user (single-flight).** `accessTokenFor` keeps a module-level `Map<discordUserId, Promise<TokenResult>>`; a caller that finds one in flight awaits it and gets the same answer. The entry is deleted when the promise settles, success or failure. This closes (C) outright -- there is no second refresh to race -- and stops the sweep and a track start from spending two Spotify calls on one member in the same second. Keyed by user id only: production has one client, and the tests that run two callers share one too.
- **Every write is checked against the stored connection as it is AFTER the await, never the snapshot.** The connection is re-read; `unchanged` means its `refreshToken` equals the one this refresh sent.
  - Stored connection gone (A, `/spotify disconnect` meanwhile): write nothing, answer `not-connected`. The user asked the bot to forget the token, so the command fails as it would have a moment later; on the success path the access token in hand is discarded, not used.
  - Stored token different (B, a reconnect meanwhile): write nothing -- the user's fresh grant wins, also over a rotation of the old grant, since the fresh grant may carry new scopes. A successful refresh still answers `ok` with the token it got (valid for the old grant, reported with the scopes the refresh returned); a failed one answers `unavailable` (the stored token is newer and the next call uses it), never `revoked`, so the fresh grant is never removed.
  - Unchanged: exactly today's behaviour -- #133's dead-grant rule, rotation and scopes persisted.
- **Belt and braces on purpose.** Single-flight alone leaves (A) and (B); the compare alone leaves (C)'s window between two overlapping Spotify calls (the later rotation invalidates the earlier one's token server-side, and whichever lands last owns the store). Together they cover all three.
- **The scopes reported on a (B) success stay as today:** the refresh's own `scope`, else the stored connection's. Spotify reports `scope` on every refresh, so the fallback is theoretical.
- **`spotify.refresh` and the store are unchanged.** `store.ts` transitions stay pure; `putConnection` and `removeConnection` are untouched; the three answer texts are unchanged.
- **No version bump.** CHANGELOG entry under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/tokens.ts`
   - `const inFlight = new Map<string, Promise<TokenResult>>();` with a comment on the single-flight and its key.
   - `accessTokenFor(spotify, discordUserId)`: return the in-flight promise when there is one; otherwise `const run = refreshOnce(spotify, discordUserId).finally(() => inFlight.delete(discordUserId)); inFlight.set(discordUserId, run); return run;`.
   - `refreshOnce` (module-private): today's body with the re-read after the await -- `const stored = musicState().connections[discordUserId];`, the not-connected answer when `stored === undefined`, `const unchanged = stored.refreshToken === connection.refreshToken;`; the failure branch removes only when `isDeadGrant(refreshed) && unchanged` and answers `unavailable` otherwise; the success branch commits `putConnection(..., rotated ?? stored.refreshToken, stored.connectedAt, scopes)` only when `unchanged && (rotated !== undefined || scopes !== undefined)`.
   - Three answer helpers (`notConnected()`, `unavailable(detail)`, `revoked(detail)`) so each text is written once; the texts themselves unchanged.
   - JSDoc: replace the "#146 is that race, not this" paragraph with the two mechanisms and the three cases.
2. `plugins/music/src/tokens.test.ts`: a `parked(answer)` helper (a fake fetch that counts calls and waits for `release()` before answering), a second seeded user, and a new `describe("while a refresh is in flight")`:
   - "two callers for one user share one refresh and one Spotify call" (a rotation answer; both results `ok` with `AT2`; one call; store holds `RT2`);
   - "the shared answer is the failure too" (`invalid_grant`; both `revoked`; one call; store empty);
   - "callers for different users do not share" (two users; two calls);
   - "a later call after the refresh has settled starts a new one" (first answer `AT2`, second `AT3`; the second sequential call gets `AT3` and the counter reads 2);
   - "a disconnect meanwhile is not undone by the success path" (park a rotation answer; `commit(removeConnection(...))` while parked; release; `not-connected`; store has no connection);
   - "a disconnect meanwhile is not undone by the failure path" (park `invalid_grant`; disconnect; release; `not-connected`; store empty);
   - "a reconnect meanwhile wins over a refresh without rotation" (park `{ access_token, scope }`; `commit(putConnection(..., "RT_NEW", 2_000, PARTY_SCOPES))` while parked; release; `ok` with `AT2`; store still `{ RT_NEW, 2_000, PARTY_SCOPES }`);
   - "a reconnect meanwhile wins over a rotation of the old grant" (same with `refresh_token: "RT_ROT"`; store still `RT_NEW`);
   - "a dead old grant after a reconnect does not remove the fresh one" (park `invalid_grant`; reconnect; release; `unavailable`; store still `RT_NEW`).
   - The existing tests stay as they are: they are the unchanged path.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet.
4. This file, committed as `docs/plans/146-one-refresh-in-flight-per-user.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, the non-tracker suites; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.
7. Gate: me plus two read-only reviewers with different lenses (A: correctness and failure modes -- the single-flight's lifecycle (entry deleted on settle, a rejecting promise, a caller that arrives with a different client), the shared answer's meaning for each caller, the compare's three cases on both paths, what each caller does with a `not-connected` mid-party, the scopes reported on a (B) success, module state across tests; B: claims-vs-code over this plan, the CHANGELOG, the JSDoc, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round.
8. PR `fix(music): one refresh in flight per user, and no write against a stale connection snapshot (#146)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #146`. Standalone issue: merged after CI (squash, the repository-admin bypass the repo's instructions describe), then `main` fast-forwarded. No tag: the next music bump PR releases it.

### Coverage

| Outcome (the issue has no Acceptance section; these are its observable outcomes) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| Two overlapping refreshes for one user make one Spotify call and get the same answer, success or failure | 1, 2 | "two callers for one user share"; "the shared answer is the failure too" | bypass the map (always start a new refresh) -- two calls |
| Overlapping refreshes for different users do not share | 1, 2 | "callers for different users do not share" | key the map by a constant -- one call, the second user gets the first's token |
| The in-flight entry is released when the refresh settles | 1, 2 | "a later call after the refresh has settled starts a new one" | never delete the entry -- the second call gets the first's stale answer |
| A disconnect during the refresh is not undone, on either path | 1, 2 | the two "a disconnect meanwhile" tests | drop the `stored === undefined` branch -- both paths then read `stored.refreshToken` on `undefined` and throw |
| A reconnect during the refresh wins, with or without a rotation of the old grant, and even at the same connect time | 1, 2 | the three "a reconnect meanwhile wins" tests | write when `!unchanged` too -- the stale answer's scopes (`SPOTIFY_SCOPES`) or `RT_ROT` land over the fresh grant; compute `unchanged` from `connectedAt` -- the same-time case writes |
| A reconnect success answers with the refresh's own scopes, not the fresh grant's | 1, 2 | the three "a reconnect meanwhile wins" tests' result assertion | swap the `??` operands of the scopes fallback |
| The write uses the connection as stored now, not the snapshot | 1, 2 | "a reconnect that re-issued the same token" | write `connection.connectedAt` instead of `stored.connectedAt` |
| A dead old grant after a reconnect never removes the fresh one | 1, 2 | "a dead old grant after a reconnect" | remove when `!unchanged` too -- the store is emptied |
| The entry is released when the refresh rejects, and the rejection reaches every joined caller | 1, 2 | "a refresh whose store write fails" | delete the entry only on resolve (a value-preserving `.then`) -- the next call gets the rejected promise |
| One user's refresh settling releases only that user's entry | 1, 2 | "one user's refresh settling does not release another's entry" | `delete(id)` -> `clear()` -- the parked user's next caller starts a second refresh |
| An unchanged refresh persists scopes without a rotation, and a rotation without scopes | 1 | "a refresh that reports scopes but no rotation"; "a rotation that reports no scopes" | the write guard's `\|\|` -> `&&` -- neither writes |
| The unchanged path behaves exactly as before | 1 | the existing revoked, kept, rotation and no-rotation tests | #133's mutations (`isDeadGrant` -> `false`; the rotation commit skipped) |

Equivalent mutant, declined: `stored.refreshToken` -> `connection.refreshToken` in the write, which the `unchanged` guard makes identical.

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.

### Gate round 1 (2026-10-08) -- what it added to the plan above

A (correctness, concurrency): SOUND. B (claims-vs-code, coverage walk): SOUND. Both named the same blocking gap, and every evidenced finding is fixed or declined below. No fix changed what the code does -- tests, comments and a doc string only -- so no second round was run.

- **The rejection arm of the single-flight lifecycle was unpinned** (A F1 / B S1, Medium): a cleanup that only ran on resolve survived the suite, and in production would leave a rejected promise answering every later call for that user until a restart (the host writer's `save` can reject). *Fixed*: a test with a storage writer whose `save` rejects; both joined callers reject, and the next call after a reset starts a new refresh.
- **The write guard's `||` could become `&&` unnoticed** (B S4, Medium): no test gave an unchanged connection exactly one of a rotation or scopes. *Fixed*: a scopes-only and a rotation-only case.
- **"Refreshed every time, with no cache" in the runner overstated** (A F3 / B 1, Medium as a stale claim): a call landing inside an in-flight refresh shares it and can see scopes one refresh old, for at most the flight. *Fixed* in the comment. The behavioural alternative -- an entry keyed by user plus the refresh token it sent, so a caller arriving after a reconnect starts its own -- is *declined*: the window is the flight (sub-second typically, ten seconds worst case), it self-heals on the next call, and it is new logic for a case human timing makes near-unreachable.
- **The scopes reported on a reconnect success were unpinned, and the fallback reads the new grant** (A F4 / B S5, Low): *pinned* (the result asserts the refresh's own scopes). The fallback is reached only when a refresh omits `scope`, which Spotify does not do; *declined* as a logic change.
- **`delete(id)` could become `clear()` unnoticed** (A F2 / B S6, Low-Medium): *fixed*, a test settles one user while another is parked.
- **`unchanged` from `connectedAt`, and the write's `connectedAt` from the snapshot, survived** (B S2, S3, Low): *fixed*, a same-time reconnect case and a same-token case. Adding `connectedAt` to the compare (A F6, for a hypothetical identical re-issued token) is *declined* as logic for a case Spotify does not produce.
- **Coverage-table prose for the disconnect and reconnect rows was wrong** (B 6, Low): the success path throws rather than resurrects without the gone check, and the plain reconnect case is discriminated by scopes, not by `RT1`. *Fixed* above, and the fixture carries a comment.
- **The issue's "skip the write when nothing changed" was neither done nor declined** (B 7, Low): *declined here*. Every real refresh reports `scope`, so the write persists narrowed scopes; skipping it when nothing differs from the store is an optimisation with its own guard and test, outside the race this issue is about.
- **`TokenFailureKind` said `not-connected` "never had one"** (A F5 / B 8, Low): *fixed*; it is also the answer for a connection removed mid-refresh.
- **A test name overclaimed** (B 9, Low): "not undone by the failure path" renamed to what it asserts.
- **Equivalent mutant** (B E1): recorded above.
