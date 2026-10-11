# #163 (with #208 tasks-5) -- a page's tags are read at the right offsets whatever its letters, and a search page's listings past the 20th are read

Part of Epic #265. Effort S. Behaviour change (which tags a page read keeps): the three-reviewer
gate applies. Closes #163; part of #208 (its finding `tracker-tasks-5` only; tasks-7 and tasks-8
stay open there).

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

1. **#163.** `pageForExtraction` (`plugins/tracker/src/page.ts`) builds `lower = body.toLowerCase()` and
   uses offsets found in `body` to slice `lower` (`lower.slice(lt, gt + 1)`) and offsets found in
   `lower` to slice `body` (`nextClose` -> `body.slice(at, end)`). `toLowerCase` is not
   length-preserving: `"İ"` (U+0130) lower-cases to two code units (`"i̇"`), so after one `İ` every
   offset in `lower` is one past the same place in `body`. A `<meta>` or JSON-LD `<script>` after
   it is sliced one character early, never starts with `<meta`/`<script`, and is dropped. The price
   preview then finds no price and `/want source:page` sees no listings. Any character whose lower
   case has a different length does the same.
2. **#208 tasks-5.** `MAX_BLOCKS = 20`: a shop search page with one JSON-LD `Product` script per
   card (40 cards) is cut to its first 20 blocks, so `/want source:page` never sees listing 21 on,
   and a `/price` page whose `Product` block follows 20 other blocks finds no price. The cap is
   silent and the README's "Page reads" row does not mention it.

### Decisions

- **A length-preserving ASCII fold** replaces `toLowerCase()`: `body.replace(/[A-Z]+/g, (s) =>
  s.toLowerCase())`. Linear and cannot backtrack. Every offset in `lower` is then the same place in
  `body`. Tag names, attribute names and `application/ld+json` are ASCII, so nothing the walk looks
  for is lost. Name it (e.g. `asciiLower`) and say in its comment why `toLowerCase` is wrong here.
- **`MAX_BLOCKS` goes from 20 to 200.** The quadratic risk #81 guarded against is in docket's
  patterns over unclosed tags, not in the number of well-formed blocks the walk rebuilds, and the
  read is already capped at 3 MB. A search page shows at most about 100-120 cards; 200 covers that
  with room. The cap stays (it bounds how many `JSON.parse` calls docket's extractor and the `page`
  source make on a hostile page). `MAX_METAS` (300) is unchanged.
- **The caps are documented**: the README's "Page reads" row says that at most 200 JSON-LD blocks and
  300 meta tags are kept, in page order. No log line: `pageForExtraction` is pure and takes no
  logger, and plumbing one in is out of scope.
