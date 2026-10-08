# #190 -- the Spotify callback contains its own failures behind a plain page, and party notices mention only the member they are about

Epic #237 child, S. #190 groups three lows; its second (`music-auth-9`, dispose and the re-armed timer) is being fixed by #147's stopped flag and is NOT part of this plan. This plan is the first (`music-auth-6`) and the third (`music-auth-10`). Behaviour change (what a browser sees when the callback fails; what a channel notice may ping): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `8c2a07d`. Cites are to that tree; re-find by function name if the numbers have shifted.

### What is wrong

- `handleCallback` (`plugins/music/src/server.ts:86-134`) awaits `deps.redeemState` (`:106`), `deps.exchangeCode` (`:122`) and `deps.saveConnection` (`:128`) with nothing around them. The real `redeemState` and `saveConnection` (`index.ts:115-141`) both `commit` the store, and `commit` (`store.ts`) sets the in-memory state before it awaits the file write, so a failed write (disk full, a permission problem) rejects AFTER memory changed. The rejection escapes `handleCallback`, `Bun.serve` has no `error` handler and `development` is left at its default, so the browser gets Bun's own error response (in development mode a page with a source excerpt) instead of the "Returns an HTML page in every case" the JSDoc at `:81-85` promises. By then the `state` token is consumed and, on a `saveConnection` failure, Spotify's one-time code is spent: the person sees a failure with a dead link while the connection may exist in memory until the next restart.
- `notifyParty` (`plugins/music/src/notify.ts:33-43`) sends `channel.send({ content: message })` with discord.js's default mention parsing. The runner's drop-out notice (`runner.ts:224`) embeds `outcome.error`, which can be Spotify's response text verbatim (`runner.ts:200`, `error: played.error`); text containing `@everyone`, `@here` or a role mention would ping the channel if the bot may. `README.md:107` promises mention-safe delivery only for `host.announce`, and `notify.ts` documents the bypass but not this consequence.

Out of scope: making `commit` roll back or report a failed write (the memory-versus-disk divergence is a store design question, not this fix); the log line below records which stage failed, which is what an operator needs to know that memory and disk may differ until a restart.

### Decisions

