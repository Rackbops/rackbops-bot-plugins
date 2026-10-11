# #166 -- `/task history` of a want-list watch shows a run's worth of findings, so "lists them all" is true

Part of Epic #265. Effort S. Behaviour change (what `/task history` shows for a want-list watch):
the three-reviewer gate applies. Closes #166.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

**Decision of record (roshne, 2026-10-11, Epic #265 decision 4; comment on #166):** show a run's
worth. For want-list watches (judged or not), `/task history` shows up to 20 findings (one run's
maximum), whole lines within one message, and points to `/web` (when the web area is set up) for any
it cannot fit. docket's DM text is unchanged; its "lists them all" becomes true.

### What is wrong

A want-list run can find up to `MAX_NEW_PER_RUN` (20, docket-types) new listings. Its DM shows 5 and
says "...and 15 more: `/task history tN` lists them all". But `findingLines`
(`plugins/tracker/src/series.ts`) lists only the newest `SERIES_SHOWN` (8) findings. So up to 12
listings of that run appear on no Discord surface. The same holds for a judged watch's `no` verdicts.

### Decisions

- **For `wantlist` and `wantjudge` only**, `findingLines` takes the newest `MAX_NEW_PER_RUN` findings
  (import the constant from `@rackbops/docket-types`; do not copy the number). Research and scout
  keep `SERIES_SHOWN`.
- **Whole lines within one message.** `historyWithSeries` currently gives the series block its full
  length and clips the rest of the history to what is left, and `clip` can cut a line. For a want
  watch, fit the finding lines by whole lines into the room the answer allows: the header lines, the
  `Findings: N` line and at least the first line of the history's rest must still fit. Keep the newest
  findings that fit, then one note line: `...and M more: the web area lists them all (\`/web\`).` with
  the web area (`d.webEditor`), or `...and M more not shown here.` without it. The note's own length
  is counted. The history's rest then gets the room that is left, as today.
- **Order** stays oldest-to-newest within what is shown, as today.
- **README:** the `/want` row says "up to 5 lines with the rest in `/task history`". Make it true:
  "the rest in `/task history` (up to 20, as many as fit in one message; the web area lists every
  finding)". Check the web area's task page does list every finding before writing that, and say so
  only if true.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/series.ts`: the want-watch branch in `findingLines` and the fitting in
   `historyWithSeries` (or in `findingLines`, if it is handed the room; pick the clearer shape). Widen
   the `Pick<TrackerDeps, ...>` to include `webEditor` where needed.
2. README's `/want` row.
3. Tests (next to the existing want and series tests, e.g. `want.test.ts` or a `series.test.ts`):
   - "a want watch's history lists a whole run of 20 short findings": 20 findings with short text ->
     all 20 shown, no note.
   - "a want watch's history keeps whole lines and counts the rest": 20 findings with long texts and
     sources -> the shown lines are whole findings (no `...` inside a line), the newest ones, the note
     counts the rest exactly, the answer is at most `MAX_ANSWER`.
   - "the note points to /web only when the web area is set up": both values.
   - "research and scout still show the newest 8": unchanged behaviour pinned.
   - End to end through `/task history` on a want watch whose run found 20 listings (the existing want
     test harness): the reply holds the newest findings and, if they do not all fit, the note.
4. This file, committed as `docs/plans/166-want-history-shows-a-runs-worth.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
6. Mutations from the table, each in a scratch worktree, never in the tree under test; name the red
   test per row in the PR.
7. Review gate: you plus two read-only reviewers (A: correctness and failure modes -- the fitting's
   arithmetic at and around the limit, a single finding longer than the room, a history whose
   header is long, the interaction with #161's `/tasks` fitting if it has merged, the web page's
   findings list; B: claims-vs-code over this plan, the README row, comments and the bullet, walking
   every coverage row and deriving mutation survivors). 2-of-3; every evidenced finding fixed or
   declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A run's worth (20) is shown for a want watch | 1 | "lists a whole run of 20 short findings" | keep `SERIES_SHOWN` for want watches |
| Whole lines, newest first kept, the rest counted | 1 | "keeps whole lines and counts the rest" | clip the block instead of fitting lines; off-by-one in the count |
| `/web` named only with the web area | 1 | "the note points to /web only ..." | always name `/web` |
| Research and scout unchanged | 1 | "research and scout still show the newest 8" | apply 20 to every type |
| End to end | 1 | the `/task history` test | revert `findingLines` |

## CHANGELOG bullet (for the PR body)

`/task history` of a want-list watch now lists up to 20 findings, a whole run's worth, instead of the
newest 8, keeping whole lines within one message and saying how many more there are (and that the web
area lists them all, when it is set up), so the DM's "`/task history` lists them all" holds (#166).

## Deviations as implemented

1. **README: "the web area lists every finding" is not true, so it is not written.** The task's page
   (`plugins/tracker/src/web/pages.ts`, `findingsSection`) lists the newest `FINDINGS_SHOWN` (50,
   `history.ts`) and says "N earlier finding(s) not shown"; only the task API's `GET /tasks/<id>`
   returns every finding. The `/want` row says instead "(up to 20, as many as fit in one message; the
   task's page in the web area lists any that do not fit)", which holds: the ones left out are among
   the newest 20, and the page lists the newest 50.
