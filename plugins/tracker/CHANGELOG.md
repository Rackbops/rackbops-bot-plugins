# Changelog

## [0.17.0] - 2026-10-04

### Added

- **The model's look at new want-list listings** (#83; plan 5.4 and item 63, the rest of E9). A
  watch made while the model runner is set up is judged (the plugin's own `wantjudge` type,
  `src/wantjudge-type.ts`, on the execute lane): the page or BGG is still read in plain code, and
  only when that read finds listings it has not told you of does one `claude -p` Job run, through
  the queue and the runner on the subscription. For each listing the model says whether it is the
  thing you want (`match`, `maybe`, or `no` for an accessory, another product, a replica, parts),
  why, in one sentence, and what the listing's own page shows about the seller and the offer --
  ratings, sales, returns, where it ships from, anything that looks wrong -- as signals, never a
  verdict about a person. The DM lists the listings worth a look, best first, each with that note;
  the ones it calls `no` are not DMed but are kept as findings with the verdict, so
  `/task history` shows them. The Job may open only the listings' pages on the watch's own site
  (`WebFetch` scoped to the pasted page's host, or BGG's; never eBay's, never a host a listing
  merely names) and may not search the web; 12 turns, 0.50 USD, 5 minutes a look
  (proposed, like the scout's caps). A look that fails for good sends the listings unchecked, so an
  alert never waits on the model past its retry.
- `/want judge:` (yes or no; the web form's and the task API's `judge`, `"yes"` or `"no"`): left
  out, a watch is judged whenever the model runner is set up; `judge: false` makes a plain watch as
  before; `judge: true` without the runner is refused. Fixed once made: to change it, make a new
  watch. Watches made before 0.17.0 stay plain.
- A judged watch's plain-code reads are not charged; its looks are, like any model run, and while
  its owner is at a daily ceiling (with the budgets on) or the runner is down, the watch waits.
- **The Discord-role check** (plan 1.1 and 5.5, item 46). `TRACKER_GUILD_ROLES` (new, optional):
  comma-separated `serverId:roleId` pairs. In a server named there, a member passes the membership
  gate only while they hold one of its roles, read off the same forced single-member lookup the
  gate already makes (no privileged intent); a `TRACKER_GUILD_ID` server not named stays
  membership-only, and every server named must be in `TRACKER_GUILD_ID` or the plugin refuses to
  load. The `TRACKER_ADMIN_DISCORD_IDS` admins skip the role, never the membership. Lacking the role
  is exactly like leaving the server: commands, buttons, `/allow` and `/task share` refuse, the web area and API
  tokens sign out and revoke on their next re-check, and the person's tasks, history and DMs stay.
  When none of a server's named roles exists there, the answer is a logged unknown (refused, never
  a no); a server's own id (@everyone) refuses to load. Unset = as before.

### Changed

- The refusals that said "not a member of this tracker's server" now also name the role.

## [0.16.0] - 2026-10-04

### Added

