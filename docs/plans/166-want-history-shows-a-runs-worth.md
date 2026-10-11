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
