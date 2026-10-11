# #165 -- the docs say what is true: `/price` may track an eBay page; only the want-list watcher never opens eBay

Part of Epic #265. Effort XS. Docs only: no behaviour change, no version bump. Single claims-vs-code
audit lane (one read-only auditor). Closes #165.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by text.

**Decision of record (roshne, 2026-10-11, Epic #265 decision 1; comment on #165):** `/price` on
eBay stays allowed. This child is docs-only: the "never opens eBay" wording is scoped to `/want` and
its inbox watches, not to the tracker as a whole. No fence is added to `/price`, its preview or its
polls.

### What is wrong

`/price url:https://www.ebay.com/itm/123` (or a short link that redirects to eBay) is accepted. The
preview and every poll read the eBay page: only the want-list's page source sends the `NEVER_EBAY`
header that `fetch.ts` checks. Several texts read as if the tracker never reads eBay at all:

- `plugins/tracker/README.md`, the overview paragraph near line 23: "the tracker never opens eBay or
  BGG itself". It is in the want-list sentence but reads as global. `/price` also reads BGG pages,
  and the `bgg` source reads BGG's API.
- `plugins/tracker/README.md`, the `/want` row: "the tracker never opens eBay, page or API". In
  context this is about the inbox watch; check it reads that way, and tighten it if not.
- `plugins/tracker/package.json` `description`: "eBay and BoardGameGeek listings you send in through
  the task API, never read by the tracker".
- `plugins/tracker/CHANGELOG.md` 0.16.0 (near line 210): "the tracker never reads eBay". This is a
  released section.

Grep `plugins/tracker` (README, CHANGELOG, package.json, `src/**/*.ts` comments and user-facing
strings) for `eBay`/`ebay` with `never` or `refus` nearby; every claim that reads as global is in
scope.

### Decisions

- **Scope each claim to what is true:** the want-list watcher (`/want`, its page source, its inbox
  watches, the judge) never opens eBay; `/price` reads whatever public page it is given, eBay's
  included. Say it once, plainly, in the README's `/price` row (e.g. "Any public page, eBay's
  included; only the want-list watcher refuses eBay"), and make the other places not contradict it.
  Do the same for BGG where a claim says the tracker never opens BGG: the `bgg` source reads BGG's
  API with the token, the judge may open BGG pages, and `/price` can read a BGG page.
- **The released 0.16.0 CHANGELOG note is not rewritten.** The correction travels as this PR's
  CHANGELOG bullet, which lands under `## [Unreleased]` with Epic #265's close-out. Released notes are
  what shipped, and `plugins.json` carries them.
- **`package.json`'s description changes**, so `plugins.json` is regenerated (`bun run
  generate-index`) and committed as generated. Never hand-edit it. This is content only; the
  `PluginIndexEntry` shape is unchanged.

### Steps

1. The README edits as decided.
2. `plugins/tracker/package.json` `description` scoped, then `bun run generate-index` and commit
   `plugins.json`.
3. Any code comment or user-facing string the grep finds that reads as global, scoped the same way.
   A user-facing string change is a behaviour change: if one turns up, stop and report it instead of
   making it.
4. This file, committed as `docs/plans/165-price-may-read-ebay-docs-say-so.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test scripts`. Paste the counts.
6. Audit (the orchestrator runs it): one read-only auditor reads every changed sentence against the
   code (`price.ts`, `fetch.ts`, `want.ts`, docket-types' `pageSource`/`bggSource`/`inboxSource`) and
   greps for any remaining global "never" claim.

### Coverage

Docs-only: no test, no mutation. The audit in step 6 is the verification.

## CHANGELOG bullet (for the PR body)

The README and the package description no longer say the tracker never reads eBay. `/price` reads
the public page it is given, eBay's included; it is the want-list watcher (`/want`, its page reads,
its inbox watches and its judge) that never opens eBay. Nothing changed in what the tracker does
(#165).

## Deviations as implemented

1. **BGG is scoped to the inbox watch, not to "the watcher without the token".** The plan's list of
   BGG reads (the `bgg` source, the judge, `/price`) misses one: a `/want source: page` on a BGG
   page. docket-types' `pageSource` sends only `NEVER_EBAY` (`want-sources.js:176`) and `startWant`
   refuses only an eBay page (`want.ts:221`), so a page watch on boardgamegeek.com is read with or
   without `TRACKER_BGG_TOKEN`, and its judge may open that host (`judgeHosts`, `wantjudge.js:116`).
   So no changed text says the watcher never opens BGG: the README overview says the watcher never
   opens eBay, "nor any site for these" (the listings sent in), and the comments say an inbox watch
   opens neither site.
2. **One adjacent false clause corrected.** `index.ts`'s inbox comment said "eBay and BoardGameGeek
   reach a watch only this way", false for BGG while the token is set (`index.ts:149`, `want.ts:198`).
   Rewritten with its "never" claim as "An eBay watch, and a BGG one without its token, gets its
   listings only this way".
3. **Six user-facing strings still say "I never open/read eBay" (or BGG's pages) unqualified, and
   are left as they are**, per step 3 (a string change is a behaviour change). Each is shown only
   inside a `/want` flow, so it reads as the watcher speaking, but it is not scoped in words:
   `want.ts:59` (`EBAY_PAGE`), `want.ts:151` and `want.ts:158` (an inbox watch's confirmation),
   `discord.ts:374` (`/want`'s `source` choice), `web/editor-pages.ts:118` (the want editor's
   help), `fetch.ts:185` (the refusal on a want-list page read). Scoping them is a follow-up, not
   this docs-only child.
