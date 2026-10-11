# #205 discord-3 (= #208 tasks-8) -- a recipient's reply is one plain line in `/task history`

Part of Epic #265. Effort S. Behaviour change (what a stored reply holds; how history renders it):
the three-reviewer gate applies. Part of #205 (its finding `tracker-discord-3` only; discord-1 is
PR #274, discord-4 waits on the epic's decision 6). Also closes the duplicate finding #208 tasks-8.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

An accepted recipient's Reply (the modal, `interactions.ts`; stored by `press.ts`
`submitReplyLocked`) is kept as typed, up to 1000 characters. Only `trim()` is applied and only an
empty result is refused. `history.ts` `replyText` prints its first 80 characters into the owner's
and admins' `/task history`, unescaped, inside the run's line (`runLine`). So:

- A reply holding a newline plus `- Oct 1, 9:00 -- done` plants a forged history line.
- A reply holding a Discord masked link (`[your receipt](https://evil.example)`) renders as a link
  under text the recipient chose.
- A reply of only zero-width characters (U+200B and the like) passes the empty check and shows as
  an empty quote.

The web page renders the same `RunView.answers` through `html` escaping, so a link there is inert,
but a newline still breaks the row's text.

### Decisions

- **One line on the way in.** `submitReplyLocked` collapses every run of whitespace, control
  characters (`\p{Cc}`), line and paragraph separators, and format characters (`\p{Cf}`: zero-width
  spaces, bidi overrides, BOM) to one space, then trims, then clips to `MAX_REPLY_TEXT` as now.
  - The one format character kept is U+200D (zero-width joiner), so emoji sequences stay whole.
  - A reply with nothing left but spaces and U+200D is "That reply was empty." and is not stored.
  - Put the helper beside `clip` (wherever `clip` lives) as `oneLine(text)`, with a one-line doc.
- **One line on the way out too.** `replyText` applies `oneLine` to the stored text before its
  80-character clip, so a reply stored before this change cannot break a line either. This is
  shared by Discord and the web page.
- **Discord only: Discord's link and mention syntax is escaped.** `runLine` (Discord's rendering of
  a run) escapes `\`, `[`, `]` and `<` in the answers with a backslash, backslash first. Escaping
  `[`/`]` kills a masked link; escaping `<` shows `<@id>`, `<#id>`, `<t:...>` and `<:emoji:id>` as
  typed. A backslash escape is invisible once Discord renders it. Bold, italics, strike and spoiler
  are left alone: without a newline they cannot forge a line, and escaping `_` would break bare
  links that hold one. The web page (`pages.ts`) uses `RunView.answers` as it is, so it shows no
  backslashes.
