# #154 -- a refresh Spotify couldn't do right now is a blip in the party runner, not a fatal failure

Standalone S. Behaviour change (when the runner drops a member, and the drop-out line's punctuation): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `1770c51` (`plugins/music` at 1.6.0 + Unreleased, with #133's fix in). Cites are to that tree.

### What is wrong

`plugins/music/src/runner.ts:136-137` returns `{ ok: false, fatal: true }` for EVERY failed token refresh, so `noteOutcome` (`runner.ts:188-204`) removes the member on the first one. Since #233 (#133) `accessTokenFor` keeps the stored connection when Spotify is unreachable, slow, rate-limiting (429), erroring (5xx) or refusing the app's own credentials, and says which it was through `kind: "unavailable"` (`tokens.ts`), but the runner does not read `kind`: its own `TokenResult` (`runner.ts:37-39`) has no such field. So one Spotify blip at a track boundary still drops every member whose refresh hit it -- and when the host's refresh is the one that hits it, `removeMember` closes the whole party (`party.ts:85-87`). A failed PLAY call for the same kind of blip has always been non-fatal: `playFor` returns it without `fatal` (`runner.ts:185`) and the member is dropped only on the second consecutive failure (`MAX_MEMBER_FAILURES`, `runner.ts:35`, pinned by `runner.test.ts:254-267`). A failed refresh should get the same treatment.

Second, smaller: `runner.ts:202` appends a period to a drop-out reason that is already a full sentence (the token messages end in one), so the channel line reads "... to reconnect.." and "... again..".

### Decisions

- **A refresh that failed with `kind: "unavailable"` is a blip, not a fatal failure.** `playFor` returns it without `fatal`, so `noteOutcome` counts it toward `MAX_MEMBER_FAILURES` exactly like a failed play call: the member stays after one, is dropped after two in a row, and a success in between resets the count. This is the issue's Fix ("do not mark fatal for transient failures") applied with the policy the runner already has for blips; a separate "never drop for a refresh failure" rule would let a member whose Spotify is down for an hour sit in the party being retried at every boundary.
- **`revoked` and `not-connected` stay fatal.** A dead grant needs a reconnect and a disconnected member cannot be played; one more attempt fixes neither. Both drop at once with the token's own message, as today.
- **The runner reads the real `TokenResult`.** `runner.ts` re-exports `TokenResult` from `tokens.ts` instead of keeping a structurally weaker copy, so the contract the runner branches on is the one `index.ts:48-55` wires in. A type-only import; no runtime coupling to the store.
- **The drop-out line ends in exactly one period.** `noteOutcome` appends one only when the reason does not already end in one. Some reasons are fragments ("Spotify Premium is required to control playback", a bare HTTP status), others full sentences (the token lookup's three, the runner's own two scope messages at `runner.ts:146-148` and `:179`); the rule covers both.
- **A first strike is logged.** A failure that counts but does not drop the member was invisible once it came from a timer-driven boundary (nobody to reply to, no channel line), so `noteOutcome` logs a warning naming the member, the count and the reason. Added by the review gate (round 1, A); a disclosure, not a behaviour change for the party.
- **The sweep is unchanged.** `runner.ts:257-266` already skips a member whose refresh failed, with no state change; the resync it then runs through `playFor` (`:271-272`) gets the new classification for free.
- **The drop-out text on a second-strike transient failure is the token's message, passed through** ("Spotify couldn't refresh your connection right now (...). Your link is still saved -- try again in a moment, and if it keeps failing, run `/spotify connect` again."), which is still what the person should do. No runner-specific rewording.
- **No version bump.** CHANGELOG entry under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected; the next music bump PR releases it.

### Steps