- **The want-list watcher** (#83; plan E9, category 2 of plan 1.2). `/want name source [target]
  [max] [currency] [hours]` watches for one wanted thing until you have it. `source: page` reads a
  shop's listing or search page you paste (roshne, 2026-10-04, "Pages too"), through the same
  fenced Fetch port as `/price`, and only its structured data: JSON-LD `ItemList`s of products and
  standalone `Product`s, with name, address, price, currency, condition and seller. The page is
  read once at once, and nothing is made unless it lists something. `source: bgg` reads a
  BoardGameGeek game's marketplace through BGG's XML API with `TRACKER_BGG_TOKEN` (new, secret),
  only while that is set: BGG has not approved the application yet, so the parser runs on a
  hand-written fixture until a real response can be captured. `source: ebay` makes nothing: the
  answer is an eBay search, with the top price in it, and how to save it on eBay, whose own alerts
  do the watching; the tracker never reads eBay, and an eBay page is refused as a `page`.
- Each watch runs on the `poll` tick every `hours` (default 12 for a page, 24 for BGG), with no
  model, and DMs each listing within the limits that it has not DMed before -- up to 5 lines, the
  rest in `/task history` -- with a Done button that ends the watch; each listing DMed is a
  finding, and the newest 500 are remembered. A listing over the top price is not remembered, so
  it is sent once it drops under. Three reads in a row with nothing tell the owner once (BGG
  refusing the token, at once). At most 20 watches per person. The web editor (`/new/wantlist`,
  Edit: name, top price, currency, hours) and the task API (`type: "wantlist"`) take the same
  fields by the same rules.
- Fences for it: a page read with the watcher refuses eBay on every redirect hop, not only the
  pasted address; the BGG read follows no redirect at all, and the fenced Fetch port never carries
  a caller's `Authorization` (or cookie) to another origin; the BGG parser looks for each
  listing's tags only inside that listing, so a hostile 3 MB answer parses in linear time; a BGG read due
  within 5 s of the last (or while one is in flight) is put back for the next tick rather than
  waited on, so many BGG watches cannot hold the poll tick; at most 20 new listings a run; shop text in a DM has any address in it broken, so only the
  listing's own link is a link; per-view query parameters (`utm_*`, Shopify's `_pos`/`_sid`/`_ss`,
  `srsltid`, click ids) are dropped from a listing's address, so it keeps one id. A search page
  whose list is empty is a search with no results, not a miss. A watch whose source cannot be read
  at all (BGG refusing the token) tells the owner once per run of misses.
- The task API answers `409 limit_reached` at the watch cap and `503` for BGG while it is off,
  takes `max: null` on a watch's `PATCH` to clear the top price, and leaves an unset number out of a
  task's `settings` instead of showing 0.
- The wantlist type is defined in this plugin (`src/wantlist-type.ts`), as the scout's is. The
  model's judgment of new candidates and sellers (plan 5.4) is a later piece.

### Fixed

- `/scout new` with `for` or `notes` set to `-` now leaves it empty, as `/scout edit` does,
  rather than storing a dash.

### Schema

- No migration. Still at 7.

## [0.15.0] - 2026-10-04

### Added

- **The interest scout** (#83; plan E9, category 1 of plan 1.2). `/scout new interests [lens]
  [for] [notes] [every]` makes a scout that runs every `every` days (default 1, at most 30) at the
  owner's preferred hour: one `claude -p` Job on the execute lane, through the queue and the
  runner like research, which looks on the web for 5 to 10 things published or available in the
  last 30 days that fit the interests through a gift lens -- `general`, `birthday` (fun or a
  little grandiose), `anniversary` (a romantic angle) or `christmas` (tied to their interests),
  the requirement's own nuances -- and DMs them, each with its page, why it fits and a price if
  shown; fewer than five come with the run's reason, never padding (plan item 60). The prompt,
  schema and caps are the web-search spike's scout case: 30 turns, 1.50 USD, 10 minutes (item 61,
  proposed). A link it showed is not shown again: the task's state keeps a digest of each item's URL
  (the newest 300), the next prompt names the latest 40, and a repeat is dropped from the DM
  whatever the model returns; each item shown is a finding, keyed by the same digest. Tier 0
  only (`notify`); model output is cleaned before it reaches a DM or a finding, and an item
  without an http(s) URL is dropped. A failed run is retried once (an `auth_failed` one an hour
  later; `turn_cap` and `budget_cap` not at all); one that fails for good says so in one
  DM, and the scout goes on to its next run. At most 3 scouts per person. Off, with `/scout`
  saying so, while the execute lane is not configured.
- **`/scout edit task ...`** changes a scout's interests (the whole list), lens, who it is for,
  notes or days between runs; the web editor (`/new/scout`, Edit) and the task API (`POST
  /tasks` with `type: "scout"`, `PATCH`) take the same fields by the same rules. A scout is the
  first execute-lane task that is edited in place, and the first on a recurring schedule:
  `/settings hour` moves it with the owner's reminders.
- The scout type is defined in this plugin (`src/scout-type.ts`), since docket-types 0.5.0 has
  none; giving it back to Rackbops/docket is a follow-up.

### Schema

- No migration. Still at 7.

## [0.14.1] - 2026-10-04

### Fixed

- **`/research` refuses a stray question** (#82). A `question` shorter than 3 characters, or with
  no letter in it, is refused before any task is made, with the same words from Discord, the web
  editor and the task API: "Put the whole question in `question`: it needs at least 3 characters,
  with a letter in it. `context` is only for background." Found live: on Clerk, task t2
  (2026-10-04) went in with `0` as its question and the real question in `context`, so the reply
  echoed "queued: 0" while the run answered the question in `context`. roshne chose to add the
  guard ("Add the guard", 2026-10-04).

### Schema

- No migration. Still at 7.

## [0.14.0] - 2026-10-02

### Added

- **Budgets off for the alpha** (#82; plan 5.7). roshne, 2026-10-02, choosing option A: "A.  but
  lets build in an unlimited budget "flag" during alpha, evaluate usage during alpha, then test
  budgets during beta."
  A new operator setting, `TRACKER_BUDGET_UNLIMITED`: `true` or `1` turns it on, bot-wide; unset, empty,
  `false` or `0` is off (the default, so nothing changes unless it is set); anything else refuses to
  load, naming it. On, the execute lane hands docket's `budgetHold` a policy with no ceiling of
  either kind (`BudgetLimits` null, docket-core 0.5.0), so neither a person's daily ceiling nor the
  global one holds a run, and no ceiling notice goes out. Each Job's own caps (research: 15 turns,
  1 USD) are unchanged, and every run is still charged to the `usage` table. The bot logs one line
  at start saying budgets are off (or, when the execute lane is not configured, that the flag is
  set but no model work runs); the admin's People and Usage pages carry a "Budgets off (alpha):
  unlimited" banner; the person page's ceiling section says the ceiling is not enforced, and its
  form still records a raise or a reset (its answer says the same). Proposed defaults, reversible:
  the switch is bot-wide, not per person, and an operator env var, not a web toggle.
- **`/admin/usage`**, an admin-only, read-only page linked from every admin page: model spend per
  budget day for the last 14 days, newest first -- dollars and calls in all and per person -- each
  measured against the default ceilings (2 USD / 20 calls a person, 10 USD / 100 calls in all, not
  a person's raise): a "would have hit the ... limit" marker on a day that reached one, and how
  many calls were charged after it had (roughly what the ceiling would have held). A non-admin gets
  the unknown page's 404, as on every admin route.

### Schema

- No migration: the page reads the `usage` table docket already writes. Still at 7.

## [0.13.0] - 2026-10-01

### Added

- An admin raises a person's daily model ceiling from the web area (#82; plan 5.7, "The admin
  raises a person's ceiling from the web area (5.10)"). A person's admin page gains a Daily model
  budget section: what they spent today, their ceiling now, a form for both numbers (dollars to the
  cent, whole model calls), **Back to the default**, and the latest 20 changes, newest first (older
  ones stay in the table). Proposed on #82 for roshne to confirm, not decided: **a raise stands
  until an admin changes it** (reversible: a today-only raise is a small change -- `limitsOf` and
  `isRaised` plus a clock in `Ceilings`, and the page's badge), and **the bounds**, at least the
  default 2 USD / 20 calls and at most the global 10 USD / 100. Setting exactly the default is a
  reset to it, not a raise. The execute lane's budget is now docket's defaults plus `personFor`,
  which reads the person's newest change before every run, so a held request runs on the next tick
  after a raise; the global ceiling is still checked first. Every change -- raise or reset -- also
  deletes that person's `budget:person:<id>:<day>` notice key for the current budget day, in the
  same transaction, so meeting the new ceiling the same day tells the person and the admins again
  (plan 5.7: "nothing fails silently"). Every change is an append-only row and a log line.
  `POST /admin/people/<id>/ceiling` is admin only, behind the session, `Origin` and CSRF checks of
  every admin act; a non-admin gets the unknown page's 404.
- Forget-me deletes the person's ceiling changes, and a change they made to someone else's ceiling
  keeps its row with `set_by` = `forgotten`.

### Schema

- **Migration 7, purely additive**: one new table, `ceiling_changes` (`user_id`, `usd`, `calls`,
  `set_by`, `at`; both values null = back to the default, a `CHECK` keeps them together), and its
  index `ceiling_changes_user`. No existing table, column or row changes. A database at 7 is
  refused by 0.12.0 and older (their `migrate` throws on a newer schema), so a rollback past 0.13.0
  needs the database from before the upgrade.

## [0.12.0] - 2026-10-01

### Added

- A research request from the web editor and the JSON task API (#82). `/new/research` takes
  `/research`'s options -- the question, an optional context, deadline and start, in `/research`'s
  words -- and makes the request through the same function, so the same limits, the cap of 5
  waiting per person (counted across Discord, the web and the API) and the daily budget apply. My
  tasks links to it only while research is available; without the city-hall Executor the page says
  research is not available instead of showing a form, and a post makes nothing. `POST
  /api/v1/tasks` takes `type: "research"` with `question`, `context`, `deadline` and `at`, and
  answers `503 unavailable` in `/research`'s words while research is not available. A research
  request is never edited, as in Discord: its page has Pause, Resume and Delete but no Edit, and a
  `PATCH` of one answers `409 conflict`. Making one only queues its run; nothing reaches city-hall
  until the execute tick.
- `GET /api/v1/types` lists `research` while it is available, and gives every type an `editable`
  flag (false for research, whose `edit` is empty). A research request read over the API carries
  what was asked in `settings` (`question`, and `context` and `deadline` when given), to its owner
  only.

### Changed

- The task API answers `409 busy`, not `400 invalid`, for a task the execute tick holds ("That task
  is with the model runner right now"), as it does for a price page still being read.

## [0.11.0] - 2026-10-01

### Added

- `/research question [context] [deadline] [at]`: a one-off research request (docket's `research`
  type, plan category 5). A research run looks it up on the web, a reviewer run checks the draft
  against its sources, and only a passed answer is DMed to the owner and accepted recipients; its
  claims are kept as findings. `at` becomes the `once` schedule (default now), `deadline` goes into
  the request as an instant (a run past it makes no call and says so). At most 5 waiting per
  person. Research DMs go out with no allowed mentions, as every host DM does.
- The city-hall Executor (`src/executor.ts`): docket's Executor port as a city-hall source, on
  Lepid-Labs/city-hall#18's proposed `POST /api/execute/jobs` and `GET /api/execute/jobs/:id` (not
  agreed by Nazu; it may change). Each Job is submitted with the configured capability tag under a
  prefixed key, `rackbops-tracker:<database id>:<docket's Job key>`: the database id is random,
  made once and kept in `tracker_meta`, so two tracker databases never collide at city-hall. A
  `200` for a key city-hall already knew must hold this Job's prompt, or the run is refused (a
  plain error) and the mismatch logged. city-hall's job id is kept in the tracker's own
  `executor_jobs` table before the first answer, so a Job out is found again by key; if that write
  fails the run is held and asked again under the same key, and city-hall hands back the same job.
  Queued or running is pending; done is the runner's result; failed is its result or an `error`
  result; unreachable, a timeout, a 5xx, a 429, a redirect, a refused credential (logged once an
  hour, and the admins told once per Job) or an answer that is not a job holds the run and asks
  again. A queued job whose last claim ended in `usage_limit`, `auth_failed` or an expired lease
  (city-hall requeues those; read from `job.lastOutcome`, city-hall#18 at 2ba40d3, else the last of
  `runs`) holds the run too, never given up after six hours while the runner is paused: logged once
  an hour per Job, naming the outcome, and the admins told once per Job and outcome. Once a Job has
  been seen paused (`executor_jobs.paused_at`), every unfinished answer for it stays held, so a
  runner resuming after six hours is collected rather than given up and run again; the hold is
  capped at 48 hours from the first sight (a judgement), after which docket's give-up applies and
  the admins are told once. A record in `executor_jobs` goes once its run is gone, or once it was
  submitted over 30 days ago and its run is no longer queued or running. Never logs the source
  key, the prompt or the result.
