# #162 -- the Reply modal's membership check, the Reply button's refusals and a press under unknown membership are pinned by tests

Part of Epic #265. Effort S. Tests only: no shipped behaviour, no version bump, no CHANGELOG
bullet. Single-auditor lane (one read-only auditor), not the three-reviewer gate. Closes #162.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

`onReplyModal` (`plugins/tracker/src/interactions.ts`) checks membership before `enter()` lets a
reply be stored: `const membership = await membershipOf(interaction)`. Changing that line to a
constant `"member"` or `"not-checked"` leaves the suite green. Every modal submit in
`surface.test.ts` runs without `TRACKER_GUILD_ID`, and the membership-enabled button tests press
only Accept and Decline. So a person who left the server could submit a Reply and no test would
notice, although README line 63 and the CHANGELOG promise the check. Also unexercised: the Reply
button's `decideAccess` refusal (a stranger, an admitted person who never registered), and a button
press while membership is `unknown`.

### Decisions

- **Tests only, in `plugins/tracker/src/surface.test.ts`**, beside "the Reply button resumes and
  writes nothing before its modal comes back" and "declining and opting out work for someone no
  longer in the server". Reuse the file's `world`/`members` helper and `pressButton` /
  `submitModal`. Its membership fake answers only `member` / `not-member`; extend it so a test can
  make one Discord id `unknown` (e.g. a second set, or a map of id -> `Membership`). Keep the change
  local to the file.
- **What "nothing stored" means** is read from the store, not from the reply text: the occurrence
  has no reply after the refused submit (use whatever `/task history` or the store API the existing
  Reply tests use to see a stored reply).
- If any test shows the code does NOT behave as the issue says (for example the modal accepts a
  non-member), stop and record it: that is a bug for a separate fix, not something to pin.

### Steps

1. `plugins/tracker/src/surface.test.ts`, a new `describe("the Reply path's gates (#162)")`:
   - "a recipient who left the server is refused at the Reply modal, and nothing is stored": share a
     task, accept, fire a run, then remove the recipient from `members` and submit the modal ->
     the answer is the not-a-member refusal, and no reply is stored on the occurrence.
   - "the Reply button refuses someone it does not know, and shows no modal": a press from
     `STRANGER` -> the refusal (`NOT_ADMITTED`), `showModal` not called.
   - "the Reply button refuses someone admitted but not registered, and shows no modal".
   - "a button pressed while membership cannot be checked is refused, and changes nothing": make
     the presser's membership `unknown`, press Done on a fired reminder -> the
     unknown-membership refusal text (the constant `access.ts` uses), the run is still unanswered.
   - "a modal submitted while membership cannot be checked is refused, and nothing is stored".
2. This file, committed as `docs/plans/162-reply-modal-membership-is-pinned.md`.
3. Checks: `bun run lint`, `bun run check`, `bun test plugins/tracker`, `bun test`. Paste the counts.
4. Mutations from the table, each in a scratch worktree, never in the tree under test; every row red
   with the tree restored green. A survivor means a missing assertion: add it.
5. Audit: one read-only auditor handed the committed tree and the issue, asked to re-derive the
   mutation table against `interactions.ts` and `access.ts` and check every test name's claim.
   Every finding fixed or declined in writing; at most two rounds.

### Coverage

| Outcome | Test | Mutation that must fail it |
|---|---|---|
| The modal checks membership | "a recipient who left the server is refused at the Reply modal ..." | `onReplyModal`: `membership = "member"`; and `= "not-checked"` |
| The modal refuses unknown membership | "a modal submitted while membership cannot be checked ..." | `onReplyModal`: `membership = "member"` |
| The Reply button refuses a stranger | "the Reply button refuses someone it does not know ..." | drop the `decideAccess(...)` term in `onReplyButton` |
| The Reply button refuses the unregistered | "the Reply button refuses someone admitted but not registered ..." | `registered = true` in `onReplyButton` |
| A press under unknown membership changes nothing | "a button pressed while membership cannot be checked ..." | `onButton`: `membership = "member"` for gated refs |

## Deviations as implemented

