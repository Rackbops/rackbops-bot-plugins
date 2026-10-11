# #161 (with #205 discord-1) -- `/tasks` fits one message without losing the paused tasks, and a pressed button's status is never cut off

Part of Epic #265. Effort S. Behaviour change (what `/tasks` and a button press show): the
three-reviewer gate applies. Closes #161; part of #205 (its finding `tracker-discord-1` only;
discord-3 and discord-4 stay open there).

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

1. **#161.** `listTasks` (`plugins/tracker/src/actions.ts`) joins docket's `formatTaskList` (one line
   per active task, no limit) with one `Paused: ...` line per paused task and returns
   `clip(lines.join("\n"))`. `clip` cuts at 2000 characters mid-line with `...` and says nothing about
   what was cut. Someone with about 20-30 or more live tasks (the cap is `MAX_LIVE_TASKS`, 200) loses
   the later active tasks and always the whole Paused section. That section is last, so it goes first,
   and it holds the ids `/task resume`, `/task done` and `/task history` need. README line 49 promises
   the full list.
2. **#205 discord-1.** `onButton` (`plugins/tracker/src/interactions.ts`) edits the pressed message
   to `clip(`${interaction.message.content}\n\n-- ${status}`)`. A DM already near 2000 characters
   (docket clips want-list and judged DMs to 2000) loses the appended status: `clip` keeps the
   front. The press succeeds, the buttons are removed, and the person sees no confirmation.

### Decisions

- **`/tasks` keeps whole lines and reserves room for the paused ones.** Build the active lines one
  per entry (`formatTaskList([entry], user, now)` per entry, or split its output on `\n` if a title
  can never hold a newline; check how titles are cleaned and pick the safe one) and the paused lines
  as today. Then fit them into `MAX_ANSWER` in this order:
  1. Paused lines first in priority, kept in their place after the active list. If even they do
     not all fit, as many as fit, then `...and N more paused.`
  2. Active lines in the room left, whole lines only, then `...and N more active.`
  3. When anything was left out, one closing line: with the web area set up (`d.webEditor`),
     `The web area lists them all: \`/web\`.`; without it, `\`/task history <id>\` still works for
     any of them.`
  The order on screen stays as documented (active, then paused). Only what is dropped changes. The
  result is never cut mid-line, and never over `MAX_ANSWER` (assert it).
- **A pressed button's status always shows.** In `onButton`, build the suffix `\n\n-- ${status}`
  first and clip only the original content, to `MAX_ANSWER - suffix.length`, before appending it.
  `clip` is unchanged.