1. `plugins/music/src/runner.ts`
   - Replace the local `TokenResult` with `import type { TokenResult } from "./tokens.js"; export type { TokenResult };` (`runner.test.ts:2` imports it from `./runner.js` and keeps working).
   - `playFor`, the token branch: build the outcome `{ discordUserId, ok: false, error: token.error }` and set `fatal = true` only when `token.kind !== "unavailable"`, with a comment saying why an unavailable refresh is a blip (#154).
   - `MemberOutcome.fatal` JSDoc: add a dead grant and a disconnect to the examples, and that a refresh Spotify could not do right now is not one.
   - `noteOutcome`: `const reason = outcome.error ?? "their Spotify stopped responding";` and append `.` only when `!reason.endsWith(".")`.
2. `plugins/music/src/runner.test.ts`: three token fixtures (`UNAVAILABLE`, `REVOKED`, `NOT_CONNECTED`, each with its `kind` and realistic text) beside the existing good one; a three-track queue for the reset case; new tests in `describe("a refresh Spotify couldn't do right now")`:
   - "costs a member their place only on the SECOND one, like any other blip": `start` (friend's refresh unavailable: friend stays, only the host is played, nothing is posted), then `skip` (unavailable again: friend is dropped, the line says they dropped out and carries the token's text).
   - "does not close the party when it is the host's refresh that hit it": host unavailable on `start`: the party still exists with both members; `skip` with the host good again plays both.
   - "is forgotten once the next boundary plays fine": friend fails, plays, fails across `start`, `skip`, `skip` on a three-track queue: still a member.
   - "a dead grant still drops the member at once, and the line ends in one period": friend `revoked` on `start`: members `["host"]`, one notice containing "no longer valid", ending in "reconnect." and not "..".
   - "a member who disconnected mid-party is dropped at once": friend `not-connected` on `start`: members `["host"]`, notice containing "/spotify connect".
   - The existing "a free account is dropped at once" test additionally asserts the line ends in "playback." (the fragment case gets its one period).
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: the party runner no longer drops a member on the first refresh Spotify couldn't do right now -- two in a row, as for a failed play call; a dead grant or a disconnect still drops at once; the drop-out line no longer doubles its period (#154).
4. This file, committed as `docs/plans/154-transient-refresh-is-a-blip-in-the-runner.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and the non-tracker suites; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.
7. Gate: me plus two read-only reviewers with different lenses (A: correctness and failure modes -- every path that reaches `playFor`, the host case, the failure counter, what the sweep and `syncMember` now do on each `kind`; B: claims-vs-code over this plan, the CHANGELOG and the JSDoc, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round.
8. PR `fix(music): treat a refresh Spotify couldn't do right now as a blip in the party runner, not a fatal failure (#154)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #154`. Standalone issue: merged after CI (squash, the repository-admin bypass the repo's instructions describe), then `main` fast-forwarded. No tag: the next music bump PR releases it.

### Coverage

| Outcome (the issue has no Acceptance section; these are its observable outcomes) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A refresh that failed `unavailable` at a track boundary does not drop the member; a second one in a row does | 1, 2 | "costs a member their place only on the SECOND one" | set `fatal` for every failed token (today's line) -- dropped on the first |
| The host's `unavailable` refresh no longer closes the party | 1, 2 | "does not close the party when it is the host's refresh" | the same line -- the party is closed on `start` |
| A success between two `unavailable` failures resets the count (the existing counter, now reachable from a refresh) | 2 | "is forgotten once the next boundary plays fine" | drop `failures.delete(key)` on success -- dropped on the third boundary |
| A dead grant (`revoked`) still drops the member at once | 1, 2 | "a dead grant still drops the member at once" | never set `fatal` for a failed token -- stays after one |
| A disconnected member (`not-connected`) still drops at once | 1, 2 | "a member who disconnected mid-party is dropped at once" | set `fatal` only for `revoked` -- stays after one |
| The drop-out line ends in exactly one period for a sentence reason | 1, 2 | the `revoked`, `not-connected`, second-strike `unavailable` and scope tests' ending assertions | always append the period (today's line) -- "reconnect.."; append unless the reason ends in "reconnect." -- "again..", "first..", "grant it.." |
| The drop-out line ends in exactly one period for a fragment reason, even one with a period inside it | 1, 2 | the Premium test's ending assertion; the transient-play test's "Try later." assertion | never append the period -- "playback"; decide on `includes(".")` -- "Try later" |
| A first strike is logged with the member, the count and the reason | 1, 2 | the transient-play test's `warnings` assertion; the second-strike `unavailable` test; the sweep test | delete the `deps.log.warn` call |
| Join with an `unavailable` refresh leaves the joiner in place with the token's text | 1, 2 | "on Join leaves the joiner in place" | set `fatal` for every failed token -- removed |
| The sweep's resync with an `unavailable` refresh counts one strike, not a drop | 1, 2 | "in the sweep's resync counts one strike" | set `fatal` for every failed token -- removed |
| The runner's `TokenResult` is the real one (failures carry `kind`) | 1 | `bun run check` (tsc), not the suite: bun strips types | revert to the weak local type -- tsc red, suite green |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.

