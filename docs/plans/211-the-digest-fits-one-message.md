# #211 notify-4 -- the daily digest fits one message, and keeps both sections and their counts

Part of Epic #265. Effort S. Behaviour change (what a long digest shows): the three-reviewer gate
applies. Part of #211: its finding `tracker-notify-4` only. notify-3 is PR #278 (with #169);
notify-5 waits on the epic's decision 5.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

`formatDigest` (`plugins/tracker/src/digest.ts`) caps each section at `MAX_LINES` (10) lines, a
count, not a length. A line runs to about 170 characters: an id, a title cut to 80, and for an
overdue renewal "asked <date>, waiting on your keep, cancel or renewed". Ten overdue renewals and
several due today pass Discord's 2000. `toHostMessage` (`notifier.ts`) then cuts the tail and adds
"...": the Overdue section and its count survive; Due today is cut part way through a line, losing
the rest of its lines, its "- and N more" and the footer. The day is already claimed, so nothing is resent. The one test of the cap
(`digest.test.ts` "formatDigest" > "is null with nothing to list, ...") uses short titles.

### Decisions

- **One shared cap, as large as fits.** `formatDigest` renders with a per-section cap `k`, from
  `MAX_LINES` down to 0, and returns the first rendering that fits one message. The same `k` applies
  to both sections, so a long Overdue list cannot push Due today out. A section with more items than
  `k` keeps its count line. A shorter section keeps all its lines.
- **"Fits" is the host's measure.** It is `wrapBareUrls(text).length <= MAX_CONTENT`, both imported
  from `notifier.ts` (no cycle: `notifier.ts` does not import `digest.ts`). A title holding a bare
  link grows by two characters when the host wraps it, so the plain length is not enough. The
  notifier's cut then never fires on a digest. Keep it as the backstop and leave it unchanged.
- **A section showing no lines** (`k` = 0, which only a much longer line format could reach) reads
  `title` then `- N in all`, not "- and N more". Every other section's count line is unchanged.
- **Nothing else changes.** No order change, no new constant, no change to `MAX_LINES`, the title
  cut, the footer or the claim.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/digest.ts`:
   - `section(title, items, line, shown)` takes the cap.
   - `formatDigest` makes the lines for each `k` from `MAX_LINES` down to 0, and returns the first
     text that fits. It is pure and needs no new parameter.
   - Remove the comment "The notifier cuts a message past Discord's bound". Say instead that the
     digest is built to fit, and that the notifier's cut stays as the backstop.
   - Add one sentence to the header: "A digest too long for one message shows fewer lines in each
     section, the same number in both, and counts the rest."
2. `plugins/tracker/README.md`: in the Daily digest row (`src/digest.ts`), add the same fact in the
   row's own words, beside "Nothing listed, no DM".
3. Tests, in `plugins/tracker/src/digest.test.ts`'s "formatDigest" describe, using the file's own
   `setup`/`make` helpers (renewals via the `make(..., "renewal", ...)` form the file already uses):
   - **"a digest past one message shows the same number of lines in each section, as many as fit,
     and keeps Due today, the footer and both counts".** Use 12 overdue renewals and 12 reminders due
     today, every title 100 characters (so each is cut to 80).
     - The text fits (`wrapBareUrls(text).length <= MAX_CONTENT`).
     - It holds "**Overdue**", "**Due today**", the footer line, and both sections' "- and N more"
       with the right N.
     - Both sections show the same number `k` of `- \`` lines, with `k >= 1`.
     - That `k` is the largest that fits: one more line in each section would pass `MAX_CONTENT`.
       Assert that the text's length plus the two longest shown lines plus two newlines is over
       `MAX_CONTENT`.
     - No line ends in "...", other than a cut title's own "..." inside it.
   - **"a title with a bare link counts the host's wrapping"**: a fixture where the plain text at the
     chosen `k` fits but the wrapped text would not. Tune one title's length to get there, and assert
     the wrapped length fits. If no fixture within `MAX_TITLE` can tell the two measures apart,
     record why under Deviations and pin the measure some other way the mutation still turns red.
   - **"a digest that fits is unchanged"**: the existing "is null ... counts what is past the
     per-section limit" test stays green as it is (10 shown, "- and 2 more"). Do not edit it.
   - **Through the notify tick**: in the file's "the plugin's notify tick" describe (or `runDigests`
     with a capturing notifier, whichever the file already does), the DM actually sent for the
     12 + 12 fixture holds "**Due today**" and the footer, and does not end in "...".
   - **The count line at `k` = 0**: export `section` only if the file's style allows. Otherwise test
     it through `formatDigest`, or record under Deviations that it is unreachable with
     `MAX_TITLE` = 100, and state the arithmetic.