2. **The note's M counts the run's worth left out, not every finding not listed.** M is the number of
   the newest `MAX_NEW_PER_RUN` that did not fit; findings older than those are counted only by the
   `Findings: N` line, as a research request's or a scout's beyond their newest 8 are. Counting every
   finding would make "the web area lists them all" untrue past 50 (deviation 1). So a watch with more
   than 20 findings whose newest 20 all fit shows no note.
3. **The "lists a whole run of 20 short findings" test stores 25**, so it also pins that the run's
   worth is the newest 20 (not every finding) and that the 5 older ones add no note; all 20 newest
   are shown. It and the "keeps whole lines" test run for both `wantlist` and `wantjudge`.
4. **One test more than the plan lists: "fits whole lines at and around the limit".** The "keeps
   whole lines" data (239-character lines) never lands near the room's edge, so two faults survived
   it: fitting without keeping the history's first line whole (the room taken to the cap), and
   stopping at the first count that does not fit (the note on one left out is longer than a short
   oldest line, so all 20 can fit where 19 and the note do not). The added test sweeps the lines'
   length across the edge for both, and the shared check asserts every larger count would not fit.

### Revision 2, as implemented

Rebased onto `ccr-de9d9c44-hgkav1-161` at `a6914ef` with no conflict (the two branches change
different README rows). What differs from revision 2, or what it left open:

1. **The shape is confined to the plain path.** `Parts` (`{ content, more }`, actions.ts) is one more
   kind of `Step`; an `outside`/`finish` Step still finishes with a string. `/task history` is the
   only command that returns it.