- The execute lane (`src/execute-lane.ts`): a third host tick, `execute`, only when the Executor is
  configured. It starts docket's `tickExecute` in the background (one at a time, at most once a
  minute) over every task with a due execute-lane run, through one docket `Lanes` kept while the
  plugin is active (so docket's usage-limit pause holds across ticks), reserving those tasks and
  holding their locks in id order. The notify tick leaves a task it holds for the next tick, and a
  command, button or web action on one answers "That task is with the model runner right now; try
  again in a minute." at once, so neither a reminder nor anyone's command waits on city-hall. No
  execute tick starts while forget-me runs. Budgets are docket's defaults (2 USD and 20 calls a person a day, 10 USD and 100 in
  all), with one DM to the person and the admins at a ceiling.
- Settings `TRACKER_CITY_HALL_URL`, `TRACKER_CITY_HALL_KEY` (secret),
  `TRACKER_CITY_HALL_CAPABILITY` and the optional Cloudflare Access pair
  `TRACKER_CITY_HALL_ACCESS_CLIENT_ID` (secret) / `TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET`
  (secret). The execute lane and `/research` stay off until the first three are all set; a partial
  set is logged, a malformed value refuses to load. There is no default capability. Research
  requests made while it was on stay queued (and count toward the 5 waiting) if it is turned off.
