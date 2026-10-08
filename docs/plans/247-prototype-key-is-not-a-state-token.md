# #247 -- a state token that is not an own key of the pending map is unknown

Epic #237 child, XS. Behaviour change (which tokens redeem): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `dd32261` (#190 merged). Cites are to that tree; re-find by function name.

### What is wrong

`redeemPendingAuth` (`plugins/music/src/store.ts:99-109`) reads `state.pending[stateToken]` on a plain object that came from JSON. For `__proto__`, `constructor` or `toString` the lookup returns an inherited value (`Object.prototype`, the `Object` function, a method) rather than `undefined`, so the unknown branch at `:104` is skipped; `entry.expiresAt` is `undefined`, so `:105` passes too, and the function answers `{ ok: true, discordUserId: undefined }`. The token comes straight off the callback URL (`server.ts`, `url.searchParams.get("state")`), so anyone can send one, and with a valid Spotify `code` the callback then calls `saveConnection(undefined, ...)`, storing a connection under the key `"undefined"`. The other string-keyed reads on these maps (`putConnection`'s `state.connections[discordUserId]`, `tokens.ts`'s read of the stored connection) take a Discord user id, which Discord supplies as a numeric snowflake, so they are not reachable with such a key today; they get the same guard because it is one expression and the next caller may not be Discord.

### Decisions

- **Only an own key is a handshake.** `const entry = Object.hasOwn(state.pending, stateToken) ? state.pending[stateToken] : undefined;` in `redeemPendingAuth`; everything after it unchanged (the destructuring that removes the key already removes only an own key). A comment: the maps are plain objects parsed from JSON, so an inherited key must never count.
- **The same guard on the connection reads:** `putConnection`'s carried-scopes read (`:125`) and `removeConnection` need no change for correctness (an inherited key yields `undefined` scopes, and destructuring removes nothing), but the read in `tokens.ts` (`refreshOnce`'s `stored.connections[discordUserId]`; re-find it) becomes `Object.hasOwn(...) ? ... : undefined` so a prototype key is "not connected" rather than an object with no refresh token.
- **No version bump.** The CHANGELOG bullet travels in the PR body (see the steps).

### Steps

1. `plugins/music/src/store.ts` and `plugins/music/src/tokens.ts` as decided.
2. `plugins/music/src/store.test.ts`, "a prototype key is not a handshake": for each of `__proto__`, `constructor` and `toString`, `redeemPendingAuth(freshState(), key, NOW)` answers `{ ok: false, reason: "unknown" }` with `state.pending` equal to `{}`; and against `beginPendingAuth(freshState(), "T", "user1", NOW)` the same keys answer unknown while the returned state still holds `T` for `user1` (and `T` itself still redeems).
3. `plugins/music/src/server.test.ts`, in `describe("handleCallback")`: "a prototype key sent as the state answers 'That link didn't work' and saves nothing": `redeemState` backed by the real `redeemPendingAuth` over `freshState()` (answer `{ ok: false, error: "That connect link isn't valid any more." }` when it is not ok, as `index.ts` does), `saveConnection` counting its calls; `get("?code=C&state=__proto__")` -> status 400, body contains "didn't work", zero saves.
4. `plugins/music/src/tokens.test.ts`: "a prototype key is not a connection": `accessTokenFor(spotify, "__proto__")` with an empty store -> `{ ok: false, kind: "not-connected" }` and no refresh call (use the file's parked/recording fetch to count).
5. The CHANGELOG bullet goes in the PR body under `## CHANGELOG bullet` (no edit to `plugins/music/CHANGELOG.md`; the orchestrator lands every bullet in one docs PR at the end of the epic). Its text: a Spotify connect callback whose state token is a JavaScript prototype key (`__proto__`, `constructor`, `toString`) is now refused as unknown, instead of being redeemed for no user and storing a connection under "undefined" (#247).
6. This file, committed as `docs/plans/247-prototype-key-is-not-a-state-token.md`.
7. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
8. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
9. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every string-keyed read on `pending`, `connections` and `parties` across `store.ts`, `tokens.ts`, `party.ts` and `commands.ts`, which of them take input a user controls, and whether `Object.hasOwn` is available in this Bun and TypeScript target; B: claims-vs-code over this plan, the bullet and the comment, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
10. PR `fix(music): refuse a prototype key as a Spotify state token (#247)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #247`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Acceptance) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A prototype key is unknown, and a real handshake beside it survives | 1, 2 | "a prototype key is not a handshake" | restore the plain index -- `ok: true` |
| The callback answers 400 and saves nothing for such a token | 1, 3 | "a prototype key sent as the state ..." | the same mutation -- a save |
| A prototype key is "not connected" in the token lookup | 1, 4 | "a prototype key is not a connection" | restore the plain read -- a refresh call or a different kind |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
