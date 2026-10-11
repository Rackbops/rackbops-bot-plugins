# #167 -- a recipient's delivery pause is shown only to them, the owner and admins

Part of Epic #265. Effort S. Behaviour change (what a recipient's task history shows): the
three-reviewer gate applies. Closes #167.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

**Decision of record (roshne, 2026-10-11, Epic #265 decision 2; comment on #167):** hide it. A
delivery-pause event that names a recipient is shown only to that person, the task's owner and
admins. It is filtered once, in the tracker's `loadHistory`, so Discord, the web and the API agree.
docket is unchanged.

### What is wrong

Anne owns t1, shared with accepted recipients Bob and Carol. Bob's DMs are closed. After three
failures, `DeliveryHealth.pauseAffected` (`plugins/tracker/src/delivery-health.ts`) writes a
`paused` task event with `recipientPauseDetail(bob)`: `delivery to {u3} paused: 3 DMs in a row
could not be delivered`. When Carol reads `/task history t1` (or the web history page, or the
API), docket's `visibleHistory` passes it: its `ABOUT_A_RECIPIENT` filter hides only the recipient
kinds, not `paused`. `changeView` (`history.ts`) then renders `{u3}` as Bob's display name. Carol
learns that Bob receives the task too, and that his DMs are closed or the bot is blocked. docket's
own rule (plan 5.10) says a recipient learns nothing about who else receives a task.

### Decisions

- **One filter in `loadHistory`** (`plugins/tracker/src/history.ts`), applied to `changes` after
  `visibleHistory`. A viewer who is neither the task's owner nor an admin does not see a `paused`
  event that is a recipient pause, unless it names them. Its three callers (`/task history` in
  `history.ts`, the web editor's history page `web/editor.ts`, the Task API `web/api-tasks.ts`) all
  go through it, so all three agree. Check that no other path renders task events to a recipient
  (grep for `changeView`, `listTaskEvents`, `visibleHistory`); if one does, route it through the same
  filter.
- **What counts as a recipient pause:** a `paused` event whose detail starts with `delivery to `.
  This is `recipientPauseDetail`'s prefix. It also matches rows written before 0.6.0, which carry a
  display name instead of `{uN}` (the comment above `recipientPauseDetail`). It "names the viewer"
  only when the detail holds `{<viewer id>}`. A pre-0.6.0 row names no id, so it is shown only to the
  owner and admins. Put the predicate next to `recipientPauseDetail` (one place that knows the
  format) and test it on both shapes.
- **`resumed` events are left as they are.** Their details (`delivery resumed`, `resumed by the
  owner`, ...) name nobody; check every `release(...)` call's detail string to confirm. If any
  names a person, filter it the same way and say so under "Deviations as implemented".
- **The owner-pause row (`PAUSE_DETAIL`) stays visible to recipients**: it says the owner's own DMs
  failed, which every recipient of the owner's task may already infer from the task being paused.
  The decision covers only a recipient's pause. Note it in the PR as a deliberate non-change.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/delivery-health.ts`: export a pure `isRecipientPause(e: { kind: string;
   detail: string }): boolean` and `pauseNames(detail: string, userId: string): boolean` (or one
   function `recipientPauseVisibleTo(event, viewer, task)`; pick the clearer shape), with JSDoc.
2. `plugins/tracker/src/history.ts` `loadHistory`: filter `changes` as decided. Owner: `task.ownerId
   === user.id`; admin: `user.admin`.
3. Tests:
   - unit, next to the existing delivery-health tests: the predicate on a `{u3}` detail, a
     pre-0.6.0 `delivery to Bob paused: ...` detail, `PAUSE_DETAIL`, and a `resumed` event.
   - `surface.test.ts` (or the file with the existing recipient-pause scenario,
     "a recipient who cannot be DMed pauses the task ..."): Anne shares t1 with Bob and Carol, both
     accept, Bob's DMs fail until the pause -> Carol's `/task history t1` has no line naming Bob and no
     `delivery to` line; Bob's own history shows his pause; Anne's shows it with Bob's name; an
     admin's shows it.
   - the same through the web editor's history page and the Task API's history (one assertion each,
     in their existing test files, `web/editor.test.ts` and the API test that reads a task's history):
     Carol's view has no `delivery to` row.
4. This file, committed as `docs/plans/167-recipient-pause-is-private.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
6. Mutations from the table, each in a scratch worktree, never in the tree under test; name the red
   test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure
   modes -- every path a task event reaches a recipient (Discord, web page, API JSON, any export or
   admin view a recipient can open), legacy rows, a viewer who is both a recipient and an admin, a
   recipient who was removed or opted out, forget-me's erasure of `{uN}` rows (`roster.ts`) still
   finding them; B: claims-vs-code over this plan, the comments, the README's history rows and the
   CHANGELOG bullet, walking every coverage row and deriving mutation survivors). 2-of-3 on the major
   points; every evidenced finding fixed or declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| Another recipient does not see a recipient's pause | 2 | the surface scenario, Carol's view | drop the filter |
