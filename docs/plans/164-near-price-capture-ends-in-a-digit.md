# #164 -- a `near` price ends at its last digit, so "19.99," is 19.99, not 1999

Part of Epic #265. Effort S. Behaviour change (what a new `near` tracker reads): the
three-reviewer gate applies. Closes #164.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

`nearPattern` (`plugins/tracker/src/price.ts`) turns the owner's `near` text into the price type's
`pattern`: `${literal}[^0-9]{0,40}([0-9][0-9.,]{0,15})`. The capture can end in `.` or `,`. On
"Price: 19.99, free shipping" (or JSON `"price":19.99,"currency"` with near `"price":`) it captures
`19.99,`. docket-types' `parsePrice` looks for the decimal part with `/[.,](\d{1,2})$/`, finds none
(the string ends in `,`), drops every separator and reads 1999. The baseline is 100x too high, and a
later correct reading then looks like a 99% drop and sends a false alert. The pattern is stored in the
task's config when the tracker is made (`priceInputPlan` -> `config.pattern`), and docket's `price`
type reads it on every run (`docket-types/dist/price.js`, `run`), so the owner cannot repair it.

### Decisions

- **The capture ends in a digit:** `([0-9](?:[0-9.,]{0,14}[0-9])?)`. Still bounded at 16 characters
  and still one literal followed by bounded classes, so it cannot backtrack for long (the reason
  `nearPattern` exists). One digit alone still matches.
- **Existing trackers are not rewritten.** Their pattern stays as made. A read-time upgrade or a
  migration would not repair a baseline already read 100x too high. With the `first` or `peak` rule it
  would make the next correct reading look like a 99% drop and send exactly the false alert this
  issue describes. A tracker that misread this way has to be deleted and made again; the CHANGELOG
  bullet says so. Record this in the PR's "Known behaviour changes" section.