- **`handleCallback` catches a throw from any of its three dependencies and answers a plain page.** One `try` around the part that calls the dependencies (from the state-token check at `:102` to the final `page(...)`), with `let stage = "redeeming the state"` updated to `"exchanging the code"` and `"saving the connection"` before each await. The catch logs `deps.log?.error(\`Spotify callback failed while ${stage}\`, err)` -- never the state token, the code, the query string or a refresh token -- and returns `page("Something went wrong", "The bot couldn't finish connecting your Spotify. Run /spotify connect again for a fresh link.", 500)`. `CallbackDeps` gains `log?: { error(message: string, err?: unknown): void }` (optional, so every existing `makeDeps` caller stands); `index.ts` passes `host.log`.
- **The server renders no debug page and has an `error` handler.** `startCallbackServer` passes `development: false` and `error(err) { deps.log?.error("Spotify callback server error", err); return page("Something went wrong", <the same text>, 500); }` to `Bun.serve`: the net under anything that still escapes (the 404 and 429 branches, `clientIpFrom`, a dependency that throws synchronously).
- **A notice mentions only the member it is about.** `notifyParty(party, message, mention?: string)` sends `allowedMentions: mention === undefined ? { parse: [] } : { parse: [], users: [mention] }`. `RunnerDeps.notify` gains the same optional third parameter; the drop-out notice (`runner.ts:224`) passes `outcome.discordUserId`, the last-track notice (`:121`) passes nothing. `index.ts` already wires `notify: notifyParty` (re-find the line); the signature change flows through.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/server.ts`: `CallbackDeps.log?`; the `try`/`stage`/catch in `handleCallback` as decided (the 404 and 429 answers stay outside it); `development: false` and `error()` in `startCallbackServer`. The JSDoc at `:81-85` says what the catch guarantees and what the log line deliberately omits.
2. `plugins/music/src/index.ts`: `log: host.log` in the `startCallbackServer` deps.
3. `plugins/music/src/notify.ts`: the `mention` parameter and `allowedMentions` as decided; the header comment gains the consequence (`README.md:107`'s promise now holds here too). `plugins/music/src/runner.ts`: `RunnerDeps.notify(party, message, mention?)`, the drop-out notice passing the member's id.
4. `plugins/music/src/server.test.ts`, in `describe("handleCallback")`, with `makeDeps({ log: { error: (m, e) => errors.push(`${m} | ${String(e)}`) } })` and the request `get("?code=SPENT-CODE-9&state=SECRET-STATE-7")`:
   - "a dependency that throws while redeeming the state is answered with a plain page and logged without the token": `redeemState: async () => { throw new Error("disk full"); }` -> status 500, the body contains "Something went wrong" and "/spotify connect" and not "disk full"; `errors` has one entry containing "redeeming the state" and "disk full", and no entry contains "SECRET-STATE-7" or "SPENT-CODE-9".
   - "a throw while exchanging the code names that stage": `exchangeCode` throws -> 500, the one log entry contains "exchanging the code".
   - "a throw while saving the connection names that stage": `saveConnection` throws -> 500, the one log entry contains "saving the connection"; the body contains "/spotify connect".
   - "a dependency that throws is contained even with no logger wired": `makeDeps({ saveConnection: throws })` (no `log`) -> status 500, no throw.
   In `describe("startCallbackServer")`:
   - "an error outside the handler's own catch becomes the plain page, not Bun's": a real server with `rateLimiter: { allow: () => { throw new Error("limiter exploded"); } }` and a recording `log` -> `fetch` answers 500, the body contains "Something went wrong" and neither "limiter exploded" nor "server.ts"; the log has one entry containing "callback server error".
5. `plugins/music/src/notify.test.ts` (new): a fake client `rememberClient({ channels: { fetch: async () => channel } } as unknown as Client)` where `channel = { isTextBased: () => true, send: async (opts: unknown) => { sent.push(opts); } }`, `resetClientForTest()` in `afterEach`, and a `party` fixture like `runner.test.ts`'s:
   - "a notice about one member may mention that member and nobody else": `notifyParty(party, "<@42> has dropped out of the party: @everyone look", "42")` -> `sent[0]` equals `{ content: <the message>, allowedMentions: { parse: [], users: ["42"] } }`.
   - "a plain notice mentions nobody": `notifyParty(party, "That was the last track. @here")` -> `allowedMentions` equals `{ parse: [] }`.
   - "no client means no send and no throw"; "a channel that is not text-based is skipped" (`isTextBased: () => false` -> `sent` empty); "a send that throws is swallowed" (`send` rejects -> resolves, no throw). These pin the existing contract the header promises.
6. `plugins/music/src/runner.test.ts`: `makeRunner`'s `notify` records `mention` beside the message (a `mentions: (string | undefined)[]` array returned with `notices`); in the existing drop-out test(s), assert the dropped member's id was passed as the mention, and in the last-track test assert `undefined`.
7. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: the Spotify connect callback now answers "Something went wrong" and logs which stage failed (never the token or the code) when the bot's own store or the token exchange throws, instead of leaving the browser on Bun's error response, and the callback server renders no debug page; a party notice in the channel mentions only the member it is about, so Spotify's own error text can no longer ping @everyone, @here or a role (#190).
8. This file, committed as `docs/plans/190-callback-containment-and-mention-safe-notices.md`.
9. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
10. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
11. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every await in `handleCallback` and what each dependency can throw, what the page and the log may and may not contain, Bun 1.4.2's `Bun.serve` `error` and `development` semantics, discord.js 14.27's `allowedMentions` shape (`parse: []` with `users`), every `deps.notify` call in `runner.ts`; B: claims-vs-code over this plan, the CHANGELOG, the JSDoc and the header comments, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
12. PR `fix(music): contain Spotify callback failures behind a plain page, and let party notices mention only their member (#190)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #190` and one line saying the dispose item of #190 landed with #147. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix, items 1 and 3) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A throwing dependency gets a plain 500 page, never Bun's | 1, 4 | the three stage tests; "contained even with no logger wired" | drop the try/catch -- the handler rejects |
| The log names the stage and never the token or the code | 1, 4 | the "redeeming the state" test's log assertions | log the query string, or drop the `stage` update -- the log assertions |
| The page sends the person back to `/spotify connect` | 1, 4 | the "saving the connection" test's body assertion | return the generic text without the command |
| The server's own error path is a plain page | 1, 4 | "an error outside the handler's own catch ..." | drop the `error` handler -- Bun's response, no "Something went wrong" |
| A drop-out notice can ping only its member | 3, 5, 6 | "may mention that member and nobody else"; the runner's mention assertion | send without `allowedMentions`, or pass no mention from the runner |
| Every other notice pings nobody | 3, 5, 6 | "a plain notice mentions nobody"; the last-track assertion | `parse` left at the default |
| The notice contract is unchanged otherwise | 5 | the three contract tests | (existing behaviour, pinned for the first time) |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