2. **The follow-ups mention no one** (`NO_MENTIONS`, as the answer's edit), the resume notice's too:
   the findings were sent under it inside the answer before, and a listing's name is a shop's text.
   The notice is fixed text, so for it nothing changes.
3. **The README's resume-notice sentence (from #161) changes too.** It said the notice comes "in a
   second message"; for a want watch's `/task history` it comes after the findings, so a third. It
   now says "in a message of its own after it".
4. **A finding whose line alone passes a message** (a source URL of about 1,800 characters or more,
   since only the text is clipped to 200) makes K 0 when it is the newest: the second message is
   `Findings (newest 0 of N):` and the note. A line is never cut, and an older one is not listed in
   its place (K counts the newest). Pinned by a test.
5. **`historyWithSeries` reads the task and its findings once more for a want watch** (`wantFindings`
   is its own read, after `seriesLines`), so `seriesLines` keeps `main`'s shape; both reads run in
   the same queue turn.
6. **The web harness's `slash` (`web/harness.ts`) gained `said`, `followUpFails` and a `followUp`**,
   as #161 gave `surface.test.ts`'s, so the end-to-end tests are in `want.test.ts`, where a watch
   can read a shop. Before, a follow-up there would have thrown a `TypeError` (caught and logged).
   The first `/want` test now reads its Nesting Box line from the follow-up.
7. **A failed follow-up of `more` is logged** as `could not send /task's answer's message 2 as a
   follow-up: <error>`; the notice's wording is unchanged.
8. **Tests beyond revision 2's list:** the first implementation's sweep "at and around the limit",
   moved to the second message (its second case now lengthens the newest line from 0 to 99
   characters past 60-character middle lines, so all 20 fit where the newest 19 and the note do
   not); "a want watch with no findings yet answers in one message"; and the case in 4.
9. **Not pinned by a test: `more` before the resume notice's follow-up.** The notice is a follow-up
   only when it and the answer pass 2,000 characters together, and a want watch's first message
   (header, count, at most 10 runs and 5 changes) stays far below that in the test harness; the
   order is the code's (`run`, discord.ts), and a mutation swapping it survives.

## Plan, revision 2 (execute as written; supersedes the one-message fitting above)

Written 2026-10-11 after the review gate on `da696ba`. **Owner decision (roshne, 2026-10-11,
comment on #166):** the findings go in a second message.

### Why the first plan was dropped

The gate measured real lines. A judged watch's finding line is about 230 to 270 characters, and a
plain page watch's about 110 to 180. So only about 6 to 12 of 20 fit in one message, and fitting
even those pushed the history's runs and changes out entirely. That is a regression: today those
show. The bullet's "so the DM's 'lists them all' holds" was false whenever the lines did not all
fit, which is the usual case.

### Decisions

- **Stacked on #161 (PR #274).** That PR's `run` (`discord.ts`) already sends an ephemeral
  follow-up after the answer, with a caught and logged failure. This branch is rebased onto
  `ccr-de9d9c44-hgkav1-161`, and its PR's base is that branch. Once #274 merges, the base becomes
  `main` and `main` is merged in.
- **`run` learns to send extra messages.** A command's result may be a string, as today, or
  `{ content: string; more: string[] }`. `run` edits the reply with `content`, combined with the
  resume notice by `withNotice` exactly as now. It then sends each `more` entry as an ephemeral
  follow-up, in order, before the resume-notice follow-up when there is one. Each follow-up is
  caught and logged like the notice's. Every other command's behaviour is unchanged. Keep the type
  change small: wherever a `Step`'s `finish` returns a string, it may return this shape too, or
  confine the shape to the plain-function path if that is all `/task history` needs.
- **A want watch's `/task history` (`wantlist`, `wantjudge`):**
  - **First message:** the history as `main` builds it today (header, `Findings: N`, then the runs
    and changes, clipped as today), but without the finding lines themselves. The `Findings: N`
    line stays in it.
  - **Second message, only when there is at least one finding:**
    - a header line, `Findings (newest K of N):`;
    - the newest K findings, oldest to newest, as whole lines in the existing per-finding format
      (`- <text clipped to 200> <<source>>`). K is the largest number, up to `MAX_NEW_PER_RUN` (20,
      imported from docket-types), whose lines fit with the header and the note in `MAX_ANSWER`;
    - when N > K, a last line: `...and <N-K> more` followed by `; the web area's task page shows the
      newest <FINDINGS_SHOWN> (\`/web\`).` when the web area is set up (`d.webEditor`), or just `.`
      without it. Import `FINDINGS_SHOWN` (50) from `history.ts`; do not copy the number.
  - Reuse the first implementation's fitting code where it fits this shape. Drop the room
    computation that squeezed the history's rest; it is no longer needed.
- **Research and scout are unchanged:** one message, the newest `SERIES_SHOWN` (8), as on `main`.
  Price and renewal are unchanged too.
- **The web area and the Task API are unchanged.**
- **README:** the `/want` row says the rest of the listings are in `/task history`'s second message,
  "up to 20, as many as fit in one message", plus the web pointer. The `/task history` row says a
  want watch's findings come as a second message. Every sentence must be true of the code.
- **CHANGELOG bullet:** rewritten as below. It does not claim the DM's "lists them all" now holds,
  because when the lines do not all fit, it does not.

### Steps

1. In W, rebase onto the #161 branch: `git rebase --onto ccr-de9d9c44-hgkav1-161 origin/main` (the
   local branch exists; it is the head of PR #274, currently at `a6914ef`). Resolve any conflict
   (README rows) keeping both sides' text. Confirm `git log --oneline ccr-de9d9c44-hgkav1-161..HEAD`
   is only #166's commit(s).
2. `discord.ts` `run` and its types: the `more` follow-ups as decided.
3. `series.ts`: a want watch's history builds the two parts. Return the `{ content, more }` shape
   only for want types with at least one finding. `historyWithSeries` keeps its string result for
   every other caller, so check who else calls it (the web and the API do not).
4. README rows, as decided.
5. Tests:
   - **`series.test.ts` (unit), replacing the one-message fitting tests:**
     - 20 short findings: all 20 shown, header `(newest 20 of 20)`, no note;
     - 20 long findings (about 240 characters): whole lines only, the newest kept, the note's count
       exact (N-K), the second message at most `MAX_ANSWER`;
     - 25 findings, all short: K is 20, the note says 5 more;
     - the note points to `/web` only with the web area, both values;
     - the first message keeps the runs and changes of a long want history. Compare its runs and
       changes section with the same history's on `main`'s code, or assert specific run lines are
       present;
     - research and scout still show the newest 8 in one message, including with long findings.
       This kills reviewer B's M36.
   - **`surface.test.ts` or `want.test.ts`, end to end through `/task history` on a want watch whose
     run found 20 listings:**
     - the reply is the history with `Findings: 20` and its runs;
     - one ephemeral follow-up (`flags: 64`) holds the findings;
     - the edit comes before the follow-up (use #161's ordered `said` log in `surface.test.ts`'s
       `slash`, or the equivalent);
     - a failing follow-up is logged, not thrown.
   - Keep the first implementation's tests that still apply; delete the ones that pin the dropped
     one-message fitting.
6. Commit as a new commit on top: `fix(tracker): send a want watch's findings in /task history as a
   second message, up to a run's worth (#166)`, with the two trailer lines. Do not squash or rewrite
   the earlier commit beyond the rebase.
7. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`.
8. Mutations in a scratch worktree, one at a time:
   - `more` not sent;
   - `more` sent before the edit;
   - `more` not ephemeral;
   - findings left in the first message too;
   - K not capped at 20;
   - the note's count off by one;
   - the `/web` pointer shown always;
   - research given the second message;
   - the follow-up's catch removed.

   Name the red test for each.
9. Record everything that differs from this revision under a new `### Revision 2, as implemented`
   at the end of "Deviations as implemented".

### CHANGELOG bullet, revision 2 (for the PR body)

`/task history` of a want-list watch now sends its findings as a second message: up to 20, a run's
worth, as many whole lines as fit, newest kept, and says how many more there are (pointing to the
web area's task page when it is set up). The history itself keeps its runs and changes, as before.
It used to list only the newest 8 findings, so a DM's "the rest in `/task history`" left most of a
20-listing run nowhere in Discord (#166).
