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
     space"**: `"line one\n- Oct 1 -- done\t\u200b\u202e x\u0007y"` is stored as one line with
     single spaces, the bidi override and bell gone.
   - **"a reply of only zero-width characters is refused as empty, and nothing is stored"**:
     `"\u200b\u200c\ufeff"`.
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

A recipient's reply is now kept and shown as one plain line in `/task history`, the web task page
and the task API: it can no longer add a line of its own to the history or plant a masked link, a
spoiler or a code block there, and a reply of only spaces, line breaks, zero-width characters or
blank fillers is refused as empty (#205, #208).

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

### Review gate round 1

Reviewer A and reviewer B each NOT SOUND on `379997b`, with one Major each. Fixed in `30774fa` (code,
README, tests) and `ad7a32a` (tests); this file in the commit after them.

5. **(A Major) An escaped `\]` still closes a link that an unescaped `[` opened.** Finding: Discord's
   link text ignores backslash escapes and spans lines, so a `[` in the task's title (`[Bins] out`),
   a findings line or a run's error pairs with a reply's `\]`, and a reply of
   `](https://evil.example)` made one link over the header, the `Next:` line and the runs. Fix:
   `discordPlain` also escapes a `(` right after a `]`, and (A m1) `|` and the backtick, which could
   pair into a spoiler, inline code or a code block across two replies:
   ``/[\\[\]<|`]|(?<=\])\(/g``. Tests: "an escaped bracket in a reply cannot close a link the task's
   title opened", "spoiler bars in replies to two runs cannot pair" and "a reply's backticks open no
   code span or block"; the masked-link test now expects `\[receipt\]\(https://evil.example)`.
   Mutations: dropping the `(?<=\])\(` branch, the `|` or the backtick each fail their test.
6. **(A m3) The `\p{Cf}` sweep changed real text.** Finding: it turned the Persian and Indic
   zero-width non-joiner, the soft hyphen and the visible Arabic number signs into spaces. Fix:
   `oneLine` keeps a keep-list -- U+200D, U+200C, U+00AD, U+0600-U+0605, U+06DD, U+070F, U+0890,
   U+0891, U+08E2, U+110BD, U+110CD -- and collapses every other `\p{Cf}`, so a format character
   Unicode adds later collapses by default, and the tag characters (U+E0001, U+E0020-U+E007F) still
   go: a subdivision flag still shows as a plain black flag. Biome's `noMisleadingCharacterClass`
   refuses U+200D between two characters of a character class, so the joiner is an alternative of
   the lookahead,
   `(?!\u200d|[...])`, the same set. Test: "the format characters real text needs survive; a bidi
   override and a zero-width space between letters do not". Mutation: dropping U+200C fails it.
7. **(A m2, B Major) The empty check missed blanks that are not format characters.** Finding: a
   reply of only U+3164, U+2800, U+034F or U+FE0F was stored and showed as an empty quote. Fix:
   `submitReplyLocked` refuses a `oneLine` result that `BLANK` matches,
   `/^[\s\p{Cc}\p{Cf}\p{M}\u115f\u1160\u3164\uffa0\u2800]*$/u`. It counts every format character,
   kept ones too, so a reply of only kept ones (joiners, a soft hyphen, a number sign) is still
   empty. Test: "a reply of only a blank filler, a lone mark or a variation selector is refused as
   empty; an emoji with its selector is kept". Mutations: dropping `\p{M}` fails it; dropping
   `\p{Cf}` from `BLANK` fails "a reply of only zero-width characters ...".
8. **(B Minor 1) Line and paragraph separators, CR and the trim were untested.** Finding: `\s`
   narrowed to ASCII (H8b, H8c), `replyText` replacing only `\n` (H12) and no trim (H4) all
   survived. Fix (`ad7a32a`): the one-line test sends
   `" line one\r\n- Oct 1 -- done\t\u200b\u202e x\u0007y\u2028z\u2029 "` and expects
   `"line one - Oct 1 -- done x y z"`; the old row holds
   `"ok\n- Oct 1, 9:00 -- done\u2028- Oct 1, 9:00 -- done\r"`, shown as
   `replied "ok - Oct 1, 9:00 -- done - Oct 1, 9:00 -- done"`, and its "no line starts with" check
   splits on CR, LF, U+2028 and U+2029. Mutations: H8b, H8c and H4 fail both tests; H12 fails the
   old-row test.
9. **(B Minor 2) A literal U+200D in source.** Finding: `actions.ts` and `press.ts` held the joiner
   as the character itself, not an escape: the edit tool had decoded the `\u200d` I wrote. Fix: every
   invisible character in the regexes and the tests is a `\u` escape; a scan finds no non-ASCII
   character in `actions.ts`, `press.ts`, `history.ts` or the new tests.
10. **(B Minor 3) Literal invisible characters in this file.** Fix: the two test inputs under Steps
    are written as `\u` escapes.
11. **(B Major, A nit) The CHANGELOG bullet overclaimed.** Fix: replaced with the gate's wording, but
    "plant a masked link" where it said "plant a Discord link": a bare URL in a reply is still a
    clickable link in Discord, as it was before this change (13). Each clause checked against the
    code: one line in all three renderings (`replyText`), no line of its own (`oneLine`), no masked
    link, spoiler or code block in `/task history` (`discordPlain`), and spaces, line breaks,
    zero-width characters and blank fillers refused (`BLANK`). The README says the same.
12. **Declined (A m4): `clip` can split a surrogate pair.** It predates this change, and PR #274
    (#161) fixes `clip` itself; not ported here.
13. **Declined (A m5): a bare URL in a reply unfurls into an embed under `/task history`.** It
    predates this change and is outside it; suppressing embeds on the history answer is a change of
    its own, for a follow-up issue.
14. **Declined (A, optional): wrapping each answer in FSI/PDI.** `oneLine` already strips the bidi
    overrides and isolates, so isolation would only fix cosmetic reordering of punctuation next to
    right-to-left text. In `runLine` it would add two invisible characters to every Discord answer;
    in `RunView` it would also reach the page and the task API's JSON.
15. **Declined (B Minor 4): "shown as typed" inside a code span.** A reply's own backticks are now
    escaped, so it cannot open one; only the owner's title or the bot's own text could, and the
    effect is cosmetic.
16. **Declined (B H5, H7): equivalent or harmless, for B's reasons.** The modal already caps input at
    `MAX_REPLY_TEXT`, and clipping before `oneLine` in `replyText` would only show fewer characters
    of an old row.

### Review gate round 2

Reviewer A and reviewer B each SOUND on `22f3644`: A with two Minors, B with three Minors and a nit.
Fixed in `4ee9b0a` (code, README, tests) and `b8eb387` (tests); this file in the commit after them.

17. **(A m-a) Unassigned default-ignorable code points passed as a reply.** Finding: a reply of only
    `"\u{e0080}"` was stored and showed as an empty quote, and such code points could hide text
    inside a reply. Fix: `BLANK` takes `\p{DI}`, and `oneLine` also collapses U+2065,
    U+FFF0-U+FFF8, U+E0000, U+E0002-U+E001F, U+E0080-U+E00FF and U+E01F0-U+E0FFF, leaving the
    variation selectors U+E0100-U+E01EF alone. Departure: the Hangul fillers U+115F, U+1160, U+3164
    and U+FFA0 are default-ignorable, so with them still listed in `BLANK`, dropping `\p{DI}`, or
    dropping a listed filler, failed no test (both run): with the fillers listed and the unassigned
    ranges collapsed, no code point is left that only `\p{DI}` refuses (a scan of every code point
    in Bun 1.4.2). So the four fillers left `BLANK`'s list, where `\p{DI}` refuses them, and the braille
    blank U+2800, which is not default-ignorable, stays: `/^[\s\p{Cc}\p{Cf}\p{DI}\p{M}\u2800]*$/u`.
    Test: "a reply of only unassigned invisible code points is refused as empty; one between letters
    is a space" (`"\u{e0080}"` and `"\u2065"` refused; one code point from each range between letters
    becomes a space, and an assigned U+E0100 stays). Mutations: dropping `\p{DI}` fails the
    blank-filler test, which now sends all four Hangul fillers; dropping every range, or any one of
    the six, fails the new test.
18. **(A m-b) A bare link takes the backslash before a following `<`.** Finding: a reply of
    `https://a.example<@123>` is shown as `https://a.example\<@123>`, Discord reads the backslash
    as part of the link, and `<@123>` still shows as a mention pill. It never pings, since
    `/task history` answers with `NO_MENTIONS`. Fix: the README says a mention or timestamp typed
    right after a bare link may still show as one, and a mention there never pings; `discordPlain`'s
    doc says the same. Links are not wrapped in `<...>`: an unescaped `](` inside a wrapped link
    would reopen the masked-link hole.
19. **(B Minor 1) Four survivors** (B's N3, N4, N6 and N11: `BLANK`'s `*`, the listed fillers, the
    Arabic and Syriac signs, the Kaithi signs). Fix (`b8eb387`): a reply of only `" \n\t "` is
    refused as empty; the blank-filler test also sends U+115F, U+1160 and U+FFA0; and the
    format-characters test sends each kept number sign before a `1` and expects it unchanged.
    Mutations: `BLANK`'s `*` made `+` fails two tests; dropping U+0600-U+0605, U+06DD, U+070F,
    U+0890 and U+0891, U+08E2, or the Kaithi pair from the keep-list each fails the
    format-characters test; dropping U+2800 from `BLANK` fails the blank-filler test. Dropping a
    listed Hangul filler no longer applies, since none is listed (17); dropping `\p{DI}` fails instead.
20. **(B Minor 2) The keep-list read as complete.** Finding: U+180E (Mongolian vowel separator) also
    collapses. Fix: the wording, not the policy: the README says "but for a few format characters",
    and `oneLine`'s doc "It keeps a few format characters real text needs". U+180E stays collapsed:
    it is also on reviewer A's list of characters that can hide text.
21. **(B Minor 3) Decline 14's reason.** Fix: replaced with B's: isolation would only fix cosmetic
    reordering, and would put invisible characters in every Discord answer, or in the page and the
    API too.
22. **(B nit) Entry 6's Biome wording.** Fix: it refuses U+200D "between two characters of a
    character class", not anywhere inside one.
23. **Declined (B N10, N12, N16, N13).** N10, N12 and N16 are equivalent mutations and N13 is
    harmless, for B's reasons.