Recorded by the implementer; the plan above is left as handed down. The mutation table is in the PR.

1. **The stranger row's mutation is equivalent for a stranger.** In `onReplyButton` the refusal is
   `decideAccess(...) ?? (person ? await replyRefusal(...) : NOT_ADMITTED)`: with the `decideAccess`
   term dropped, a person nobody admitted still gets `NOT_ADMITTED` from the fallback, so no test of
   a stranger can fail it. Row 3 is run as written and is red on the unregistered test (an admitted
   person then reaches `replyRefusal`'s "That is not yours to reply to."). The stranger test gets its
   own row, 3b: drop the `decideAccess` term *and* the fallback's `NOT_ADMITTED` (`person ? ... :
   null`), the mutant that would show a stranger the modal. The fallback alone made `null` (row 3c,
   run for completeness) is an equivalent mutant and survives every test: `decideAccess` refuses a
   person nobody admitted before the fallback is reached, so the fallback only ever sees a person.
2. **The unregistered test is killed by its text, not by `modals`.** No path makes an unregistered
   person a task's owner or accepted recipient (registration is never undone, and `/task share`
   refuses an unregistered target), so under `registered = true` the button still shows no modal: it
   answers "That is not yours to reply to." in place of `NOT_REGISTERED`. The test asserts the whole
   answer (`replies`, `modals`, `edits`, `followUps`), so the text change is what goes red.
3. **"Nothing stored" and "changes nothing" each end with a positive control.** After the refusal,
   the same submit or press is repeated once the gate passes and is shown to be stored (`replied
   "..."` in `/task history`) or to be the run's first answer ("-- Marked done.", then `done; Larry
   done` in the history), so the absence asserted before it is one the probe could have seen.
4. **"The run is still unanswered" is read as the history unchanged.** A fired run's status in
   `/task history` reads `done` whether or not anyone answered it; an answer shows as `; Larry done`
   after it. The press test asserts the admin's whole `/task history` is identical before and after
   the refused press, and that it holds no `Larry done`.
5. **The two Reply-button tests run without the membership gate** (`world()`), and the tests other
   than the left-the-server one use Larry's own fired once-reminder (a `firedReminder` helper in the
   new `describe`); the left-the-server test shares a task, as the plan says. `world` gains an
   `unknown` set (the plan's "a second set"): an id in it gets `"unknown"` from the lookup while the
   gate is on.

### Audit round 1

Verdict SOUND (no Major). Each finding and what was done about it:

1. **The unknown-membership press pinned Done only**, so adding snooze (C3) or decision (C8) to
   `reducesContact` (press.ts) survived. The test now also presses Snooze and a renewal ask's
   "renewed" (t2: a `/renewal` inside its lead asks on the next tick) while Larry is `unknown`: each
   answers `MEMBERSHIP_UNKNOWN` and changes neither task's history; once Larry is checked, "renewed"
   is recorded and shows as `Larry chose renewed`. The file's `slash` gains a `numbers` option
   (`getNumber`) for `/renewal`'s amount.
2. **The submit's own reply check was unpinned**: `submitReplyLocked` skipping `replyRefusal` (C7)
   survived. New test "a recipient who opted out after opening the Reply modal is refused at its
   submit, and nothing is stored": Curly opens the modal, opts out, submits -> "That is not yours to
   reply to." and no reply in the history; the owner's submit to the same run is then stored. It
   shares a task, so deviation 5's "the tests other than the left-the-server one" no longer holds:
   both sharing tests use a `sharedAndFired` helper.
3. **`need: "admitted"` in place of `"registered"` on the modal (R5) or the press (P6) path**
   survived. The unregistered test now also asserts the modal submit answers `NOT_REGISTERED` and a
   gated press (Done) gets `followUps: [NOT_REGISTERED]`; its name says so.
4. **Declined: pinning the refusal texts' literal values in `access.test.ts`.** The auditor's
   reason: out of scope for #162.
5. **Declined: the registration-before-membership order mutant** (`decideAccess` checking
   registration ahead of membership). The auditor's reason: it cannot happen on these paths.