- Findings on a task's page (owner, accepted recipients, admins, through docket's
  `visibleFindings`): each claim with its source as a `rel="noopener noreferrer nofollow"` link and
  its date, all escaped; in `/task history`; and in the task API's `GET /tasks/<id>` as a new
  `findings` array (additive).

### Changed

- Adopts `@rackbops/docket-core` and `@rackbops/docket-types` 0.5.0 (their README's "Adopting
  0.5.0"). Schema 6, all additive: a `findings` table (indexed by task and by owner, `key` unique
  when set), a nullable `usage.key` unique when set (a charge keyed by its Job is stored once), and
  `executor_jobs` (with `paused_at`). The store implements `addFinding`, `listFindings` and `deleteFindings` and the
  keyed `addUsage`, and passes 0.5.0's `STORE_CONTRACT`. A database at 6 is refused by 0.10.0 and
  older.
- Forget-me also erases the findings of the person's tasks and the Executor's records of their
  runs' Jobs (no tombstone kept); city-hall's own copy of a Job (its spec and result) is under
  city-hall's retention and is not reached.
- A config error for `TRACKER_WEB_URL` or `TRACKER_CITY_HALL_URL` no longer echoes the value; one
  with credentials in it says "must not contain credentials".
- A schedule edit is refused with a plain answer when docket would refuse it (a `once` task whose
  run is with the runner), before anything is written; an edit that keeps a run in flight says
  so. No editable type has an execute-lane run today, so this is a guard.

## [0.10.0] - 2026-10-01

### Added

- The admin view's Deliveries page, `/admin/deliveries`, linked from every admin page: the DMs that
  settled `failed`, `unconfirmed` or `deferred` in the last 30 days, newest first, at most 200 rows
  (it says how many matched when the bound cuts the list). Each row shows the task (title linking
  to its page, id and owner), the run's due time, the recipient (linking to their admin page), the
  status, attempts and deferrals, the error text, and when it settled. Until now such a DM showed
  only in the bot log. Admins only, through the same gate as the other admin pages: anyone else
  gets the unknown page's 404. Read-only: no form, nothing changes on it. One SQL read over docket's
  `deliveries` table with each row's run and task (`Roster.undelivered`), since the Store port's
  `listDeliveries` takes neither a window nor a bound.

## [0.9.0] - 2026-09-30

### Changed

- Adopts `@rackbops/docket-core` and `@rackbops/docket-types` 0.4.0 (their README's "Adopting
  0.4.0"). Delivery moves into docket: it claims each (run, person) in the store's `deliveries`
  before the DM and settles it after, retries a DM that can be retried (three tries, a minute apart
  and doubling), and never resends one whose outcome is unknown (unconfirmed, logged as a warning).
  The tracker's own claim table and its claim logic (`src/claims.ts`) are gone.
- The notifier maps the host's answers to docket's errors: cannot be messaged (Discord 50007), an
  unknown user, or a person with no user row or Discord id is `DeliveryFailedError(msg, true)`
  (failed for good), replacing `RecipientUnreachableError`; a message the host refuses for its
  content is a plain `DeliveryFailedError` (retried); a person whose delivery is paused is
  `ExecutorUnavailableError` (deferred until the resume); anything else is left to docket, which
  settles it unconfirmed.
- A run whose DM failed is now `done`, not `failed`: a run fires once its record is written, and its
  other recipients still get their copies. A run missed while its task was paused for failed DMs
  now fires late on resume, as a run missed under a hand pause already did.
- Pause after three failed DMs counts once per run per person, a DM the host says cannot reach
  them (50007, as before) and now also Discord's unknown user (10013), so the owner of a task hears
  when a recipient's account is gone. A retried, deferred or unconfirmed DM does not count. A
  failure to record the count is logged and never replaces the send's own error.
- An invitation that cannot be delivered says why by cause: "their DMs are closed, or they
  blocked the bot" only for 50007, "I can't reach them on Discord" otherwise.
- Answering a run (`/task done`, `/task snooze`, `/task decide`, the buttons, Reply) finds the
  latest run that has fired, including one still owed to a recipient; a fired run still finishing
  answers docket's "still finishing" message. The editor's "next run", the API's `nextAt` and a
  zone or hour change skip a run that has already fired.
- One task at a time (`src/locks.ts`): a task's runs, its answers and its edits (the editor, pause,
  resume, delete, a zone or hour change) take that task's lock. The notify and poll ticks run one
  pass of docket's `tickNotify` per task with work, each under its lock, through a view of the store
  limited to that task.
- At start the plugin runs docket's `recover()`: a run left running is requeued (its start cleared),
  and a delivery claim left open is settled unconfirmed and logged, never resent.
- Delete drops the task's queued runs that have not fired, one at a time with the Store's
  `deleteOccurrence`. A run that fired and was put back to finish is kept for docket to finish, and
  docket ends what it still owed unsent, as for any archived task: nothing more is sent.
- Forget-me also erases, through docket's `deleteDeliveries` and on the person's own tasks, every
  delivery row, the charges (`usage`) made for them or on their tasks, and the budget notices kept
  for them.
- `/register`'s reply is docket's `registrationText`.

### Removed