4. This file, committed as `docs/plans/211-the-digest-fits-one-message.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker` (private `TMPDIR`), `bun test`. Paste the
   counts.
6. Mutations from the table, each in a scratch worktree (foreground, removed after), never in the
   tree under test.
7. Review gate: you plus two read-only reviewers. Reviewer A covers correctness and failure modes:
   the loop's bound, a title with links, a zone-dependent date label, `k` = 0, and whether
   `toHostMessage` can still cut. Reviewer B covers claims against the code: comments, README, the
   bullet, every coverage row, and mutation survivors. The gate passes at 2 of 3. Every evidenced
   finding is fixed or declined in writing, in four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A long digest fits one message | 1 | "a digest past one message ..." | drop the loop: always render at `MAX_LINES` |
| Due today, the footer and both counts survive | 1 | the same, and the notify-tick test | drop the loop |
| The cap is the largest that fits | 1 | the same ("one more line would not fit") | start the loop at `MAX_LINES - 3`, or step by 2 |
| Both sections share the cap | 1 | the same (equal `k`) | shrink only the Overdue section's cap |
| The fit is measured after the host wraps links | 1 | "a title with a bare link ..." | measure `text.length` instead of `wrapBareUrls(text).length` |
| A short digest is unchanged | -- | the existing "is null ... per-section limit" test | start the loop at `MAX_LINES - 1` |

## CHANGELOG bullet (for the PR body)

A daily digest too long for one Discord message is no longer cut part way through Due today, which
lost the rest of its lines, its count and the footer. Both sections now show at most the same number
of lines, as many as fit, and count the rest (#211).

## Deviations as implemented

Recorded by the implementer; the plan above is left as handed down. Numbers are from the tests'
own fixtures.

1. **The bare-link fixture tunes one title, but every reminder title holds a link.** Finding: from
   the 12 + 12 fixture (100-character titles: 7 lines a section, 1965 characters), one more line a
   section is 2217 characters, 217 over -- more than one title can give back (a cut title shows 80
   of its characters), and one bare link widens the text by only 2, a window of 1999-2000. What I did: the same 12
   overdue renewals; every reminder's title is a bare link (`https://shop.example/<i>/`, padded to
   54), and the first one's length is tuned to 37. The digest shows 7 lines a section (1766 plain,
   1780 wrapped); with 8 the plain text is 1992, which fits, and the wrapped 2008, which does not.
   The test checks that itself: the same digest with `hxxps` for each link (no link, the same
   length) shows 8 lines a section, and that text with the links put back fits by its plain length
   and not once wrapped. Why: eight wrapped links give a 16-character window rather than 2, so a
   small change to the footer or a line format does not stop the fixture telling the two measures
   apart, and a larger one fails that check instead of passing vacuously.
2. **"One more line would not fit" adds the longest shown line of each section.** Finding: the two
   longest shown lines, read literally, are both Overdue's (153 characters against Due today's 97),
   which overstates what one more line in each section adds. What I did: the longest shown line of
   each section plus two newlines (1965 + 153 + 97 + 2 = 2217). Why: in this fixture that is exactly
   what the next rendering adds -- the next ids (`t8`, `t20`) are as long as those shown, and
   "- and 5 more" becomes "- and 4 more", the same length.
3. **The count line at `k` = 0 is tested through `formatDigest`, with a stand-in id.** Finding:
   `section` stays private (digest.ts exports none of its helpers -- `answered`, `dateLabel`,
   `clockTime`, `waitingOn` -- for tests), and `k` = 0 cannot come from the store. The bound is the
   80-character title cut in `formatDigest`, not `MAX_TITLE`: with one line a section the text is at
   most about 590 characters -- the header 21, the two section titles 24, two count lines under 20
   each (`MAX_LIVE_TASKS` is 200), the footer 128, 7 newlines; an Overdue line at most 158 plus the
   id, a Due today line at most 135 plus the id (title 80, a date with its year 22), each up to 18
   more once the host wraps the nine bare links an 80-character title can hold; an id is `t` and a
   SQLite rowid, at most 20. What I did: "a section that can show no line counts them all" gives the
   12 + 12 digest's items an id of `MAX_CONTENT` characters, which no store makes, and pins the
   whole text: each section reads its title, then "- 12 in all". Why: the plan's second option; it
   pins the wording, which an untested branch would not.