| The paused person sees their own pause | 2 | Bob's view | filter every recipient pause from non-owners |
| The owner and admins see it, with the name | 2 | Anne's and the admin's views | apply the filter to the owner too; to admins too |
| A pre-0.6.0 row is hidden from recipients | 1 | the predicate's legacy case | match on `{u` instead of the `delivery to ` prefix |
| Web and API agree with Discord | 2 | the web and API assertions | filter in the Discord formatter instead of `loadHistory` |
| The owner's own pause stays visible | 1 | the predicate's `PAUSE_DETAIL` case | treat every `paused` event as a recipient pause |

## CHANGELOG bullet (for the PR body)

A recipient's task history, in `/task history` and on the web, no longer shows that another
recipient's DMs failed and their delivery was paused, nor who that recipient is: such a row is now
shown only to that person, the task's owner and admins. The task API, which serves only the caller's
own tasks, never showed one to another recipient (#167).

## Deviations as implemented

1. **The Task API cannot show a recipient anything, so its assertion is the owner's view.**
   `getAnswer` (`web/api-tasks.ts`) goes through `ownTask` before `loadHistory`: `GET
   /api/v1/tasks/<id>` serves only the caller's own tasks, and a recipient (or an admin's token) gets
   the unknown task's 404 (the existing test "anyone else's task -- one shared with them, and to an
   admin's token too -- is the unknown task's 404"). "Carol's view has no `delivery to` row" would be
   vacuous there. The API test (`web/api.test.ts`, "a recipient's delivery pause (#167) ...") asserts
   instead that the owner's API history ends with the pause naming Bob by name, and that Carol's GET
   is still the 404 without the row. Consequence for the coverage table: the "Web and API agree"
   row's mutation (filter in the Discord formatter) can turn only the web assertion red; the API's
   owner assertion is what "apply the filter to the owner too" turns red there.
2. **The CHANGELOG bullet above is reworded** (deviation 1 made "through the task API alike" read as
   if the API used to leak it, which it never did to a recipient). It now names `/task history` and
   the web, and says the API never showed it to another recipient.
3. **README** (`plugins/tracker/README.md`, "Pause after failed DMs"): one clause added -- "one for a
   recipient is shown only to that recipient, the task's owner and admins". Not in the steps; the
   paragraph said each task's history gets a `paused` event, which read as every viewer seeing it.
4. **Shape picked (no deviation):** two pure exports, `isRecipientPause(e)` and
   `pauseNames(detail, userId)`, next to `recipientPauseDetail`; the owner/admin test is in
   `loadHistory` (`user.admin || task.ownerId === user.id`). The filter runs on the whole list from
   `visibleHistory`, before the `HISTORY_CHANGES` slice, the `earlierChanges` count and the name
   lookups, so neither "(N earlier)" nor a name lookup betrays a hidden row.
5. **Every path that renders task events (no deviation; all three already go through
   `loadHistory`):** `/task history` -- `discord.ts` -> `series.ts` `historyWithSeries` ->
   `history.ts` `taskHistory` -> `loadHistory`; the web task page `GET /tasks/<id>` -- `web/app.ts`
   -> `web/editor.ts` `taskPage` (also re-rendered on an act's refusal) -> `loadHistory` ->
   `web/pages.ts` `historyPage`; the Task API `GET /api/v1/tasks/<id>` -- `web/api-tasks.ts`
   `getAnswer` -> `ownTask` -> `loadHistory`. `changeView` and `formatChange` have no caller outside
   `history.ts`. The other readers of `task_events` render nothing: `store.ts` `listTaskEvents`
   (called, outside tests, only by docket-core's `visibleHistory`, its one reader in docket-core), and `roster.ts`
   (forget-me's `erase` and `othersNamed`). The digest, `/tasks`, and the admin pages read no task
   events.
6. **Every `resumed` detail checked (no deviation; none names a person, so `resumed` rows stay
   visible):** `DeliveryHealth.release` is called with `"delivery resumed"` (`resume`),
   `"resumed by the owner"` (`resumeTask`) and `"resumed: a recipient left the tracker"`
   (`admin.ts`, forget-me's freed tasks); `manage.ts` writes `"resumed by the owner"` itself (and
   `"paused by the owner"`, which `isRecipientPause` rejects). `changeView` never renders an event's
   `actorId`, so the paused person's id on a `"delivery resumed"` row is not shown either. The unit
   test feeds all three `resumed` details to `isRecipientPause`.
7. **Test cast (no deviation):** in `surface.test.ts` Larry is Anne (owner), Curly (`user333`) is
   Bob, a new `MOE` is Carol, `ADMIN` the admin; the web and API tests use Larry, Curly and
   `STRANGER` (admitted and registered in the test) the same way. Bob's own `/task history` is read
   last, because any command of a paused person resumes their delivery and the task.
