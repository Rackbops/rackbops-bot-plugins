# #169 (with #211 notify-3) -- a delivered DM clears the failure count, pinned; and a failure to clear it never loses the delivery

Part of Epic #265. Effort S. Behaviour change (#211 notify-3: what a throwing `recordSuccess` does
to a delivered DM): the three-reviewer gate applies. Closes #169; part of #211 (its finding
`tracker-notify-3` only; notify-4 and notify-5 stay open there).

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

1. **#169.** `createDmNotifier`'s `sendDm` (`plugins/tracker/src/notifier.ts`) calls
   `d.health?.recordSuccess(userId)` after a DM goes through. That is what clears a person's run of
   refused DMs (README "A DM that goes through clears the count"). Deleting the call fails no test:
   the notifier tests either refuse every send or succeed without asserting the count, and
   `delivery-health.test.ts`'s `failingFriend` asserts `owner failures ?? 0`, which passes vacuously.
   Without the reset, three refused DMs weeks apart would pause a healthy person.
2. **#211 notify-3.** `recordSuccess` (a synchronous SQLite `UPDATE`) sits outside the `try`. If it
   throws (a busy database during a checkpoint, say), `sendDm` rejects with the raw error after the DM
   was delivered. docket then settles the delivery `unconfirmed`, the message id is lost, and nothing
   is logged. The comment above it promises a failed count never replaces the send's own result, but
   only `recordFailure` is wrapped.

### Decisions

- **Wrap `recordSuccess`** in try/catch; on a throw `d.log.error(\`could not clear the failure count
  of ${userId}\`, err)` and still return `{ messageId }`. Mirrors the `recordFailure` wrapping.
- **Pin the reset end to end** through the notify tick, not only on `DeliveryHealth`: a person with
  two refused DMs, then one delivered, then one refused has a count of 1 and their tasks stay active.