4. **When no rendering fits, `formatDigest` returns the one with no lines.** Finding: the plan does
   not say what happens if even `k` = 0 does not fit. What I did: the loop stops at 0 and returns
   that text; the notifier's cut stays the backstop. Why: that text holds no item line (header,
   section titles, counts, footer: about 200 characters), so it always fits and the case cannot
   arise; the bound only keeps the loop finite. For the same reason, moving the bound to
   `shown >= 0` is an equivalent mutant: no test can tell.
5. **`MAX_LINES`'s comment, not its value, changed:** "Lines shown per section" now reads "The
   most lines shown per section", since a long digest shows fewer.
6. **Assertions and helpers beyond the plan's.** The first test also checks that the fixture lists
   12 + 12, and that the first Overdue line holds its cut title's "..." (so "no line ends in ..."
   is not vacuous). The notify-tick test also checks that the DM starts with Monday's header and
   Overdue, and holds two "- and N more" lines (the Coverage row "both counts survive" names it).
   New test helpers: `FOOTER`, `ASKED`, `longDay` and `shownLines` at the top of the file,
   `longDigest` in the "formatDigest" describe. No existing test is edited.
7. **Coverage row "The cap is the largest that fits": its own test does not catch "start the loop
   at `MAX_LINES - 3`".** Finding: that fixture's largest `k` is 7, which is `MAX_LINES - 3`, so
   the mutant renders the same text there (an equivalent input). What I did: nothing in the code;
   the mutant is caught by the existing "is null ... per-section limit" test (10 lines) and by "a
   title with a bare link ..." (whose one-more rendering needs 8). Why: a 12 + 12 fixture with
   100-character titles cannot reach 8 lines a section (2217 characters), so no change to that test
   within the plan's fixture would catch it.

### Review gate round 1

Both reviewers SOUND on `cca37a4`, Minors only; all five applied.

8. **What main loses was overstated (B Minor 1).** Finding: on `main` the 12 + 12 digest keeps the
   whole Overdue section and its "- and 2 more", then "**Due today**" and its first 4 lines, and is
   cut at 2000 part way through the 5th; it loses the rest of Due today's lines, its count and the
   footer (checked by running the notify-tick test against `main`'s `digest.ts`). The plan said both
   "- and N more" lines were cut. Fix: "What is wrong" and the CHANGELOG bullet above now say what
   is lost. The body of commit `cca37a4` repeats the overstatement ("Due today, both counts and the
   footer were lost"); it stays in history, and this entry corrects it.
9. **"Fewer lines in each section, the same number in both" (B Minor 2).** Finding: false when one
   section is shorter than the cap: it keeps all its lines. Fix: `digest.ts`'s header now reads "A
   digest too long for one message caps both sections at the same, smaller number of lines (the
   most that fit) and counts the rest."; the comment above the loop says "one cap for both
   sections"; the README's Daily digest row says the same as the header. Step 1's quoted sentence
   above is left as handed down.
10. **The fit's boundary was not pinned (A + B Minor 3).** Finding: `>` to `>=` survived; no fixture
    landed on exactly 2000. Fix: "a title with a bare link ..." builds its fixture twice (this
    replaces deviation 1's 37-character first title). With the first title at 29 characters the
    wrapped text with eight lines a section is exactly 2000 (1984 plain), and eight are shown; at 30
    it would be 2001 (1985 plain), and seven are shown (1759 plain, 1773 wrapped). The unlinked
    twin's check now runs on the 30 fixture and expects exactly 2001 once wrapped. Red under `>=`,
    under `> MAX_CONTENT + 1`, and still under `text.length`.
11. **An empty section leaves the other the full cap (B Minor 4).** Finding: no test showed it.
    Fix: "a section that can show no line counts them all" is renamed "..., and an empty section
    leaves the other the full cap", and also renders the twelve overdue renewals with nothing due
    today, pinning the whole text: the header, "**Overdue**", all ten lines, "- and 2 more" and the
    footer (1715 characters). The suggested "- 12 in all" holds only for the stand-in ids, which fit
    no line at any cap and so cannot show it; the fixture's own items do. Red under a mutant where an
    empty Due today still takes room from the cap (`+ (digest.today.length === 0 ? shown * 100 : 0)`
    in the fit check, which shows seven), and also under "start the loop at `MAX_LINES - 3`" and
    "`- 1`".
12. **A section with exactly `k` items prints no count (B Minor 5).** Fix: new test "a section with
    no more items than the cap shows them all, with no count": seven overdue and twelve due today
    give `k` = 7 (1952 characters; eight would be 2050). Overdue shows its seven with no count line,
    and the only "- and" line is Due today's "- and 5 more". Red under `items.length >= shown`.