- **Not done here: a cap on replies per recipient** (the finding's last clause). Its fix does not
  ask for one, and choosing the number is the owner's call. The PR says so, and it stays on #205.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `oneLine` beside `clip`. `press.ts` `submitReplyLocked` uses it as decided.
2. `history.ts`: `replyText` uses `oneLine`. `runLine` escapes the answers for Discord. The file's
   header, or `RunView.answers`' doc, says the answers are plain text and that Discord's rendering
   escapes them.
3. Find every other place a reply's `payload.text` is shown or sent: `grep -rn "payload" ... text`
   in `src`, the web pages, the Task API's JSON, and any DM to the owner. Apply `oneLine` where the
   text reaches Discord or a page. JSON keeps the stored text, which is now one line for new replies.
   Record what you found under Deviations.
4. README: if a sentence describes what a Reply keeps or how history shows it, make it true.
5. Tests, next to the existing Reply tests (`surface.test.ts` "the Reply path's gates (#162)" or
   wherever `submitReply` is driven) and the history tests:
   - **"a reply is kept as one line: newlines, tabs, control and zero-width characters become one
     space"**: `"line one\n- Oct 1 -- done\t​‮ x\u0007y"` is stored as one line with
     single spaces, the bidi override and bell gone.
   - **"a reply of only zero-width characters is refused as empty, and nothing is stored"**:
     `"​‌﻿"`.
   - **"an emoji joined by zero-width joiners survives"**: a family emoji is stored unchanged.
   - **"history shows a reply stored before this change on one line"**: write a reply with
     `"ok\n- Oct 1, 9:00 -- done"` straight into the store, as an old row would be. `/task history`'s
     run line holds it on the same line, and no line of the answer starts with `- Oct 1, 9:00`.
   - **"history escapes a masked link and a mention in a reply, in Discord only"**:
     - Use a stored reply `"[receipt](https://evil.example) <@123> \\ok"`.
     - Discord's `/task history` shows `\[receipt\](https://evil.example) \<@123> \\ok`, clipped
       per `replyText`.
     - The web task page shows the original characters, HTML-escaped, with no added backslash.
6. This file, committed as `docs/plans/205-a-reply-is-one-plain-line-in-history.md`.
7. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
8. Mutations from the table, each in a scratch worktree (foreground, removed after), never in the
   tree under test.
9. Review gate: you plus two read-only reviewers. The gate passes at 2 of 3. Every evidenced finding
   is fixed or declined in writing, in four rounds at most.
   - **A, correctness and failure modes:**
     - what `\p{Cf}` and `\s` cover in Bun's regex engine;
     - surrogate pairs and the clips;
     - every other rendering of a reply;
     - whether any Discord markdown left unescaped can still plant a link or a line (headers, block
       quotes and lists need a line start);
     - whether `allowedMentions` already stops a ping, so `<` is for display only.
   - **B, claims against the code:** comments, README, the bullet, every coverage row, mutation
     survivors.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A new reply is stored as one line | 1 | "a reply is kept as one line ..." | drop `oneLine` in `submitReplyLocked` |
| A zero-width-only reply is refused | 1 | "a reply of only zero-width characters ..." | keep `\p{Cf}` out of `oneLine` |
| An emoji sequence survives | 1 | "an emoji joined by zero-width joiners survives" | strip U+200D too |
| An old multi-line reply shows on one line | 2 | "history shows a reply stored before this change ..." | drop `oneLine` in `replyText` |
| Discord shows a masked link and a mention as typed | 2 | "history escapes a masked link ..." | drop the escape in `runLine` |
| The web page shows no backslashes | 2 | the same (web half) | escape in `runView` instead of `runLine` |

## CHANGELOG bullet (for the PR body)

A recipient's reply is now kept and shown in `/task history` as one plain line: a reply can no
longer add a line of its own to the history, plant a Discord link under text of its choosing, or be
nothing but invisible characters (#205, #208).

## Deviations as implemented

1. **Where the tests live.** Finding: `surface.test.ts` has no "the Reply path's gates (#162)" at
   `2949dbe`, and its Reply tests run on a `:memory:` database the test can neither read (what a
   reply stored) nor write (an old row). What I did: all five tests are one new `describe`, "a reply
   is one plain line (#205, #208)", at the end of `web/web.test.ts`, through `web/harness.ts`: a
   file database, the modal (`replyText`), `/task history`, and the task page. Why: the one harness
   that reaches every assertion without new test plumbing.
2. **Step 3's search.** Finding: a reply's `payload.text` reaches a reader only through
   `history.ts` `replyText`, into `RunView.answers`, which three renderings share: Discord's
   `runLine` (`/task history`); the web task page (`pages.ts` `historyPage`, HTML-escaped; the page
   an admin opens from the admin pages too); and the Task API's `GET /api/v1/tasks/<id>`
   (`api-tasks.ts` `getAnswer` returns `view.runs` as it is). No DM carries a reply:
   `submitReplyLocked` sends nothing, docket's `Lanes.reply` stores it and calls the type's
   `onReply`, and no docket-types type acts on a text reply. `digest.ts` reads replies' kinds only;
   forget-me (`roster.ts`) only deletes them. What I did: nothing beyond `replyText`. Why:
   `oneLine` there covers every rendering. The plan's "JSON keeps the stored text" does not match
   the code: the API never returned the stored text, only `RunView.answers` (the clipped
   `replied "..."`), so its JSON gets `oneLine` through `replyText` as the page does, and no
   Discord escape.
3. **The escape is one pass.** Finding: "backslash first" guards against escaping the backslashes
   an earlier replace added. What I did: `discordPlain` replaces `\`, `[`, `]` and `<` in one
   regex pass, so each character typed gets exactly one backslash and none is added twice. It
   escapes each whole answer, so a display name's `[`, `]` or `<` is shown as typed too. Why: the
   same result as replacing backslash first, in one step.
4. **One more refused input.** Finding: no listed test covers the decision that a reply of only
   spaces and U+200D is empty (`oneLine` keeps U+200D). What I did: the zero-width test also sends
   `"\u200d \u200d"` and expects "That reply was empty.". Why: the decision is behaviour this
   change adds, and the test's title already covers it.