- **Check the `/want source:page` path.** Confirm that docket-types' `pageSource` reads the body
  through this same `pageForExtraction` (via the tracker's fenced `Fetch` in `fetch.ts`). If it reads
  the raw body instead, the cap change does not reach it: record that under "Deviations as
  implemented", and say in the PR which of the issue's two symptoms this fixes.
- **No version bump.** The bullet goes in the PR body under `## CHANGELOG bullet` (Epic #265's
  convention); `plugins/tracker/CHANGELOG.md` is not edited.

### Steps

1. `plugins/tracker/src/page.ts`: the ASCII fold; `MAX_BLOCKS = 200`; the header comment's list
   updated to name both caps.
2. `plugins/tracker/src/page.test.ts`:
   - "an 'İ' before a meta tag does not shift it out of reach": `<title>İstanbul</title><meta
     property="product:price:amount" content="19.99">` -> `extractPrice` finds 19.99.
   - "an 'İ' before a JSON-LD block does not shift it out of reach": the same with a JSON-LD
     `Product` block (price and currency).
   - "a script that closes after an 'İ' is cut at its own end": an `İ` inside an ordinary `<script>`
     before a JSON-LD block, and another `İ` inside the JSON-LD block's own data -> the block's JSON is
     intact (it parses and the price is found). This pins the `nextClose` offsets too.
   - "upper-case tags are still read": `<META PROPERTY=...>` and `<SCRIPT TYPE="APPLICATION/LD+JSON">`
     each yield their price (this fails if the fold is dropped entirely).
   - "keeps the first MAX_BLOCKS JSON-LD blocks, in page order": `MAX_BLOCKS + 10` blocks, each with
     a distinct name -> exactly `MAX_BLOCKS` in the output, and the first and the `MAX_BLOCKS`-th are
     there, the next one is not.
   - "a search page with 40 product cards keeps all 40": exercise the `/want` path that reads a page
     (docket-types' `pageSource` over a fake `Fetch` serving the page, the way `want*.test.ts`
     already does) and assert all 40 listings are read. If `pageSource` turns out not to go
     through `pageForExtraction` (see Decisions), assert on `pageForExtraction`'s output instead and
     record why.
   - Extend "stays fast on pages built to make the extraction patterns backtrack (3 MB)" with a page
     of well-formed JSON-LD blocks filling 3 MB (more than `MAX_BLOCKS`), under the same time bound
     as the other cases.
3. `plugins/tracker/README.md`, the "Page reads" row: the two caps, as decided.
4. This file, committed as `docs/plans/163-page-offsets-survive-case-folding.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under
   test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure
   modes -- every offset in `pageForExtraction`, which code units change length under
   `toLowerCase` and whether any of them can matter after the fold, the walk's linearity, the
   200-block bound against a hostile 3 MB page through docket's extractor and `pageSource`; B:
   claims-vs-code over this plan, the README row, the comments and the CHANGELOG bullet, walking
   every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced
   finding fixed or declined in writing; four rounds at most.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A tag after a length-changing letter is read | 1 | the two "an 'İ' before ..." tests | restore `body.toLowerCase()` |
| A script's end is found at its own offset | 1 | "a script that closes after an 'İ' ..." | `nextClose` searches `body.toLowerCase()` |
| Upper-case tags are read | 1 | "upper-case tags are still read" | `lower = body` (no fold) |
| At most `MAX_BLOCKS` blocks, the first ones | 1 | "keeps the first MAX_BLOCKS JSON-LD blocks ..." | `<=` for `<` in the block cap; keep the last blocks instead of the first |
| A 40-card search page is read whole | 1 | "a search page with 40 product cards keeps all 40" | `MAX_BLOCKS = 20` |
| Still linear on hostile pages | 1 | the extended 3 MB case | -- (a time bound, not a mutation) |

## CHANGELOG bullet (for the PR body)

A page whose text has a letter that changes length when lower-cased (the Turkish `İ`, for one)
before its price data no longer loses that data: the tags after it were read one character off and
dropped, so a `/price` preview found no price and a `/want` page watch found no listings. A page
watch now reads up to 200 JSON-LD blocks instead of 20, so a shop search page with one block per
product shows listings past the twentieth (#163, #208).

## Deviations as implemented

1. **`pageSource` does read through `pageForExtraction`, so the 40-card test runs it over the real
   fenced Fetch with a fake network, not over a fake Fetch port.** In production, `index.ts`'s
   `pageFetch` defaults to `createPageFetch(signal ? { signal } : {})` (no `raw`), and
   `createPageFetch`'s `get` returns `pageForExtraction(body)` (`fetch.ts`); that Fetch is what
   `/want`'s first read (`previewWant` in `want.ts`) and the `wantlist`/`wantjudge` poll and execute
   runs hand to docket-types' `pageSource.search`, which reads `response.body` with `readListings`
   (`jsonLdBlocks`). So the cap change reaches `/want` and both of the issue's symptoms are fixed.
   But the `want*.test.ts` files fake the whole `Fetch` port and hand `pageSource` the raw page,
   which skips `pageForExtraction` entirely: a test built that way would pass with
   `MAX_BLOCKS = 20`. The test instead passes a fake `fetchImpl` and `resolve` to
   `createPageFetch`, so the page goes through the production path.
2. **"keeps the first MAX_BLOCKS JSON-LD blocks" asserts on the rebuilt blocks, not on the whole
   output.** The output ends with the whole page (every `<` blanked), which still contains every
   block's name, so "the next one is not there" holds only for the blocks part. The test counts the
   rebuilt `<script type="application/ld+json">` openers (exactly `MAX_BLOCKS`) and reads the kept
   blocks back with docket's `jsonLdBlocks` (first, `MAX_BLOCKS`-th, not the next, and the exact
   list in page order).
3. **The README's "Page reads" row says a little more than the two caps.** It named the Fetch port as
   `price`'s only, but the 200 cap is for the want-list's `page` source, which reads through the
   same port (deviation 1), so the row now names both readers; it also gets one sentence on the
   ASCII fold, since the row describes how the body is rebuilt.
4. **The 3 MB case's JSON-LD blocks carry no price** (`{"@type":"Product","name":"x"}`, about 42,500
   of them), so the page fits the loop's existing `found` is null assertion beside the time bound.