- **Make `failingFriend`'s owner assertion non-vacuous** (assert the row's count is 0 after the
  owner's delivered DM, with the row present, or assert `get(owner)` is undefined if that is the
  real shape; read it and choose the one that would fail without the reset).
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/notifier.ts`: the wrap; the comment above the send updated to say both counts
   are best-effort.
2. Tests:
   - in the notify-tick tests (`surface.test.ts`'s "pause after repeated failed DMs" describe, or the
     nearest test that drives real ticks with a refusing host): "a DM that goes through clears the
     count, so refusals weeks apart never pause": two refused runs, one delivered, one refused ->
     `health.get(u).failures === 1`, the task still `active`; a fourth and fifth refusal then pause.
   - notifier unit (beside `notifier.test.ts` or wherever `createDmNotifier` is tested): "a delivered
     DM whose count cannot be cleared still reports its message id": a health whose `recordSuccess`
     throws -> `sendDm` resolves with the host's `messageId`, and one error is logged.
   - `delivery-health.test.ts` `failingFriend`: the owner assertion made non-vacuous.
3. This file, committed as `docs/plans/169-a-delivered-dm-clears-the-count.md`.
4. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
5. Mutations from the table, each in a scratch worktree, never in the tree under test.
6. Review gate: you plus two read-only reviewers (A: correctness and failure modes -- what docket
   does with each `sendDm` outcome, the count's `paused_at IS NULL` guard, a throw from the log
   itself; B: claims-vs-code over comments, README and the bullet, every coverage row, mutation
   survivors). 2-of-3; every evidenced finding fixed or declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A delivered DM clears the count | -- | "a DM that goes through clears the count ..." | delete the `recordSuccess` call |
| A throwing clear keeps the delivery | 1 | "a delivered DM whose count cannot be cleared ..." | remove the try/catch |
| The failure to clear is logged | 1 | the same test | drop the log line |
| `failingFriend` checks the owner's count | -- | the fixed assertion | delete the `recordSuccess` call |

## CHANGELOG bullet (for the PR body)

A DM that was delivered is no longer reported as unconfirmed, without its message id, when the
tracker cannot clear that person's count of failed DMs afterwards; the problem is logged instead
(#211).

## Deviations as implemented

1. **`failingFriend` seeds one refused DM for the owner.** Read as it was, the owner never has a
   `delivery_health` row there (every one of their DMs goes through), so `get(owner)` is `null`
   with or without the reset, and neither of the plan's two assertions (count 0 with the row
   present, or no row) could tell a reset from no reset. `failingFriend` now records one
   "cannot be messaged" for the owner before the ticks (below `PAUSE_AFTER`, so nothing pauses),
   and the assertion is `toMatchObject({ failures: 0, pausedAt: null })`, which also fails when the
   row is missing. Nothing else in either `failingFriend` test reads the owner's count.
2. **The notify-tick test is in `delivery-health.test.ts`**, a new describe "the notify tick counting
   toward the pause" (the plan's "nearest test that drives real ticks" option, recorded here for the
   reviewers): `surface.test.ts` drives the plugin through `createPlugin`, which keeps its
   `DeliveryHealth` private, so `health.get(u).failures` cannot be read there. Its ticks are a week
   apart, each firing the one run owed. (Its name changed in review gate round 1, item 5.)
3. **The notifier unit test is in `delivery-health.test.ts`** too, beside its `recordFailure` twin in
   "the notifier counting toward the pause": there is no `notifier.test.ts`, and that describe is
   where `createDmNotifier`'s counting is tested. Its name adds ", and the failure is logged", and it
   pins the log line's text as well as the error.

### Review gate round 1

Reviewer A: sound, two Minors; reviewer B: not sound, one Major (wording) and Minors. Every fix is
wording or tests; no code changed.

4. **The CHANGELOG bullet above is reworded** (B, Major): it said "with its message lost", but the
   DM arrived; only its message id was lost. It now says "without its message id".
5. **The tick test is renamed** (B) "a DM that goes through clears the count, so only refusals in a
   row pause, however far apart": the old "refusals weeks apart never pause" was untrue of its own
   end, where three refusals in a row a week apart do pause.
6. **Coverage row 1's test is the tick test**, "the notify tick counting toward the pause > a DM that
   goes through clears the count ...". The `DeliveryHealth` unit test with the same prefix ("... so
   only failures in a row pause") calls `recordSuccess` itself, so it stays green when the
   notifier's call is deleted.
7. **"What is wrong" 2 misquoted the old comment** (B). It read "A failure to count is logged, never
   in place of the send's own error" -- the send's error, not its result; the new comment covers
   both (Step 1).
8. **Added: a clear that lands after the pause leaves it alone** (A + B, hardening): a
   `DeliveryHealth` unit test, three `recordFailure`s (paused) then `recordSuccess`, keeps
   `{ failures: PAUSE_AFTER, pausedAt }` and the person paused -- a DM already out when the pause
   landed, the race A probed. It kills B's M16 (a reset that clears `paused_at`, or drops the
   `paused_at IS NULL` guard).
9. **Added: an unconfirmed send neither counts nor clears the count** (B, hardening): a notifier
   unit test beside the others, one failure seeded, then a host error that is neither a refusal nor a
   delivery; `sendDm` rejects with that error unchanged and the count stays 1. It kills B's M11
   (clearing the count on an unconfirmed send). No existing test ended a send unconfirmed with a
   count in hand.
10. **Declined (A): guarding a throwing `d.log.error`.** `PluginLog` is the host's `console.*` with a
    prefix (`contract.d.ts` ~257) and does not throw in practice; the existing `recordFailure` catch
    is the same.
11. **Declined as equivalent (B): M12 and M22.** M12 changes only a paused row's stored count, which
    nothing reads while the person is paused: the admin page shows "paused since" instead
    (`web/admin-pages.ts` `delivery`), a further failure cannot pause again, and a resume sets the
    count to 0. Item 8's test pins that count as well, so dropping the `paused_at IS NULL` guard
    now goes red there anyway. M22 changes the tick spacing, which the count does not depend on.
12. **Noted (A): the fix reaches every `sendDm` caller**, not only the notify tick: an invitation's
    DM (`press.ts` `sendShare`/`finishShare`) and the daily digest (`digest.ts` ~189) also no longer
    lose a delivered DM to a throwing clear.