- **README line 49** (`/tasks`): add that a list longer than one message keeps your paused tasks,
  says how many active ones are left out, and points to `/web` when the web area is set up.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/actions.ts`: a small pure helper (e.g. `fitTaskList(active, paused, webEditor,
   max)`) holding the fitting rules, used by `listTasks`; a JSDoc naming the order and why paused
   lines win (their ids are what resume needs).
2. `plugins/tracker/src/interactions.ts`: the suffix-first clip in `onButton`.
3. `plugins/tracker/README.md`, the `/tasks` row.
4. Tests:
   - the helper, in the test file next to `actions.ts`'s other unit tests:
     - "a short list is shown whole, with no note".
     - "40 active tasks fit whole lines and say how many are left out": no line is cut, the result
       is at most `MAX_ANSWER`, the note's count is exact (shown + left out = 40).
     - "paused tasks are kept when the active list is long": 40 active plus 3 paused -> all three
       `Paused:` lines present, after the active ones.
     - "paused tasks alone over the limit keep as many as fit and count the rest".
     - "the closing line points to /web only when the web area is set up": both values of
       `webEditor`.
   - end to end, through `/tasks` in `surface.test.ts` (its slash-command helper): someone with
     40 tasks and one paused one -> the reply holds the paused task's id and the note.
   - `onButton`: "a button pressed on a 2000-character DM keeps its status": `pressButton` with
     2000-character content -> the edited content ends with the status and is at most 2000
     characters. Extend `pressButton`'s fake to return the edited content if it does not already.
5. This file, committed as `docs/plans/161-tasks-list-fits-one-message.md`.
6. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
7. Mutations from the table, each in a scratch worktree, never in the tree under test; name the red
   test per row in the PR.
8. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure
   modes -- every arithmetic edge of the fitting (exactly at the limit, a single line longer than
   the limit, zero active, zero paused, the note's own length counted), long titles and held-name
   lists, the button edit with content exactly at and over the limit; B: claims-vs-code over this
   plan, the README row, the comments and the CHANGELOG bullet, walking every coverage row and
   deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or
   declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| No line is cut and the list stays within one message | 1 | "40 active tasks fit whole lines ..." | return `clip(lines.join("\n"))` again |
| What was left out is counted | 1 | the same | off-by-one in the count |
| Paused tasks survive a long active list | 1 | "paused tasks are kept when the active list is long" | fit active lines first |
| Paused alone over the limit are counted | 1 | "paused tasks alone over the limit ..." | drop the paused note |
| `/web` is named only when it exists | 1 | "the closing line points to /web only ..." | always name `/web` |
| The end-to-end `/tasks` keeps the paused id | 1 | the `surface.test.ts` case | revert `listTasks` |
| A pressed button's status always shows | 2 | "a button pressed on a 2000-character DM keeps its status" | `clip(content + suffix)` again |

## CHANGELOG bullet (for the PR body)

`/tasks` no longer cuts its answer in the middle of a line at Discord's 2000 characters: a long list
keeps whole lines, keeps your paused tasks, whose ids `/task resume` needs, in preference to active
ones that do not fit (paused ones that still do not fit are counted), says how many active ones it
left out, and points to `/web` when the web area is set up. A paused task's line names at most three
people it could not DM, then how many more. When the notice that your reminders are back on would
push a command's answer past one message, it comes as a second message instead. Pressing a button on
a DM near 2000 characters now shows its status line instead of cutting it off, and an answer cut at
the limit no longer ends in a broken `�` character, half of an emoji (#161, #205).

## Deviations as implemented

1. **The helper's tests are in a new `plugins/tracker/src/actions.test.ts`.** No test file held
   `actions.ts`'s unit tests in general: the ones importing it are named for their topic
   (`answer.test.ts`, `execute-lane.test.ts`, `research.test.ts`, `scout.test.ts`,
   `surface.test.ts`), so the file next to `actions.ts` is a new one.
2. **No active task is a fixed line, never counted.** Built one entry at a time, an empty list has
   no line at all, while docket's `formatTaskList([])` says "You have no active tasks." (which
   `surface.test.ts` and `role-check.test.ts` expect). `fitTaskList` writes that line itself
   (`NO_ACTIVE_TASKS`) when `active` is empty and never drops it, so the paused-only case (every task
   paused after failed DMs) cannot say `...and 1 more active.`
3. **The paused lines are fitted beside the shorter of the two active shapes.** "Paused first, as
   many as fit" is measured beside no active lines (their `...and N more active.` note instead) or
   all of them (no note), whichever is shorter. So a whole list that fits is never cut, and a paused
   line is never given up for an active note when every active line fits in its place.
4. **One helper test beyond the plan's five,** "cuts at the limit exactly, and leaves a line longer
   than a whole message out whole": a list exactly at `max` is whole, one character under keeps whole
   lines and counts the rest, a paused line over 2000 characters (many held names) is counted, not
   cut, and a whole list exactly at `max` whose one active line is shorter than its note and the
   closing line together stays whole (deviation 3; fitting the paused lines beside the note alone
   survives every other test). These are reviewer A's arithmetic edges, pinned in the suite.
5. **`pressButton` needed no change**: it already returns each edit's content.

### Review gate round 1

6. **(A, Major) The resume notice and a full `/tasks` were cut mid-line together.** `run`
   (`discord.ts`) put the resume notice (about 190 characters) above the answer and clipped the
   two at 2000, so the first command after someone's own DMs were paused lost the list's tail.
   Now, when notice + blank line + answer would pass `MAX_ANSWER`, the answer goes alone and the
   notice follows as an ephemeral follow-up (as `onButton` already does); otherwise the combined
   answer is unchanged. This holds for every command. The rule is `withNotice` (`actions.ts`, next
   to `enter`), which `run` calls. Tests: `surface.test.ts` "the first command after a pause answers
   a full /tasks uncut by the notice, and tells of the resume in a second message" (A's scenario:
   40 reminders, `t1` paused for Curly, Larry paused for four days, then back; its `slash` helper
   gained a `followUps` collector, now the `said` log of item 20), and `actions.test.ts`
   "withNotice" at the exact boundary (see 16).
   README's pause paragraph says so.
7. **(B, Major) The CHANGELOG bullet's "always keeps your paused tasks" was false** (paused lines
   alone over the limit are counted, not shown). Reworded as the coordinator gave it: "keeps your
   paused tasks in preference to active ones that do not fit (whose ids `/task resume` needs; any
   that still do not fit are counted)". The bullet also gained the three-names bound (8), the
   notice follow-up (6) and the emoji-safe cut (10), since those are user-visible.
8. **(A, Minor) A paused line could pass a whole message** (display names up to 100 characters,
   recipients uncapped), and `mostThatFit` stops at the first line that does not fit, dropping later
   short paused lines with their ids. Now a paused line names the first three people it could not
   DM, then `and N more` (`heldNames`, `MAX_HELD_NAMES`); the web page still names everyone. Test:
   `actions.test.ts` "listTasks's paused lines" (10 held -> 3 names + "and 7 more"; 3 held -> all
   three).
9. **(B, Major) One call per entry was unpinned** (M29: `formatTaskList(entries, ...).split("\n")`
   survived). Titles can hold a newline (`/remind` text, the web textarea). Test: `surface.test.ts`
   "/tasks keeps a task whose title holds a newline whole: never its first line without its second"
   (B's: 40 reminders `water the plants on the back porch\npot ${i}`; first lines + the active
   note's N = 40, each followed by its `pot N -- ` line).
10. **(A, Minor) `clip` could split a surrogate pair.** When the unit before the cut is a high
    surrogate, it now cuts one unit earlier. Test: `surface.test.ts` "a button pressed on a DM cut
    inside an emoji keeps the emoji whole or leaves it out, never half" (1979 `x` + 11 emoji: no
    lone surrogate, ends with the status).
11. **(A, B, coordinator; Minor) No closing line without the web area.** "`/task history <id>`
    still works" pointed at ids the person cannot see, so without the web area there is none: the
    `...and N more` counts say what is missing. With it, the `/web` line is unchanged. The helper
    tests, README row and bullet match; deviation 4's "short active line" case now uses the web
    area, since only the closing line makes the note shape longer than a real active line.
12. **(B, Minor) M30 survived** (passing `false` for `d.webEditor`). Test: `surface.test.ts`
    "/tasks with the web area set up points to /web for the rest" (a `world({ web: true })`).
13. **(B, Minor) The held-less paused line ``Paused: `id` title`` had no test** (M32). Cheap
    through a `listTasks` unit test on a real `SqliteStore` with a fake `health.pausesFor`: the same
    "listTasks's paused lines" test has a task paused for no one and expects ``Paused: `t3` water``.
14. **(B, Minor) Wording.** `actions.test.ts`'s header, README's row and `fitTaskList`'s JSDoc now say
    "in preference to the active ones that do not fit", not "first", which read as screen order.
    Deviation 1's list of files importing `actions.ts` now includes `research.test.ts` and
    `scout.test.ts`.
15. **Coverage row 1's mutation as written** ("return `clip(lines.join("\n"))` again", in
    `listTasks`) is the same change as row 6 ("revert `listTasks`") and turns only the surface
    `/tasks` tests red. The mutation table runs it in `listTasks` as written and, as row 1b, inside
    `fitTaskList` (returning `clip` of the whole list), which turns the helper tests red.
16. **A threshold survivor of my own.** With the rule inline in `run`, a mutation of the threshold
    (measuring notice + answer without the blank line) survived: no end-to-end answer lands within
    two characters of 2000, so an off-by-one there could not be caught either. The rule moved into
    `withNotice` so it is tested to the character: notice + blank line + answer of exactly 2000
    stays one message, 2001 splits.

### Review gate round 2

17. **(A, Minor) A failed follow-up was thrown to the host.** In `run`, `followUp` had no catch: an
    expired interaction (10062) rejected `handle()` after the answer had landed, and the host logged
    it as an interaction error. It is now caught and logged as a warning, like `failed()` in
    `interactions.ts`. Test: `surface.test.ts` "a follow-up that fails after the answer landed is
    logged, never thrown to the host" (the follow-up rejects; `handle()` resolves, the answer was
    edited, the warning is logged).
18. **(B, Major K2; K6/K11) `clip`'s surrogate check was pinned only end to end, where the cut
    always split a pair.** Direct `clip` tests in `actions.test.ts`: a whole emoji ending right at
    the cut is kept (a low surrogate there must not step back), and U+10000, U+1F600 and U+10FFFF
    across the cut each step back (both ends of the high-surrogate range).
19. **(B, Major C2) The `/web` line when only paused lines are left out was untested.** "paused
    tasks alone over the limit ..." now also checks `fitTaskList([], pausedLines(40), true)` ends
    with the `/web` line.
20. **(B, Major R3; A + B, R4) The follow-up's flags and its order were unchecked.** `slash` in
    `surface.test.ts` now records the edit and every follow-up in one ordered log (`said`), with
    each follow-up's flags. The first-command-after-a-pause test asserts the edit comes first and the
    follow-up carries `{ flags: 64 }` (ephemeral).
21. **(B, H8/H9) A task held for exactly four people** is added to "listTasks's paused lines":
    "Person 1, Person 2, Person 3 and 1 more" (the 3 and 10 cases stay).
22. **(A + B) Wording.** `clip`'s comment says it never splits a surrogate pair (a flag or a ZWJ
    emoji can still be cut between its code points); the bullet says a cut answer no longer ends in a
    broken `�` character. The bullet's parenthetical is B's: "keeps your paused tasks, whose ids
    `/task resume` needs, in preference to active ones that do not fit (paused ones that still do
    not fit are counted)".
23. **(B) Test name.** "the first command after a pause answers a full /tasks whole, ..." is now
    "... answers a full /tasks uncut by the notice, and tells of the resume in a second message"
    (the list is still fitted, not whole); item 6 quotes the new name.
