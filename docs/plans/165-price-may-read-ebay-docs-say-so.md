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
its inbox watches and its judge) that never opens eBay. The watcher's own replies (its refusals, an
inbox watch's confirmation, `/want`'s `source` choice and the editor's help) now say it is the
watch, not the bot, that never opens eBay (and that an inbox watch never opens BGG's pages). The
released 0.16.0 and 0.19.0 notes ("never reads eBay", "never by reading either site") meant the
want-list watcher. Nothing changed in what the tracker does (#165).

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
   Rewritten with its "never" claim as "An eBay watch, and a BGG one made while the bot has no BGG
   token, get their listings only this way" (the audit's wording: a `bgg` watch made while the token
   was set, and later left without it, is no inbox watch and gets no listings at all, docket-types'
   `wantlist.js:107`).
3. **The six user-facing strings that said "I never open/read eBay" (or BGG's pages) are scoped to
   the watch** (orchestrator's call, 2026-10-11, in place of step 3's stop-and-report: the owner's
   decision to allow `/price` on eBay makes the bot's unqualified "I never open eBay" false). Wording
   only, in the bot's own voice, each string's meaning and what it tells the person to do unchanged:
   `want.ts:59` `EBAY_PAGE` ("A want-list watch never opens eBay's pages."), `want.ts:151` and
   `want.ts:158` (an inbox watch's confirmation: "This watch never opens eBay itself.", "this watch
   never opens BGG's pages itself"), `discord.ts:374` (`/want`'s `source` choice, 60 of Discord's
   100 characters), `web/editor-pages.ts:118` (the want editor's help: "a watch never opens eBay"),
   `fetch.ts:185` (the refusal on a want-list page read: "which a want-list watch never reads").
   Tests updated: `fetch.test.ts:117` and `want-inbox.test.ts:55`; `want.test.ts:133` compares
   with `EBAY_PAGE` itself. So this child is no longer docs-only in the strict sense: the bot's
   words changed, not what it does. The CHANGELOG bullet above says so.
4. **The plan's inventory missed CHANGELOG 0.19.0, lines 85-86** ("Rod's choice: Clerk watches eBay
   and BoardGameGeek for what people want through listings sent in, never by reading either site
   itself"). Left in place under the plan's no-rewrite rule for released notes; the CHANGELOG bullet
   above now says that note, like 0.16.0's, meant the want-list watcher.
5. **The plan's title overclaims.** "only the want-list watcher never opens eBay" is false as
   written: reminders, renewals and the digest never open eBay either, since they open no page at
   all. The accurate form is "only the want-list watcher refuses eBay", which the README's `/price`
   row uses and the PR title will use. Commit 765b16c's body ("no user-facing string or behaviour
   changes") is superseded by the next commit, which changed the six replies (item 3); the PR body
   does not reuse it.
6. **Tests added, against the plan's Coverage ("no test, no mutation")**, at the audit's request:
   `tracked.test.ts` pins the owner's decision that `/price` tracks an eBay page (the page is read at
   once and on the poll tick, with no `NEVER_EBAY` directive on either read), and
   `want-inbox.test.ts` asserts the BGG inbox watch's changed clause ("this watch never opens BGG's
   pages itself"). The first was mutation-checked in a scratch worktree: making `startPrice` refuse
   an eBay host turns it red, and so does making `/price`'s preview send `NEVER_EBAY`. Also at the
   audit's request, the README's Page reads row gained one sentence on `NEVER_EBAY`, since the
   `/price` row points there, and `want.ts` names roshne's 2026-10-11 scoping beside Rod's rule.