- The Store's `findUserBySubject`, `usrSubject` and `deleteQueuedOccurrences` (docket 0.4.0 took
  them out of the port).

### Migration

- Schema 5. `occurrences.record` (a run's record once fired) and `series.key` (unique when set)
  are added; `deliveries`, `usage` and `notices` are created; `delivery_claims` is copied into
  `deliveries` and dropped -- sent stays sent, failed stays failed (one attempt), a reported
  unconfirmed stays unconfirmed; a claim never settled, and an unconfirmed one 0.8.0 never
  reported, stay claimed, so the first start's `recover()` settles each unconfirmed and logs it
  once; none is owed, so no DM of before the upgrade is sent again;
  `users.usr_subject` and its index are dropped. A rollback to 0.8.0 needs a backup from before the
  upgrade: 0.8.0 does not open a schema 5 database.

## [0.8.0] - 2026-09-30

### Added

- `TRACKER_GUILD_ID` takes a comma-separated list of Discord server ids as well as one
  (rackbops-bot-plugins#106), so one tracker can serve more than one server: a member of any listed
  server passes the membership gate. Every place that checks membership follows -- commands and
  buttons, `/web`'s link, `/allow` (Discord and the admin page), the web session's re-check and the
  API token's. The servers are asked at once (one single-member lookup each, `force: true` as
  before), and the first yes answers at once, so a slow server cannot hold up a member of another. A yes from any server is a member; a no
  from every server is not, and only that signs a person out and revokes their API tokens; a no
  from one server and a failed lookup on another is unknown, which refuses without revoking, so an
  outage on one server cannot sign out its members. Inside a listed server, the person running a
  command needs no lookup, as before. Spaces around commas are allowed and a repeated id counts
  once; a malformed or empty entry anywhere in the list (a trailing comma included) refuses to load,
  naming it. A single id loads and behaves exactly as before, so an existing setting needs no change.
  One store and one admission list serve every listed server; there are no per-server admins.
  No schema change: a rollback to 0.7.0 is safe, as long as the setting is set back to one id first
  (0.7.0 refuses to load a list).

## [0.7.0] - 2026-09-30

### Added

- The JSON task API (rackbops-bot-plugins#80, slice 4; plan 5.10, E5): "the tracker's task API that
  a later intake agent (E10, deferred) would use", under `/tracker/api/v1/` when `TRACKER_WEB_URL` is
  set. `GET /me`, `GET /types` (each type's create and edit fields -- the tracker's editor fields,
  not docket-core's `IntakeSpec`), `GET /tasks`, `POST /tasks`, `GET /tasks/<id>` (with its
  history), `PATCH /tasks/<id>`, `POST /tasks/<id>/pause` and `/resume`, and `DELETE /tasks/<id>`,
  over the token owner's own
  reminders, renewals and price trackers. Every write runs through the web editor's own calls, fed
  the same fields read the same way (`src/web/form-input.ts`), in the same write queue: the same
  defaults, limits, caps (200 live tasks, 20 price trackers, counted wherever made) and messages.
  JSON bodies only (`415` otherwise), at most 16 KiB, one object, only the type's fields; errors are
  `{"error": {"code", "message"}}`. Anyone else's task -- one shared with the owner, or any task to
  an admin's token -- answers exactly as an unknown id (`404`). No CORS header ever, and a request
  carrying an `Origin` header is refused (`403`): the API is for programs, not browser pages. The
  README documents every endpoint, the errors and examples.
- Personal API tokens, the API's only authentication (`Authorization: Bearer trk_...`); the session
  cookie is never read by the API, since every plugin shares one browser origin. Made and revoked on
  the web area's new `/tokens` page (linked from Settings): named, expiring in 30, 90 (the default)
  or 365 days (always), stored only as a SHA-256, with made, last-used (written at most once a
  minute) and expiry times; at most 10 live per person, and at most 10 made per person per rolling
  hour, revoked ones counted (in memory), so making and revoking cannot flood anyone's DMs.
  The secret is sent once by Discord DM and
  never appears in a web response, so another plugin's script on the shared origin cannot read one
  off the page; a token whose DM fails is deleted at once and the page says so. An admin sees a
  person's tokens on their admin page and revokes any of them. A token acts as its owner, on the
  owner's own tasks only; every request re-reads the owner
  (gone or no longer registered: `401`, and their tokens are deleted) and, with `TRACKER_GUILD_ID`,
  re-checks membership on the web's schedule. A per-token rate limit: 60 at once, then one a second
  (`429` with `Retry-After`); requests with a token that does not look up share one global bucket of
  30, then one every two seconds. The log names a token by its id (`k1`), never its secret.

### Changed

- **Schema 4** (migration 4 adds the `api_tokens` table). **This blocks a rollback to 0.6.0 or
  older**: their `migrate` refuses a database at a schema newer than they know, so the plugin would
  not activate. To roll back, stop the bot first, then restore a backup taken before 0.7.0 --
  `tracker.sqlite` together with its `tracker.sqlite-wal` and `tracker.sqlite-shm` from the same
  backup (a main file with another moment's write-ahead log is corrupt or silently wrong). Or,
  knowing that it drops every API token, with the bot stopped delete the `api_tokens` table and set
  `PRAGMA user_version = 3`.
- Forget-me also erases the person's API tokens (the schema-coverage test includes the new table).
- One who has left the `TRACKER_GUILD_ID` server loses every API token as well as every session,
  whether the web or the API found it; a membership lookup that keeps failing ends the web session
  after 24 hours as before, but only refuses the API (`503`) and keeps the tokens.
- One new price tracker's page read in flight per person is now shared by the web editor and the API.
- Internal: the editor's form readers moved to `src/web/form-input.ts`, and its writes
  (`makeTask`, `saveEdit`, `actOn`) are exported for the API; behaviour unchanged.

## [0.6.0] - 2026-09-30

### Added

- The web area's admin view (rackbops-bot-plugins#80, slice 3; plan 5.8, 5.10), for tracker admins
  only -- the admin flag in the tracker's store, the one admin definition `/allow` already checks:
  - `/tracker/admin`: everyone on the list (registered or only admitted, zone and hour, delivery on
    or paused, tasks owned by status and received), who admitted each, the decline blocks in force,
    and a form to allow a person by Discord id. `/tracker/admin/tasks`: every task with its owner,
    status and recipients. `/tracker/admin/people/<id>`: one person and their tasks. Any task's page
    and history is readable by an admin (it already was, through `/tracker/tasks/<id>`), now with who
    owns it; an admin still cannot edit, pause or delete someone else's task.
  - Admin acts, each through the function the command path runs: allow (`/allow`'s `allowPerson`,
    with its membership check), make or revoke an admin (never the last one), resume a person's
    delivery paused after failed DMs (`DeliveryHealth.resume`, what their own next command does), lift
    a decline block (docket's `liftBlock`), and remove a person (forget-me, below).
  - The admin flag is read from the store on every request and again in the write queue before every
    act: an admin whose flag is revoked is refused on their next request. To a signed-in non-admin
    every `/tracker/admin` path, any method, answers the unknown page's 404, byte for byte; a visitor
    who is not signed in is redirected to sign in, as on every signed-in path.
  - An admin named in `TRACKER_ADMIN_DISCORD_IDS` (made admin again at every start) cannot be revoked
    or removed from the web: their page says to take them out of the configuration first. Forgetting
    themselves is allowed, with a note that the next start makes them again unless the configuration
    no longer names them.
- Forget-me (plan 5.8): `/tracker/forget`, linked from Settings -- a page, then a post that asks,
  then a post with `confirm=yes` and the typed word `forget`. In one transaction it deletes (not
  archives) the person's tasks, archived ones included, and everything under them; their recipient
  rows, replies, history rows and delivery records on everyone else's tasks; the decline blocks they
  are either side of; their admission, delivery health, sessions and sign-in links; and their person
  row. Another owner's task paused only for them goes back on. Other people's audit columns that
  named them (`admitted_by`, `lifted_by`) become `forgotten`. Text is matched only in the forms the
  code writes ids into, never as any id-like word; their id in another owner's run error is redacted,
  not the row deleted. A pause row from before 0.6.0 (it names the display name) is deleted only on a
  task they received where no other recipient has the same name; one under an older name is kept. They are signed out everywhere and the cookie is cleared; they can come back
  only when an admin allows them again, as a new person with a new id. An admin can remove a person
  the same way, with the same confirmation. Web only: the plan asks for no Discord command.
- The nav shows Admin to admins.

### Changed

- The database now runs with `PRAGMA secure_delete = ON`, so a deleted row's bytes are overwritten.
  The first start on an existing database runs one `VACUUM`, so pages freed before `secure_delete`
  was on are rewritten too. It is recorded in a `tracker_meta` table, not a schema bump -- the schema
  stays at 3, so a rollback to 0.5.0 still opens the database. A VACUUM that fails (a reader holds
  the file) is logged as a warning without failing activation, and retried at the next start. The write-ahead log is checkpointed after an
  erasure without waiting on readers; a busy checkpoint is logged.
- A pause for a recipient is recorded by their id (`delivery to {u5} paused: ...`) and shown with the
  name they have when the history is read, instead of the name they had when it was written.
- Forget-me waits, outside the write queue, until no notify or poll tick is running (at most 20 s,
  then 503 and nothing deleted), so a DM already in flight to the person is not recorded after they
  are gone and nobody else's command waits behind it. A failed DM to a person no longer in the store
  (an invitation's, sent outside any tick) no longer counts toward a pause or writes a row; an
  invitation whose DM comes back after its task or invitee was erased writes nothing; a `/price`
  whose page read finishes after its person was forgotten makes nothing.
- Internal: `DeliveryHealth` exposes its lock (`exclusive`) and `release` for the erasure; docket's
  Store port has no delete, so listing people and blocks and erasing a person are plain SQL in the
  plugin (`src/roster.ts`); docket is unchanged.

## [0.5.0] - 2026-09-29

### Added

- The web area's task editor (rackbops-bot-plugins#80, slice 2, plan 5.10): a signed-in person makes,
  edits, pauses, resumes and deletes their own reminders, renewals and price trackers from the web
  pages, under the rules the commands enforce -- the same functions run both.
  - New: `/tracker/new/reminder`, `/new/renewal` and `/new/price`, linked from My tasks, with the
    options of `/remind`, `/renewal` and `/price` and their defaults, limits and messages (a price's
    page is read once before anything is made; at most 20 price trackers per person, counting the
    ones made in Discord; `near` becomes the same bounded pattern). One new price tracker's page
    read at a time per person on the web, which has no Discord rate limit in front of it.
  - Edit: `/tracker/tasks/<id>/edit`. A reminder's text, time and repeat (an empty time keeps the
    one it has, unless the repeat changes); a renewal's name, amount, currency, date, unit, every,
    lead and note (a new amount replaces the one the next ask quotes; a new date gets `/renewal`'s
    first-ask rule, but a date a run already asked about is not asked about again); a price's name, interval, drop and
    baseline -- not its page, since another page is another tracker. A schedule change cancels and
    replaces what is queued, keeping snoozes, as a zone or hour move does; a changed title or config
    is one `edited` event; nothing changed writes nothing. A field left empty (or not sent) keeps
    what the task has -- an empty note clears it, and an empty price name goes back to the page's
    address. A renewal date that is one of the schedule's own period dates (as the form offers once
    the first date has passed) keeps the stored schedule and its anchor, so a monthly renewal on the
    31st stays on the 31st; only a different date re-anchors. A finished task cannot be edited.
  - Pause and Resume on a task's page. A task the owner paused sends nothing until resumed, and a
    person's delivery resuming does not un-pause it; resuming gives it its next run (a run missed
    while paused fires once, late). A zone or preferred-hour change re-times a paused task's held run
    -- the same occurrence (period date, or local day) at the new zone or hour, still one run, snoozes
    kept -- so resume fires it once, late, never at the old time and never lost. Resume on a task paused for failed DMs goes on without the
    recipients who could not be DMed, as `/task resume` does.
  - Delete takes two posts: the first shows what will happen, the second (with `confirm=yes`)
    archives the task. It leaves every list, its queued runs are dropped and nothing more is sent;
    its history stays on record (an admin can see every task) and its page stays for the owner. The
    store has no way to erase a task; that is forget-me's, later.
  - Every editor post goes through the same gates as settings: the session (re-checked, with the
    membership re-check), the per-session CSRF token and the `Origin` check. The task is loaded by
    its id and must be the viewer's own, checked again in the write queue; anyone else's task, an
    admin's view of one included, answers the same 404 as an unknown id. A refused form comes back
    with what was typed, escaped, and the reason. Only fixed notices are shown after an action;
    nothing from the address is echoed. No GET changes anything.
- `/task resume` also resumes a task its owner paused on the web (before, it answered that the task
  was not paused by failed DMs).

### Changed

- A form body may now be up to 32 KiB (was 8 KiB), so the longest reminder fits in any script; a
  declared `Content-Length` over it is refused unread, and a body is read only up to the cap.
- The price cap's message says a tracker can also be deleted on the web, when the web area is set up.
- At most 200 active or paused tasks per person, of every type together (`MAX_LIVE_TASKS`), checked
  when a reminder, renewal or price tracker is made, in Discord and on the web alike.
- One set of length limits (`src/limits.ts`) for the slash options, the web forms' `maxlength` and
  the server's own checks: a price's page (1000), a `when` or `until` (100), a name (100), a note
  (300), `near` (100), a reminder's text (1500), a currency (3), a zone (64). The server now checks
  the page's length and the `when`/`until` length itself, not only Discord.
- A `/settings` or `/register` zone or hour change also moves the recurring tasks the person has
  paused (by hand or for failed DMs), not only the active ones: the run each was holding is kept,
  re-timed for the same occurrence (`src/retime.ts`), so a renewal's due ask or a missed reminder
  still goes out once, late, on resume.
- Internal: `/remind`, `/renewal` and `/price` now run shared plan functions (`reminderPlan`,
  `renewalPlan`, `priceSettingsPlan`, `startPrice`/`previewPrice`/`finishPrice`) that the web
  editor runs too; the price tracker moved to `src/price.ts` and reminders to `src/reminders.ts`.
  A renewal's `unit` and a reminder's `repeat` are now checked against their choices there (Discord
  already offered only those). No schema change.

## [0.4.0] - 2026-09-29

### Added

- Renewals and the price tracker (rackbops-bot-plugins#81, plan E6): two more task types on the
  notify side, no model, nothing sent to city-hall.
- `/renewal name amount currency renews [unit] [every] [lead] [note]`: docket's `renewal` on a
  `period` schedule from the next renewal date, asking `lead` days before each (default 7) at the
  preferred hour, with Keep, Cancel, Renewed and Snooze. When that ask is already past but the date
  is not, the first ask comes within a minute. Keep and Renewed record what was paid; Cancel ends it.
- `/task decide task choice [amount]`: answers a renewal's latest ask with the amount actually paid,
  instead of a button.
- `/price url [name] [hours] [drop] [baseline] [near]`: docket's `price` on a `poll` schedule every
  `hours` (default 12, at most 168). The page is read once before anything is created, and nothing is
  created without a price in it; a drop of `drop`% (default 10) from the last, first or highest price
  seen DMs the owner once per crossing. `near` (the words before the price) stands in for a
  free-form pattern. At most 20 per person.
- `/task history` shows a renewal's paid periods and total, and a price's last check, readings, low
  and high.
- Page reads (`fetch.ts`) go only to the public internet: http or https on the default port, no
  credentials, every resolved address public, redirects re-checked (at most 5), 15 s, 3 MB. The body
  is rebuilt in linear time to what price extraction reads (`page.ts`), since docket's extraction
  patterns take quadratic time on a page of unclosed tags.
- A second host tick, `poll`, runs the page readers after `notify`, so a slow page never holds up a
  reminder due now. A read the tick's abort cuts short requeues its run instead of counting a miss.
  No schema change.

## [0.3.0] - 2026-09-29

### Added

- The web area's first slice (rackbops-bot-plugins#80, plan 5.10), served under `/tracker/` on
  the bot's HTTP through the instance's tunnel: my tasks (the same list as `/tasks`, each linking to
  its history), a task's history (the same data and the same rule as `/task history`: the owner, an
  accepted recipient or an admin; anyone else gets the same 404 as an unknown id), and settings
  (preferred hour and time zone, checked as `/register` checks them, recurring reminders moved
  with them). Server-rendered HTML, forms only, no script, styled with `@rackbops/styles`'
  rackbops-noir theme bundled into the plugin and served at a hashed path.
- `/web`: an ephemeral one-time sign-in link, through the usual gates, good for 10 minutes and one
  use. Opening the link never uses it up (a link preview cannot burn it); its page's Sign in button
  does, then sets a 7-day session cookie (`HttpOnly; Secure; SameSite=Lax; Path=/tracker/`) and
  redirects so the token leaves the address bar. Only SHA-256 hashes of link tokens and session
  ids are stored. Every request re-checks that the person is still on the tracker and registered,
  and signs them out everywhere when not. Every form post carries a per-session CSRF token, and a
  post whose `Origin` is not `TRACKER_WEB_URL` (or is `null`) is refused; the sign-in post carries
  its own double-submit token, so another site cannot sign a person in as someone else. Pages send
  `Referrer-Policy: same-origin` (under `no-referrer` a browser sends a form's `Origin` as `null`).
- With `TRACKER_GUILD_ID` set, the web area re-checks membership: a session last confirmed 15
  minutes ago or more is checked with one member lookup (at most about 3 seconds), through the
  discord.js Client of an interaction the plugin has handled since start. Someone who left the
  server is signed out of every session; a lookup that fails, or no interaction yet, is allowed
  while the last confirmation is under 24 hours old, and signs them out after that. Concurrent
  requests share one lookup per person, and a person whose lookup failed is not looked up again
  for a minute.
- The README says to keep the web origin on a domain whose sibling subdomains are all yours: a
  sibling can set a `__Secure-` cookie on the parent domain, and `__Host-` cannot be used with
  `Path=/tracker/`.
- The new optional `TRACKER_WEB_URL` (not secret): the https origin the bot is reached at, e.g.
  `https://clerk.example.com`. Links and the allowed `Origin` come from it, never from the
  request's `Host` header. Unset = no web area: `/web` says so and the pages answer 404; a value
  that is not a bare https origin refuses to load.
- Schema 3: `web_login_tokens` and `web_sessions`. A 0.2.0 database migrates in place on first
  start. **Rolling back** to 0.2.0 afterwards does not work (0.2.0 refuses a newer database); keep
  a copy of `tracker.sqlite` from before the upgrade to roll back.

### Fixed

- The membership gate (`TRACKER_GUILD_ID`) asked discord.js's member cache rather than Discord:
  the member lookup now passes `force: true`. With only the Guilds intent the bot never hears that
  a member left, so someone who had once used the tracker in the server stayed a member forever
  when they used it from DMs (0.2.0's gate) -- and would have on the web.

## [0.2.0] - 2026-09-29

### Added

- The Discord surface (rackbops-bot-plugins#79, the first slice of plan E2): `/allow @user`
  (admins), `/register [hour] [zone]` with the disclosure that an admin can see every task,
  `/remind text [when] [repeat]` (a one-off, or daily, weekly or monthly), `/tasks`,
  `/task done|snooze|history|share|resume`, and `/settings hour`. Every answer is ephemeral, and the
  commands work in the bot's DMs as well as in a server.
- The admission gate (only people an admin has `/allow`ed, or the configured admins, can
  `/register`; everything else needs a registered person) and the membership gate: the new
  optional `TRACKER_GUILD_ID` names the one server whose members may use the tracker, checked on
  every command and button, DMs included. Unset = no membership gate.
- Buttons on every DM: done and snooze for the owner, accept and decline on the one consent DM a
  shared task sends, an opt-out on every copy a recipient gets, and a Reply button that opens a
  modal, so the tracker never reads a typed DM and never needs the Message Content intent. A
  pressed DM is edited to say what happened. A host from before rackbops-discord-bot#323 gets the
  DM again without buttons.
- Pausing delivery after three DMs in a row that the host says cannot be delivered (plan 5.5):
  every task that would DM the person pauses, on record in its history, and their other runs due
  in the same tick are held for the resume rather than failed. The owner of a task paused for a
  recipient is DMed once and sees why in `/tasks`; the task resumes when the recipient next uses
  the tracker, or `/task resume` goes on without them. A person paused for their own DMs is told,
  and resumed, the next time they use a command.
- Declining an invitation and opting out always work: those two buttons skip the membership and
  registration gates.
- Schema 2: `admissions` (who admitted each person, when they registered; the people 0.1.0 made
  from `TRACKER_ADMIN_DISCORD_IDS` are backfilled as admitted by the configuration),
  `delivery_health` and `delivery_pauses`. A 0.1.0 database migrates in place on first start.
  **Rolling back** to 0.1.0 afterwards does not work: 0.1.0 refuses a database newer than it knows
  and does not load. Keep a copy of `tracker.sqlite` from before the upgrade to roll back.

### Fixed

- A due run of a task that is not active (paused) is no longer run: docket 0.3.0's notify lane
  runs every queued occurrence whatever its task's status, so the tracker's lane now skips them.

## [0.1.0] - 2026-09-29

### Added

- The task tracker's core (rackbops-bot-plugins#78), the host of
  [`Rackbops/docket`](https://github.com/Rackbops/docket) (`@rackbops/docket-core` and
  `@rackbops/docket-types` 0.3.0, bundled): docket's Store port on `bun:sqlite` in
  `<dataDir>/tracker/tracker.sqlite`, passing docket's `STORE_CONTRACT`; the notify lane on the host's
  60-second tick, delivering by `host.dm`, with each delivery claimed before it is sent so a
  restart or an abandoned tick never sends one twice (a refusal before anything reaches Discord
  releases the claim); people (Discord id, time zone, preferred
  hour, admin flag) in the tracker's own store, the first admin from `TRACKER_ADMIN_DISCORD_IDS`;
  and `GET /tracker/healthz`, `503` once the last tick is more than three minutes old. Runs the
  `reminder` and `renewal` types only (`price` waits on the Fetch port). No commands yet (#79)
  and no buttons (they wait on rackbops-discord-bot#323).