- **Upstream give-back, not done here:** docket-types' `parsePrice` could ignore trailing separators
  itself, which would fix every caller. That is a change in Rackbops/docket. Name it in the PR as a
  suggested follow-up; file nothing.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet`.

### Steps

1. `plugins/tracker/src/price.ts`: the new capture; the JSDoc says the price ends at its last digit
   and why (a separator right after the number is punctuation, not a decimal point).
2. Tests, in the file that already tests `nearPattern` with a page (`page.test.ts`'s "keeps every
   price source docket reads", or `tracked.test.ts` near line 291; put them beside the existing
   ones):
   - "a price followed by a comma is read as written": text `Price: 19.99, free shipping`, near
     `Price:` -> 19.99.
   - "a price that ends a sentence is read as written": `Now 49.90. Order today`, near `Now` -> 49.9.
   - "a JSON price followed by its next key is read as written": `{"price":19.99,"currency":"EUR"}`
     embedded in an HTML page (so it reaches `near` as text, not as a JSON body), near `"price":` ->
     19.99.
   - "a thousands separator is kept": `Total: 1,299.99,` -> 1299.99; `Total: 1.299,99.` -> 1299.99
     (the European form, which `parsePrice` already handles when the capture ends in a digit).
   - "a one-digit price is read": `Price: 7, today` -> 7.
   - "the capture stays bounded": `nearPattern("x")` matched against `x ` followed by 40 digits
     captures at most 16 characters.
   - Through the whole flow once: the `/price ... near:` path in `tracked.test.ts` (or the nearest
     test that makes a `near` tracker and runs it) on a page with `19.99,` -> the stored first
     reading is 19.99.
3. This file, committed as `docs/plans/164-near-price-capture-ends-in-a-digit.md`.
4. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
5. Mutations from the table, each in a scratch worktree, never in the tree under test; name the red
   test per row in the PR.
6. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure
   modes -- every input shape the capture can now meet: trailing separators, thousands
   separators in both conventions, a single digit, a number longer than the bound, a `near` text that
   itself ends in a digit, and docket's `parsePrice` on each; whether the new capture can backtrack;
   B: claims-vs-code over this plan, the JSDoc and the CHANGELOG bullet, walking every coverage row
   and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or
   declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A trailing `,` is not part of the price | 1 | "a price followed by a comma ..." and the JSON case | restore `[0-9.,]{0,15}` |
| A trailing `.` is not part of the price | 1 | "a price that ends a sentence ..." | restore the old capture |
| Separators inside the number still count | 1 | "a thousands separator is kept" | drop `.,` from the inner class |
| One digit is a price | 1 | "a one-digit price is read" | make the tail required (drop the `?`) |
| The capture is bounded | 1 | "the capture stays bounded" | `{0,14}` -> `*` |
| The stored first reading is right end to end | 1 | the flow test | restore the old capture |

## CHANGELOG bullet (for the PR body)

A `/price` tracker made with `near` now reads a price followed by a comma or a full stop ("19.99,"
or "49.9.") as written; it used to drop the decimal point and read 1999 or 499, so its first reading
was 10 or 100 times too high and a correct later one looked like a steep drop. Trackers made before
this keep the pattern they were made with: stop one that shows such a price (`/task done`, or delete
it on the web) and make it again (#164).

## Deviations as implemented

Items 1 and 2 are about where and how the tests sit. Items 3 to 8 are the review gate's round 1;
item 4 rewrites the CHANGELOG bullet above, the only edit made above this section.

1. **The flow test needed a page only `near` can read.** `tracked.test.ts`'s `world()` page reader
   served only `page(price)`, a JSON-LD page, and the existing `near` test there covers only the
   "no price found" path. The reader gained `shop.body` (a page served as sent instead), and the flow
   is a new test beside the existing one: "near reads a price followed by a comma as written, and
   keeps it as the first price (#164)". It makes `/price ... near: Price: baseline: first` on
   `<p>Price: 19.99, free shipping</p>` and checks the reply ("I read 19.99"), the poll's baseline
   DM ("Now tracking ... at 19.99."), and `/task history` ("Prices: 1 read, low 19.99, high 19.99").
2. **The capture tests are their own `describe("nearPattern on a page")` at the end of
   `page.test.ts`**, not inside `describe("pageForExtraction")`: they test the pattern, not the page
   reduction. Each but "the capture stays bounded" runs
   `extractPrice(pageForExtraction(html), nearPattern(near))`, as the existing `near` cases do; that
   one runs `new RegExp(nearPattern("x"), "i")` itself, to see the raw capture rather than the price
   read from it. So the plan's texts are wrapped in HTML (`<p>...</p>`; the JSON case in a plain
   `<script>`), and the thousands-separator texts carry words after the trailing separator
   (`1,299.99, with tax`, `1.299,99. Mit MwSt.`) so the separator is punctuation, not the page's end.
3. **Review gate round 1: where the pattern is made and kept.** "What is wrong" cites
   `priceInputPlan` -> `config.pattern`; no such function exists. `startPrice` builds it
   (`price.ts:146`, `pattern: nearPattern(near)`), `finishPrice` stores it with the task through
   `createTask` (`price.ts:181`), docket's `price` type reads it on every run
   (`docket-types/dist/price.js:113`, `extractPrice(body, ctx.config.pattern)`), and an edit keeps it
   (`editPriceLocked`, `edit.ts:262`, copies the old config and changes only the drop and the
   baseline). The conclusion stands: the owner cannot repair it.
4. **Review gate round 1: the CHANGELOG bullet is rewritten** (in its section above). A misread was 10
   or 100 times too high, not only 100: a price with one decimal digit read 10 times too high (499
   for "49.9."), one with two 100 times (1999 for "19.99,"), so "a 99% drop" held only for the second.
   And a tracker is stopped with `/task done` or deleted on the web; `/task` has no delete.
5. **Review gate round 1: decision 2 left out `last`, the default baseline, and it strengthens the
   decision.** Under `last`, the first correct reading after a misread baseline sends one false alert
   (a 90% or 99% drop) and then measures from the correct reading. Under `first` or `peak` the
   misread stays the reference for good: every correct reading is below it, so after one false alert
   a real drop never alerts. A read-time upgrade or a migration would send that false alert under
   every rule, and leave `first` and `peak` trackers broken.
6. **Review gate round 1: item 2's "each runs `extractPrice(...)`"** was untrue of "the capture
   stays bounded"; the sentence is corrected in place.
7. **Review gate round 1: tests for mutations nothing killed**, all in `page.test.ts`'s
   `nearPattern on a page`, each confirmed red under its mutation in a scratch worktree:

   | Test | Mutation it kills |
   |---|---|
   | "a two- or three-digit price followed by a comma is read whole" (10, 120) | `{0,14}` -> `{1,14}` ("10," read 1); the last `[0-9]` -> `[1-9]` ("120," read 12) |
   | "a price with one decimal digit is read as written" (19.5) | the old capture ("19.5," read 195) |
   | "a price under 1 is read" (0.99) | the first `[0-9]` -> `[1-9]` |
   | "the gap after the near text is at most 40 characters" (40 dashes -> 5, 41 -> no price) | the gap's `{0,40}` -> `{0,41}`, `{0,39}` or `*` |
   | "the gap after the near text may hold commas and full stops" (`Price, incl. VAT: 19.99,`) | the gap's `[^0-9]` -> `[^0-9.,]` |
   | "a near text with regular-expression characters is matched as written" (near `Total (incl. VAT) [EUR\GBP] \|`, after a number and a near-miss with `x` for `.`) | dropping `.`, `(`, `)`, `[`, `[` with `\]`, `\|` or `\\` from the escape class |
8. **Review gate round 1: mutations declined as equivalent**, each confirmed to leave every test
   green:
   - `(?:` -> `(`: an inner group that captures; the price is still group 1.
   - The first `[0-9]` -> `[0-9.,]`, and the capture `([0-9.,]{0,15}[0-9])`: the gap before it
     already takes every `.` and `,` it can, so the capture starts at a separator only when the gap
     is full at 40 characters. The same in practice.
   - Dropping `.trim()`: `startPrice`, the only caller, trims `near` first (`price.ts:140`).
   - Dropping `\]` from the escape class (found while running the rows above): a lone `]` outside a
     class is a literal in a pattern without the `u` flag, and docket compiles the pattern with `"i"`
     alone (`docket-types/dist/extract.js:136`), so `\[EUR]` and `\[EUR\]` match the same text.
