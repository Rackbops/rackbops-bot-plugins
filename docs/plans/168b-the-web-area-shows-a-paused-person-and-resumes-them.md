# #168, part 2 -- the web area tells a paused person their DMs are paused, and resumes them on a button

Part of Epic #265. Effort S. Behaviour change (a new web page element and a new POST route): the
three-reviewer gate applies. Closes #168 together with part 1 (PR #279), on the owner's decision
of 2026-10-11: "a web banner with a Resume button; Task API calls resume no one".

**Stacked on part 1.** This branch, `ccr-de9d9c44-hgkav1-168b`, starts from
`ccr-de9d9c44-hgkav1-168` (PR #279, at `79cd279`), and its PR's base is that branch. Once #279
merges, the base becomes `main`.

## Plan (execute as written)

Written 2026-10-11 against `ccr-de9d9c44-hgkav1-168` at `79cd279`; re-find each cite by name.

### What is wrong

A person whose delivery is paused (`DeliveryHealth`, three DMs in a row the host could not deliver)
is resumed only by a Discord command or button (`actions.ts` `enter` calls `d.health.resume`) or by
an admin (`/admin/people/<id>`, "Resume delivery"). Someone who uses only the web area or the Task
API never learns they are paused, and cannot resume. Part 1 made their tasks pause and their DMs
wait for the resume, so without a way to resume on the web they wait for good.

### Decisions

- **A banner on every signed-in page while the viewer is paused.**
  - `framed` (`web/pages.ts`) shows it above the page's body when `d.health.isPaused(viewer.id)`.
    Read it once per request, where the `Viewer` is built in `app.ts`; add a field to `Viewer`
    (e.g. `deliveryPaused: boolean`) rather than read the database inside `framed`.
  - Text, in the web area's voice, true of the code: "DMs to you are paused: the bot could not DM
    you 3 times in a row (`PAUSE_AFTER`), so the tasks that DM you are paused too, and what they owe
    you waits. Check that you accept DMs from members of a server you share with the bot, then
    resume."
  - Then a POST form with the CSRF token and one button, "Resume DMs".
  - Use the theme's existing banner or notice style if one exists; otherwise a `rb-card` with the
    accent button, as the admin page's "Resume delivery" uses.
- **`POST /resume-dms` resumes the signed-in person.**
  - It is a new route kind in `web/routes.ts`. It is CSRF-checked like every POST (`app.ts`) and
    runs inside the one serial queue (`w.queue`), as every web write does.
  - It calls `d.health.resume(viewer.id, d.clock.now())` and redirects (303) to `/?done=resumed-dms`,
    where the home page shows `resumedNotice`'s count of tasks back on, in the web area's done-notice
    style (see how `?done=paused` is shown).
  - When the person is not paused (a second press, or another tab), it redirects to `/` with no
    notice and changes nothing. It is not an error.
- **Nothing else resumes.** Signing in, viewing a page, a web edit and every Task API call stay as
  they are. The README already says making a task on the web resumes no one; keep that true.
- **An admin viewing their own pages sees their own banner only.** Another person's pause shows as
  before on `/admin/people/<id>`.
- **README:**
  - The pause paragraph (**Pause after failed DMs**) lists the ways to resume: a Discord command or
    button, the web area's "Resume DMs", or an admin.
  - The web area's pages table gets a row for `POST /resume-dms`, or a sentence under `/`.
  - Every sentence true of the code.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `web/pages.ts` (`Viewer`, `framed`), `web/app.ts` (building the `Viewer`; the POST dispatch),
   `web/routes.ts` (the route), and the home page's done notice.
2. README as decided.
3. Tests (`web/web.test.ts` or the nearest web test using `web/harness.ts`):
   - **"a paused person sees the banner on every page, with a Resume DMs form"**:
     - Pause Larry with three `recordFailure`s.
     - Sign in. `/`, a task page and `/settings` each hold the banner text and a form posting to
       `/resume-dms` with the session's CSRF token.
     - A person who is not paused sees no banner.
   - **"Resume DMs resumes the person and their tasks, and says how many are back on"**:
     - Larry owns one task and receives another, both paused for him.
     - The POST answers 303 to `/?done=resumed-dms`.
     - `isPaused` is false.
     - Both tasks are active with a `resumed` event.
     - The home page shows the count.
     - A held DM then goes out on the next notify tick: reuse part 1's web-made task test, now ending
       with the web button instead of `/tasks`.
   - **"Resume DMs without the CSRF token is refused and resumes no one"** (403, still paused).
   - **"pressing Resume DMs when not paused changes nothing"**.
   - **"viewing pages, a web edit and a Task API call resume no one"**: a paused person loads `/`,
     saves an edit and makes a task through the API, and stays paused.
   - **"an admin's own banner is theirs alone"**: an admin who is not paused, viewing a paused
     person's admin page, sees no banner. The person's page still offers "Resume delivery".
4. This file, committed as `docs/plans/168b-the-web-area-shows-a-paused-person-and-resumes-them.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
6. Mutations from the table, each in a scratch worktree (foreground, removed after), never in the
   tree under test. Keep mutation scripts in a private subdirectory.
7. Review gate: you plus two read-only reviewers. The gate passes at 2 of 3. Every evidenced finding
   is fixed or declined in writing, in four rounds at most.
   - **A, correctness and failure modes:**
     - CSRF and method checks on the new route;
     - the queue (no write outside it);
     - a resume racing a notify tick's held send (part 1's lock order: the queue turn, then the health
       lock);
     - a usr-revoked or not-member session;
     - a forgotten person;
     - double presses;
     - the banner's cost per request.
   - **B, claims against the code:** banner text, README, comments, the bullet, every coverage row,
     mutation survivors.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A paused person sees the banner | 1 | "a paused person sees the banner ..." | never set the `Viewer` field |
| Only a paused person sees it | 1 | the same (the unpaused half) | always show the banner |
| The button resumes them and their tasks | 1 | "Resume DMs resumes the person ..." | the route does not call `resume` |
| Their held DM goes out after | 1 | the same (last half) | -- (end-to-end) |
| The count of tasks back on is shown | 1 | the same | drop the done notice |
| CSRF is required | 1 | "... without the CSRF token is refused ..." | skip the CSRF check for the route |
| A second press is harmless | 1 | "pressing Resume DMs when not paused ..." | treat not-paused as an error page |
| Nothing else resumes | -- | "viewing pages, a web edit and a Task API call resume no one" | call `resume` while building the `Viewer` |
| The banner is the viewer's own | 1 | "an admin's own banner is theirs alone" | read the pause of the page's subject |

## CHANGELOG bullet (for the PR body)

The web area now tells a person whose DMs are paused, on every page, and resumes them, with the
tasks that DM them, from its "Resume DMs" button. Before, only a Discord command or button, an
admin, or resuming a paused task of their own could, and on the web only a paused task's history
(and, for an admin, the admin view) said why. Viewing pages, editing on the web and the task API's
other calls still resume no one (#168).

## Deviations as implemented

1. **The count needs a carrier the address cannot be.** Finding: the done notices are a fixed list
   keyed by `?done=` (editor-pages.ts `NOTICES`), and nothing from the address is echoed (editor
   test "the page names only fixed notices"), so `/?done=resumed-dms` alone cannot say how many
   tasks came back on. What I did: `resumeDmsPost` keeps the count per tracker user id in the web
   handler's memory (`resumedBack`, beside its other per-person maps), and My tasks at
   `?done=resumed-dms` shows it once, as "DMs resumed. 2 task(s) are back on." (`backOn`, split out
   of `resumedNotice` so both say it in the same words); a reload, or a restart in between, shows
   "DMs resumed." alone. Why: it keeps the planned 303 target exactly and the no-echo rule; a count
   in the query would let a crafted link show a false one.
2. **The tests sign in before the pause, not after.** Finding: the harness signs in through `/web`,
   which is a command, and every command resumes (actions.ts `enter`); so does the Accept press of a
   shared task. What I did: each test signs in (and accepts) first, then pauses Larry with three
   DMs the host refuses through the notify tick, which call `recordFailure`. In "Resume DMs resumes
   the person ...", the three failures are three days of Curly's shared daily reminder, not three
   one-off reminders of Larry's: those would pause too and be counted, making the "both paused for
   him" count 5. Why: the plan's order would resume Larry at sign-in, before any page is loaded.
3. **More ways resume than the plan's list, so the README and the bullet say so.** Finding: Resume
   on a paused task of the person's own -- `/task resume`, the web task page's Resume, and
   `POST /api/v1/tasks/<id>/resume` -- lifts their own delivery pause first (manage.ts
   `resumeLocked`). So the README list "a Discord command or button, Resume DMs, or an admin" and
   the bullet's "the task API still resume[s] no one" are not true of the code. What I did: no code
   change (the plan keeps every Task API call as it is); the README's pause paragraph also names
   resuming a paused task of one's own, and says viewing a web page, a web edit and every other
   task API call resume no one; the bullet above is amended to match. The plan's bullet read:
   "...Before, only a Discord command or an admin could, so someone who used only the web area or
   the task API stayed paused without knowing it. Viewing pages, editing on the web and the task
   API still resume no one (#168)." Why: every sentence true of the code. The owner's "Task API
   calls resume no one" may have meant this path too; that is theirs to decide, not changed here.

### Review gate round 1

On `303bdd1`: reviewer A (correctness and failure modes) SOUND with two cosmetic Minors; reviewer B
(claims against the code) SOUND with four wording Minors and one test gap. All fixed but item 11's.

4. **(A Minor 1) An admin who resumed their own delivery from their admin page still saw the
   banner.** `adminPost`'s act renders the person page with `a.v`, whose `deliveryPaused` was read
   before the act. Fix: the act's result page is rendered with the viewer's pause read again
   (`{ ...a.v, deliveryPaused: a.d.health.isPaused(a.v.user.id) }`, web/admin.ts), the smaller of
   the two fixes offered: it is the one POST that renders a page after it can lift the viewer's own
   pause (Resume DMs and a task's Resume both redirect on success, and fail before any resume).
   Test: "an admin who resumes their own delivery from their admin page sees no banner on the
   result".
5. **(A Minor 2) `/?done=resumed-dms` said "DMs resumed." to a viewer still paused** (an old tab, a
   crafted link). Fix: no notice for it while `v.deliveryPaused` (the banner says what is true), and
   the held count is dropped. Test: "Resume DMs resumes the person ..." loads that address while
   Larry is still paused: the banner, and no "DMs resumed.".
6. **(B Minor 1) The banner's "what they owe you waits" is not true of a finished task's DM**, which
   fails after about two hours (README, Pause after failed DMs). Fix: "... so the tasks that DM you
   are paused too, and their DMs wait. Only a DM for a task already finished, such as a research
   answer, does not wait: it fails if you are still paused about two hours on (a research answer's
   claims stay on its task page). ..." Checked: notifier.ts defers every send to a paused person,
   and only a paused task's owed rows are held by docket, so a `done` task's copy runs out its eight
   deferrals (part 1's deviation 5); a passed research answer's claims are stored as findings when
   its run's outcome is applied (docket's `apply`), before its DM, and shown on its task page
   (pages.ts `findingsSection`). The README's sentence on the finished-task exception says the
   claims stay too. The tests compare the escaped banner (`esc(DMS_PAUSED)`), since the text now
   carries an apostrophe.
7. **(B Minor 2) The CHANGELOG bullet's "Before ..." sentence**, replaced with the reviewer's
   wording, each clause checked: a command (discord.ts `run`) or a button (interactions.ts, all but
   Decline and opt-out) resumes through `enter`; an admin through `resumeDelivery`; a task's Resume
   through manage.ts `resumeLocked`. "On the web only a paused task's history said why" was true for
   everyone but an admin, whose admin view showed their own "paused since" (`/admin/people/<id>`)
   and failed DMs (`/admin/deliveries`): "(and, for an admin, the admin view)" is added.
8. **(B Minor 3) README: which buttons resume, and what else does not.** Fix: "by the next command
   or button they use (all but Decline and opt-out), which tells them why", and "Nothing else on the
   web or through the task API resumes them." -- true: on the web only Resume DMs, a task's Resume
   and an admin's Resume delivery call `DeliveryHealth.resume`, and in the task API only a task's
   resume does.
9. **(B Minor 4) `resume`'s docstring** now names every caller: "they used a command or button,
   pressed the web's Resume DMs, or resumed a paused task of their own (manage.ts `resumeLocked`), so
   they are here; or an admin resumed them".
10. **(B Minor 5) Two test gaps.**
    - H3, the count's key: "Resume DMs resumes the person ..." signs Curly in at the start and has
      him load `/?done=resumed-dms` before Larry: he sees "DMs resumed." with no count, and Larry
      then sees "DMs resumed. 2 task(s) are back on.". Red when `resumedBack` uses a constant key.
    - H10, a press that changes nothing writes nothing: "pressing Resume DMs when not paused changes
      nothing" puts a failure on Larry's `delivery_health` row before each press (one before the
      first, some after the resume before the second) and asserts the whole row is unchanged.
11. **Declined.**
    - H2 (a resume outside `w.queue` is untested): the same holds for every web write; `resume`
      takes the health lock itself, and reviewer A checked the order (the queue turn, then the
      health lock).
    - H9a, H11, H12, H14: declined for reviewer B's reasons, in that order: harmless; no effect;
      cosmetic; a pre-existing untested branch.