### Gate round 1 (2026-10-08) -- what it added to the plan above

A (correctness, failure modes): SOUND. B (claims-vs-code, coverage walk): NOT SOUND as written, narrowly -- two false written claims, with "the code, the tests and all seven coverage rows are sound". Every evidenced finding is fixed or declined below. No fix changed what the party does; the one addition with a runtime effect is a log line, so no second round was run.

- **The #133 CHANGELOG bullet still said the runner drops a member on any failed refresh, "that half is #154"** (A F1 / B F1, Medium): false once this lands, and both bullets publish together as one release's notes. *Fixed*: the clause is gone.
- **"The runner's own reasons are fragments" was false** (B F2, Medium): the two scope messages (`runner.ts:146-148`, `:179`) are full sentences and also used to get a doubled period. *Fixed*: the comment and the fourth Decision say some reasons are fragments and some sentences; the scope test asserts its line ends "to grant it.".
- **The period check had survivors** (B F3, Low): `includes(".")` and `endsWith("reconnect.")` both kept the suite green. *Fixed*: ending assertions for the second-strike `unavailable`, `not-connected` and scope lines, and the transient-play fixture now carries a period inside the fragment ("Bad gateway. Try later").
- **A first-strike blip became invisible** (A F2, Low): before, it dropped the member and posted a line; now a timer-driven boundary left no trace. *Fixed*: `noteOutcome` logs a warning for a failure that counts without dropping (the fifth Decision), pinned by three tests.
- **"(pinned there)" overstated what `tokens.test.ts` pins** (B F4, Low): it pins substrings, not the full texts. *Fixed*: the fixtures' comment says they are copied.
- **The CHANGELOG understated the kept class and overstated "exactly as a failed play call"** (B F5, Low): `unavailable` is everything that is not a recognised dead grant, and only a transient play failure gets the two strikes. *Fixed* in the bullet.
- **The type-only lines survive `bun test`** (B F6, Low): bun strips types. *Recorded* as a tsc row above and run in the scratch worktree.
- **The `?? "their Spotify stopped responding"` fallback is unreachable** (B F7, Low): every failing outcome carries an `error`. *Left as is*; a type-level guarantee the fallback documents.
- **Failure counts survive stop and leave; the Join reply after a fatal drop; the sweep's stale party snapshot** (A F3 and two out-of-scope notes): pre-existing. *Filed* as #234.
- **The second-strike line's pass-through text never says "press Join"** (A F4, nit) and **a `played.error` ending in `?`, `!` or `)` would read oddly** (A F5, cosmetic): *declined*; the plan's sixth Decision keeps the token text, and no reachable reason ends in other punctuation (A's own list).
- **`syncMember` and the sweep's resync were not driven with an `unavailable` refresh** (B, observation): *Fixed*: one test each, both rows above.
