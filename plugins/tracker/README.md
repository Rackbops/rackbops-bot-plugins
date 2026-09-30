# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8, 5.10). This version is the core
(rackbops-bot-plugins#78), the Discord surface of the first slice (#79) -- reminders by slash
command, delivered by DM, answered by button, with history -- the first slice of the web area
(#80): sign-in by one-time link, my tasks, a task's history, and settings -- renewals and
the price tracker (#81, plan E6): two more types on the notify side, no model, nothing sent to
city-hall -- the web area's task editor (#80, slice 2): make, edit, pause, resume and delete
your own tasks from the web, under the commands' own rules -- the admin view and forget-me (#80,
slice 3) -- and the JSON task API with personal API tokens (#80, slice 4), for a program acting as
you, such as a later intake agent (plan E10).

## Commands

Every answer is ephemeral. The commands register globally, so they work in the bot's DMs as well
as in a server (plan 5.5, item 39).

| Command | Who | What |
|---|---|---|
| `/allow user` | a tracker admin | Admits a person: they can now `/register`. |
| `/register [hour] [zone]` | an admitted person | Signs up, or changes the preferred hour (0-23, default 9) and time zone (default `America/New_York`). The reply says an admin can see every task. |
| `/remind text [when] [repeat]` | a registered person | A reminder by DM. `when` is docket's `parseWhen` grammar (`in 20 minutes`, `tomorrow 9am`, `fri at 17:30`); `repeat` is once (the default), daily, weekly or monthly. A repeating one with no `when` starts today at the preferred hour. |
| `/renewal name amount currency renews [unit] [every] [lead] [note]` | registered | A subscription, domain, warranty or membership (docket's `renewal`, a `period` schedule). `renews` is the next renewal or expiry date, `YYYY-MM-DD`, today or later; `unit` yearly (the default), monthly, weekly or daily, `every` how many of those; the ask comes `lead` days before (default 7) at the preferred hour, with Keep, Cancel, Renewed and Snooze. If that ask is already past but the date is not, the first ask comes within a minute (a zone or hour change before it fires drops it for the next period's). Keep and Renewed record what was paid; Cancel ends it. |
| `/price url [name] [hours] [drop] [baseline] [near]` | registered | A price (docket's `price`, a `poll` schedule every `hours`, default 12, at most 168). The page is read once at once, and nothing is created unless a price is found in it; then the first check, within a minute, DMs the starting price, and a drop of `drop` percent or more (default 10) from the `baseline` -- the last (default), first or highest price seen -- DMs the owner once per crossing. `near` is the words just before the price, for a page with no structured price. At most 20 per person. |
| `/tasks` | registered | Your active tasks and the ones you receive, each with its next run; then your paused ones. |
| `/task done task` / `/task snooze task [until]` | the task's owner | Answers the task's latest reminder (snooze: an hour, or until `until`). |
| `/task decide task choice [amount]` | the renewal's owner | Answers the renewal's latest ask -- keep, cancel or renewed -- with the amount actually paid when it changed (a button cannot carry one). Use it instead of the button, not after it: a run is answered once. |
| `/task history task` | the owner, an accepted recipient, or an admin | Every run -- due, status, how it was answered, text replies -- and the task's changes; for a renewal, what each period cost and the total; for a price, the last check and the readings with the low and the high. |
| `/task share task user` | the task's owner | Invites an admitted, registered member who can be DMed: they get one consent DM with accept and decline. |
| `/task resume task` | the task's owner | Resumes a paused task: one paused because a recipient could not be DMed goes on without that recipient; one its owner paused on the web simply goes on. |
| `/settings hour hour` | registered | The preferred hour; recurring reminders with no time of their own move to it. |
| `/web` | registered | A one-time link to sign in to the web area (below), good for 10 minutes and one use. Says so when `TRACKER_WEB_URL` is unset. |

**Gates.** Every command and button checks, in order: membership of the `TRACKER_GUILD_ID`
server (when set), admission (in the tracker's store), then what the action needs (an admin for
`/allow`, admission for `/register`, registration for the rest). A person nobody admitted is told
to ask an admin to `/allow` them. Decline and opt-out skip the membership and registration gates,
so anyone can always stop the messages; the Reply button checks membership when its modal is sent.

**Buttons.** The owner's DM carries Done, Snooze 1h and Reply; a recipient's copy carries the
opt-out and Reply; the consent DM carries Accept and Decline. Reply opens a modal whose text is
kept on the task. docket decides who may answer what (the owner alone answers a run, item 34).
A pressed DM is edited to say what happened.

**Pause after failed DMs** (plan 5.5). Three DMs in a row that the host says cannot be delivered
pause the person's delivery and every active task that would DM them, theirs and the ones they
receive (a `paused` event in each task's history); their other runs due in that tick are held, not
failed. The owner of a task paused for a recipient is DMed once and sees why in `/tasks`; the task
resumes when the recipient next uses the tracker, or `/task resume` goes on without them. A person
paused for their own DMs is told, and resumed, the next time they use a command or button. A DM
that goes through clears the count.

## Web area

Served under `/tracker/` on the bot's own HTTP (it needs `HTTP_PORT`) and reached from outside
only through the instance's tunnel, at `TRACKER_WEB_URL`. Server-rendered HTML with forms and no
script, styled with `@rackbops/styles`' rackbops-noir theme (bundled into `dist/plugin.js` and
served at a hashed path, cached for a year).

| Path | What |
|---|---|
| `/` | My tasks: the same list as `/tasks` (active tasks owned and received, next run in your zone; paused ones and why), each linking to its history, and links to make a new one. |
| `/tasks/<id>` | A task's history: the same as `/task history`, for the owner, an accepted recipient or an admin. Anyone else gets the same 404 as an unknown id. The owner also sees Edit, Pause or Resume, and Delete. |
| `/new/reminder`, `/new/renewal`, `/new/price` | The editor's new-task forms (GET), and making one (POST). |
| `/tasks/<id>/edit` | The owner's edit form (GET) and saving it (POST). |
| `/tasks/<id>/pause`, `/resume`, `/delete` | POST only. Delete answers a confirmation first; only a second post carrying `confirm=yes` deletes. |
| `/settings` | Preferred hour and time zone, checked as `/register` checks them. Links to API tokens and Forget me. |
| `/tokens` | Your API tokens (below): each one's name, when it was made, last used and expires, with Revoke; and the form to make one (POST), which shows the new token once. |
| `/tokens/<id>/revoke` | POST only: revokes one of your own tokens. Anyone else's answers the same 404 as an unknown id. |
| `/forget` | Forget me (below): what it deletes (GET); a POST asks for the confirmation; a POST with `confirm=yes` and the word `forget` erases. Linked from Settings. |
| `/admin` | Admins only: everyone on the list, the decline blocks in force (each with Lift), and a form to allow a person by Discord id. |
| `/admin/tasks` | Admins only: every task in the store, with its owner, status and how many receive it, each linking to its page. |
| `/admin/people/<id>` | Admins only: one person -- Discord id, registration, zone and hour, delivery, task counts, their tasks -- with Make admin or Revoke admin, Resume delivery (when paused), and Remove from the tracker. |
| `/admin/allow`, `/admin/people/<id>/grant`, `/revoke`, `/resume-delivery`, `/forget`, `/admin/blocks/<id>/lift`, `/admin/tokens/<id>/revoke` | Admins only, POST only: the acts below. |
| `/api/v1/...` | The JSON task API (below): bearer tokens only, never the cookie. |
| `/signin` | Where a request that is not signed in is sent: says to run `/web`. |
| `/login?t=...` | The link `/web` gives. |

**Signing in** (plan item 41; the one-time link is the method for now, kept in
`src/web/signin-link.ts` so another, such as Discord OAuth2, can sit beside it and feed the same
sessions). `/web` answers, ephemerally, `<TRACKER_WEB_URL>/tracker/login?t=<token>`. Opening it
does not use it up -- a link preview or a prefetcher would otherwise burn it -- it shows a Sign in
button; pressing it uses the token (once, within 10 minutes), starts a session and redirects to
`/tracker/` so the token leaves the address bar. The login pages send `Referrer-Policy:
same-origin` and `Cache-Control: no-store` (every page does). Not `no-referrer`: under it a browser
sends a form post's `Origin` as `null`, which the Origin check refuses, so no form would work; the
pages link nowhere else, so the token never leaves in a Referer either way.

**Sessions and forms.** The session cookie is `__Secure-tracker-session`, `HttpOnly; Secure;
SameSite=Lax; Path=/tracker/`, for 7 days from sign-in. The store keeps only SHA-256 hashes of
link tokens and session ids. Every request re-reads the person: one no longer in the tracker's
store, or no longer registered, is signed out of every session. Every state change is a POST
carrying the session's CSRF token (compared in constant time), and a POST with an `Origin` other
than `TRACKER_WEB_URL`'s is refused. The sign-in post has no session yet, so it carries a
double-submit token from a `SameSite=Strict` cookie the link's page sets: another site cannot sign
you in as someone else. Sign out is a POST too.

**The task editor** (slice 2). The forms take the options of `/remind`, `/renewal` and `/price`,
and the same functions check and make them: the same defaults, limits and messages, the page read
once before a price tracker is made, at most 20 price trackers per person wherever they were made,
and `near` turned into the same bounded pattern; a person has one new price tracker's page read in
flight at a time. Every person may have at most 200 active or paused tasks of all types together,
made anywhere. The length limits are one set (`src/limits.ts`) for the slash options, the forms
and the server's checks. An edit changes a reminder's text, time and repeat
(an empty time keeps the one it has, unless the repeat changes); a renewal's name, amount,
currency, date, unit, every, lead and note (a new amount is the one the next ask quotes; a new date
gets `/renewal`'s first-ask rule, but a date a run already asked about is not asked again); a price's name, interval,
drop and baseline, never its page. A schedule change cancels and replaces what is queued and keeps
snoozes, as a zone move does, and each change is in the task's history. An empty field keeps what
the task has (an empty note clears it; an empty price name is the page's address). A renewal date
that is one of the schedule's own period dates keeps the schedule and its anchor as they are, so the
31st stays the 31st; only a different date re-anchors. A finished task cannot be
edited. Pause holds everything the task would send until Resume, and a person's delivery resuming
does not undo it; a run missed while paused fires once, late, on resume, and a zone or hour change
re-times the run a paused task holds -- same period date or local day, new zone or hour, still one
run -- so it is neither lost nor sent at the old time. Resume on a task paused
for failed DMs is `/task resume`. Delete archives the task: it leaves every list, its queued runs
are dropped and nothing more is sent, but its history is kept (an admin can see every task) and
its page stays for the owner. Every editor post passes the session, CSRF and `Origin` checks; the
task is loaded by the id in the path and must be the viewer's own, checked again in the write
queue, and anyone else's -- even one an admin can see -- answers the same 404 as an unknown id. A
refused form comes back with what was typed and why. Form bodies are capped at 32 KiB, read no
further than that.

**Headers.** `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'none';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`. Every value on a page is HTML-escaped. An unknown path is 404; a method
other than GET or POST (or the wrong one of the two for a path) is 405.

**Membership on the web.** With `TRACKER_GUILD_ID` set, `/web` issues a link only to a member,
and the session remembers when that was confirmed. A web request more than 15 minutes after the
last confirmation re-checks with one member lookup (about 3 seconds at most, outside the write
queue), through the discord.js Client of an interaction the plugin has handled since it started
(the host API has no member lookup of its own; the Client is held in memory, never stored).
Not a member: every session of theirs ends, on a page that says why. A member: the time is
refreshed. A failed or slow lookup, or no interaction yet since a restart: they stay signed in
while the last confirmation is under 24 hours old, and are then signed out and told to run `/web`
again. Concurrent requests share one lookup per person, and after a failed one that person is not
looked up again for a minute, so an outage or rate limit does not pile up calls. A confirmation
time in the future (a clock set back) counts as stale. Every lookup asks Discord (`force: true`),
never discord.js's member cache, which with only the Guilds intent never learns that someone left.

**The admin view** (slice 3, plan 5.8, 5.10). An admin is a person whose row in the tracker's store
has the admin flag -- the one admin definition; `/allow` checks the same flag. `TRACKER_ADMIN_DISCORD_IDS`
grants it at start; admins grant and revoke it here. The flag is read from the store on every
request, and again inside the write queue before any admin act, so an admin whose flag is revoked is
refused on their very next request. To a signed-in person who is not an admin, every `/admin` path --
any method -- answers the same 404, byte for byte, as an unknown page; a visitor who is not signed in
is sent to sign in, as on every other signed-in path. An admin sees every person, every task
and every task's page and history, read-only: an admin never edits, pauses or deletes another
person's task (the owner's acts answer them 404, as in slice 2). What an admin can do, each through
the function the command path runs:

- **Allow** a person by Discord id: `/allow`'s own `allowPerson`, with the same server-membership
  check when `TRACKER_GUILD_ID` is set (one bounded lookup; no Discord client yet since a restart
  refuses, as an unknown answer does). A form cannot tell a bot's id from a person's; a bot's row can
  never `/register`.
- **Make admin / Revoke admin** (plan 5.8). The last admin can be neither revoked nor removed. An
  admin who revokes themselves lands on My tasks. Each change is logged (`u1 made u2 an admin`).
  An admin named in `TRACKER_ADMIN_DISCORD_IDS` is made an admin again at every start, so their page
  offers neither Revoke nor Remove, and both are refused: take them out of the configuration first.
  Such an admin may still forget themselves (if another admin is left); the pages say that the next
  start makes them again, as a new person, unless the configuration no longer names them.
- **Resume delivery** of a person paused after failed DMs: `DeliveryHealth.resume`, what the
  person's own next command does -- the count clears and the tasks nothing else holds go back on.
- **Lift** a decline block in force: docket's `liftBlock`, recorded as that admin's lift.
- **Revoke an API token** of anyone's, from their page, which lists their tokens (never the
  secret). It stops working at once; the owner is not told. Logged by token id.
- **Remove from the tracker**: forget-me for that person (below), with the same confirmation.

Not here yet, though plan 5.10 lists them: grants, budgets and retry (they belong to the execute
lane, which is not built) and an admin pause of someone else's task.

**Forget me** (plan 5.8). A signed-in person erases themselves from `/forget` (web only: the plan
asks for no Discord command, so without `TRACKER_WEB_URL` the only path is an admin with the web
area). Two posts: the first asks, the second must carry `confirm=yes` and the word `forget`. Then,
in one SQLite transaction in the write queue, **deleted, not archived**:

- every task they own, archived ones too, with everything under it: runs, run events, replies
  (anyone's), history, series, recipients, delivery claims and pauses;
- on everyone else's tasks: their recipient rows, their replies and answers, the history rows they
  made or that name them (an invitation of them, a pause for them), the run events and delivery
  claims of DMs to them, and their pause rows;
- every decline block they are either side of;
- their admission, delivery health, web sessions, unused sign-in links and API tokens, and their
  person row.

What stays, and why: another person's task that they received stays that owner's; one paused only
because DMs to them failed goes back on. Another person's row keeps its own audit fact but not their
id -- `admitted_by` of someone they admitted, and `lifted_by` of a block they lifted, become
`forgotten` ("an admin since forgotten"; null already means "the configuration"). Text is matched
only in the forms the code writes a person's id into -- docket's consent rows (`u5`, `u5 24h`), the
tracker's `u5: ...` removals and `delivery to {u5} paused` pauses, docket's `u5 <message>` delivery
events, and the notifier's error phrases (`recipient u5 cannot be messaged`, ...) -- never as any
id-like word, so an address with `/u5/` in someone else's text is left alone. A history row or a
delivery event of theirs is deleted; the error of someone else's run keeps its row and has the id
replaced with `(forgotten)`. A pause for a recipient now names them by id and shows their current
name when read; a pause row written before 0.6.0 names the recipient's display name of the time,
and is deleted when it is on a task they were a recipient of, names their current name, and no
other recipient of that task has that name. A row written under an older name of theirs, or shared
with a same-named recipient, is kept: the one known gap. A reply other people wrote on the erased
person's own tasks is deleted with those tasks. Outside the store, nothing is touched: the DMs the
bot sent stay in the person's Discord DMs, and the host's log may hold their tracker id.

Bytes: the database runs with `secure_delete` on, so a deleted row is overwritten, and the first
start of 0.6.0 on an existing database runs one `VACUUM`, so pages freed before that are rewritten
too. That one-time VACUUM is recorded in a small `tracker_meta` table, not by a schema bump (0.6.0
kept the schema at 3; 0.7.0's API tokens are schema 4, see the CHANGELOG). If the VACUUM cannot run (a
reader holds the file), the start goes on, a warning is logged, and the next start tries again.
Not a VACUUM per erasure: it rewrites the whole file under an
exclusive lock, and `secure_delete` already covers every later delete. After an erasure the
write-ahead log is checkpointed without waiting; when a reader keeps it busy, that is logged and
SQLite's next checkpoint copies it back.

Timing: forget-me first waits, outside the write queue, until no notify or poll tick is running (at
most 20 seconds; then it answers 503, try again, and deletes nothing), so a reminder DM to them
already in flight cannot be recorded after they are gone -- and no one else's command waits behind
it. Inside the queue it only checks that no tick started meanwhile (else the same 503). A DM sent
outside any tick -- an invitation's -- that fails after they are gone writes nothing: the failure
count is not kept for a person no longer in the store, and the withdrawn invitation is not
recorded. A `/price` whose page is read while its person is forgotten makes nothing. Their sessions
are among the rows, so they are signed out everywhere at once, and the browser's cookie is cleared. They can come back only as someone new: an admin
`/allow`s them again, and the tracker never reuses an id.

**Choose the web origin's domain with care.** A host under the same parent domain as
`TRACKER_WEB_URL` that you do not control can set a `__Secure-` cookie on the parent domain
(cookie tossing), and so plant its own session or sign-in cookie in your browser: a login-CSRF.
The `__Host-` prefix, which would stop that, requires `Path=/` and so cannot be used with
`Path=/tracker/`. Put the bot on a host whose sibling subdomains are all yours.

## Task API

A JSON API over your own tasks, for a program that acts as you -- a script, or the plain-language
intake agent the plan defers (E10, item 31), which would end its dialogue by posting a task here.
It is served under `/tracker/api/v1/` on the same origin as the web area, and only when
`TRACKER_WEB_URL` is set. Every write goes through the same functions as the web editor and the
slash commands -- the same fields, defaults, limits, caps and messages -- in the same write queue.

**Tokens.** Make one on the web area's `/tokens` page (linked from Settings): a name, and an expiry
of 30, 90 (the default) or 365 days, or never. The page shows the token once -- `trk_` and 43
characters -- and the tracker keeps only its SHA-256, so neither a copy of the database nor the
page later shows it again. At most 10 live tokens per person. Each lists when it was made, last used
and expires, and can be revoked there at once; an admin sees and revokes anyone's from the admin
view's page for that person. Forget-me erases a person's tokens with the rest. The log names a
token by its id (`k1`), never by its secret.

**Authentication.** `Authorization: Bearer <token>` on every request. The web area's session
cookie is never read here: every plugin shares one browser origin, so a cookie-authenticated JSON
API could be called by any script on it. A token acts as its owner with the owner's rights only,
and only on the owner's own tasks -- an admin's token included; an admin's wider reads stay on the
signed-in web pages. Every request re-reads the owner, as the web does a session: a person no
longer on the tracker, or no longer registered, is refused; with `TRACKER_GUILD_ID` set, membership
is re-checked on the web's schedule (after 15 minutes, one lookup, shared with the web), and one who
has left the server loses every token and every session; a lookup that keeps failing lets them on
for 24 hours from the last confirmation, then answers 503 until one succeeds (the token is kept).
A token is looked up by the SHA-256 of what was sent, so the comparison is over a hash the sender
cannot steer.

**Browsers.** No answer carries a CORS header, and a request with an `Origin` header -- which a
browser adds to every cross-origin request and to any same-origin one that is not a GET -- is
refused with 403: the API is for programs, not pages. A browser page cannot send a cross-origin
`Authorization` header without a CORS preflight, which is refused. What this cannot stop: a script
of another plugin on the same origin can already use the web area as a signed-in person, making a
token included; put nothing on that origin you do not trust (as for the cookies, above).

**Limits.** Each token may make 60 requests at once, refilled at one per second; over that, `429`
with `Retry-After`. A limited request is refused before its owner is looked up. A body is at most
16 KiB, read no further. One new price tracker's page read in flight per person, shared with the
web editor (`409 busy`).

**Requests.** A `POST` or `PATCH` body is one JSON object with `Content-Type: application/json`
(else `415`), and names only the fields listed for that type (else `400 unknown_field`), each of
its JSON type: text as a string, a whole number or a number as a JSON number. A field left out of a
create gets the command's default; a field left out of an edit keeps what the task has, and an empty
string does the same, except that an empty `note` clears a renewal's note and an empty `name` gives
a price back the page's address -- exactly as the web editor's empty fields do.

| Method and path | What |
|---|---|
| `GET /api/v1/me` | The token's owner (id, name, zone, preferred hour) and the token (id, name, made, expires). |
| `GET /api/v1/types` | Each type's create and edit fields: name, JSON type, required, description, and limits (`maxLength`, `minimum`, `maximum`, `enum`) -- the web editor's own field list, as a readable intake spec (plan item 31). |
| `GET /api/v1/tasks` | Your tasks that are not deleted -- active, paused and done -- oldest first. Not the ones shared with you. |
| `POST /api/v1/tasks` | Makes one: `type` is `reminder`, `renewal` or `price`, and the rest are that type's create fields. `201`, with `Location`. A price's page is read first, and nothing is made unless a price is found in it. |
| `GET /api/v1/tasks/<id>` | One of your tasks (a deleted one too), with its history: the newest runs and changes, as `/task history` shows them. |
| `PATCH /api/v1/tasks/<id>` | Edits it: the fields to change. A price's page is not editable. |
| `POST /api/v1/tasks/<id>/pause`, `/resume` | Body `{}`. As the web's Pause and Resume, and `/task resume`. |
| `DELETE /api/v1/tasks/<id>` | Deletes it as the web does: archived, nothing more sent, history kept. No confirmation step. |

A task is `{"id", "type", "title", "status", "cadence", "nextAt", "createdAt", "updatedAt",
"settings"}`: `status` is `active`, `paused`, `done` or `deleted`; `cadence` is the schedule in
words, in your zone; `nextAt` the next run's instant (UTC), null when paused or nothing is due;
`settings` the values an edit would keep (a price also names its `url`). A write answers
`{"task", "message"}`, `message` being the words the web and the command say.

**Errors** are `{"error": {"code": "...", "message": "..."}}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid` | A rule refused a value; `message` is the rule's own words, as the web editor shows them. Also a field of the wrong JSON type, or no `type`. |
| 400 | `unknown_field` | A field that type does not take (on a pause or resume, any field). |
| 400 | `invalid_json` | The body is not JSON, or not one object. |
| 401 | `unauthorized` | No `Authorization` header. With `WWW-Authenticate: Bearer realm="tracker"`. |
| 401 | `invalid_token` | A token unknown, revoked or expired, or whose owner is no longer registered: one answer for all. |
| 403 | `origin_refused` | The request carried an `Origin` header. |
| 403 | `not_member` | The owner has left the `TRACKER_GUILD_ID` server; their tokens are revoked. |
| 404 | `not_found` | No such endpoint, or no such task of yours. Anyone else's task -- one shared with you, or any task to an admin's token -- answers exactly as an unknown id. |
| 405 | `method_not_allowed` | With `Allow`. |
| 409 | `conflict` | A finished task edited, or a pause of a task not active (a resume of one not paused). |
| 409 | `limit_reached` | 200 active or paused tasks, or 20 price trackers, as the commands count them. |
| 409 | `busy` | Your last new price tracker's page is still being read. |
| 413 | `too_large` | Body over 16 KiB. |
| 415 | `unsupported_media_type` | Not `application/json`. |
| 429 | `rate_limited` | With `Retry-After`. |
| 503 | `starting`, `membership_unknown`, `unavailable` | The plugin is starting; the owner's membership could not be checked for 24 hours; the type is not available on this bot. |

**Example.**

```
$ curl -s https://clerk.example.com/tracker/api/v1/tasks \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" \
    -d '{"type": "reminder", "text": "water the plants", "when": "tomorrow 9am", "repeat": "week"}'
{"task":{"id":"t7","type":"reminder","title":"water the plants","status":"active",
 "cadence":"weekly on Fri at 9:00","nextAt":"2026-10-02T13:00:00.000Z",
 "createdAt":"2026-10-01T12:00:00.000Z","updatedAt":"2026-10-01T12:00:00.000Z",
 "settings":{"text":"water the plants","repeat":"week"}},
 "message":"Reminder `t7` set: water the plants\nNext: Fri Oct 2, 9:00, weekly on Fri at 9:00."}

$ curl -s -X PATCH https://clerk.example.com/tracker/api/v1/tasks/t7 \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" \
    -d '{"repeat": "day"}'

$ curl -s -X POST https://clerk.example.com/tracker/api/v1/tasks/t7/pause \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" -d '{}'

$ curl -s https://clerk.example.com/tracker/api/v1/tasks/t9 -H "Authorization: Bearer $TRACKER_TOKEN"
{"error":{"code":"not_found","message":"No such task."}}
```

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on two host ticks, every 60 s, through a view of the store that skips a paused task's due runs: `notify` runs every type but the page readers, `poll` runs only them (`price`) with the Fetch port, so a slow page never holds up a reminder. Registers `reminder`, `renewal` and `price`. The execute lane is not ticked. |
| Page reads | `src/fetch.ts` | docket's `Fetch` port for `price`: http or https on the default port, no credentials, every resolved address public (no loopback, private, link-local, CGNAT, multicast or reserved range, IPv4 or IPv6), redirects followed by hand and re-checked (at most 5), 15 s including the name lookup, at most 3 MB kept. The body is then rebuilt in linear time (`src/page.ts`) to just what extraction reads -- JSON-LD, meta tags, and the page with every `<` blanked, so `near` still reads text, attributes and script data -- because docket's extraction patterns take quadratic time on a page of unclosed tags. A read the tick's abort cuts short requeues its run instead of counting a miss. A DNS answer that changes between the check and the read is not caught here. |
| Renewals, prices | `src/tracked.ts`, `src/price.ts`, `src/series.ts`, `src/page.ts` | `/renewal`, `/price` and `/task decide`; the series lines of `/task history`. The series (docket's `series` table, schema 1) holds a renewal's paid amounts and a price's readings. |
| Delivery | `src/notifier.ts`, `src/claims.ts`, `src/buttons.ts` | docket's `Notifier` over `host.dm`, with the buttons. Each (occurrence, person) is claimed in `delivery_claims` before the DM is sent and settled after; a claim never settled is not resent -- it is logged once, as unconfirmed. |
| Pause | `src/delivery-health.ts` | The per-person failure count, the pause and the resume. |
| People | `src/people.ts`, `src/admissions.ts` | Discord id, time zone, preferred hour, admin flag -- in the tracker's store, never usr; who admitted each person and when they registered. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. |
| Commands | `src/discord.ts`, `src/interactions.ts`, `src/discord-common.ts` (discord.js); `src/actions.ts`, `src/press.ts`, `src/history.ts`, `src/access.ts` | The discord.js files read options and render; the rest is Discord-free over the injected store, clock and notifier. Store writes are handled one at a time; Discord lookups and DMs run outside that queue. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. |
| Admin, forget-me | `src/admin.ts`, `src/roster.ts`; `src/web/admin.ts`, `src/web/admin-pages.ts` | The admin acts and forget-me, Discord-free; the SQL docket's Store has no method for (listing people and blocks, erasing a person); the routes and pages. |
| Web area | `src/web/` | `app.ts` authenticates and dispatches (pure over the injected store and clock), `routes.ts` names the paths; `pages.ts`, `editor-pages.ts` and `html.ts` render; `form-input.ts` reads the editor's fields and `editor.ts` calls the shared rules with them; `signin-link.ts` and `sessions.ts` hold the sign-in; `theme.ts` the stylesheet; `command.ts` is `/web`. |
| Task API | `src/web/api.ts`, `src/web/api-tasks.ts`, `src/web/api-tokens.ts`, `src/web/tokens.ts`, `src/web/token-pages.ts` | The JSON API's authentication, gates and rate limit; its task routes over editor.ts's writes; the tokens (SQL, hashed); the tokens page and its routes. |
| Task rules | `src/reminders.ts`, `src/tracked.ts`, `src/price.ts`, `src/edit.ts`, `src/manage.ts`, `src/limits.ts` | What makes, edits, pauses, resumes and deletes a task, and the limits on it, Discord-free, for the commands and the web editor alike. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker. Checked through the interaction's client with a single-member lookup (no privileged intent). Unset = no membership gate, and a warning is logged each time the plugin activates; a malformed value refuses to load. |
| `TRACKER_WEB_URL` | no | The https origin the bot's HTTP is reached at through its tunnel, e.g. `https://clerk.example.com` (no path). `/web` links and the allowed `Origin` come from it, never from a request's `Host`. Unset = no web area (`/web` says so, the pages answer 404); anything but a bare https origin refuses to load. |

`/tracker/healthz` and the web area need the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- The rest of the web area (E5): sharing a task from the web, and the admin view's grants, budgets
  and retry (with the execute lane). The task API covers reminders, renewals and prices only --
  not `/task done`, `snooze`, `decide`, `share` or the settings -- and no intake agent uses it yet
  (E10, deferred). Discord OAuth2 as a second sign-in
  method, if chosen (plan item 41).
- The city-hall Executor adapter (the execute lane).
- Editing in Discord (the editor is on the web only), and changing a price tracker's page or `near` after it is made (make a new one); a free-form pattern for `price` (`near` is the safe subset: a user's regular expression run on a large page could hang the bot).
- An optional Discord-role gate (plan 5.5), and showing unconfirmed deliveries to admins anywhere but the log.

docket-core, docket-types and `@rackbops/styles` are `devDependencies`: `bun build` bundles them
into `dist/plugin.js` (the theme's CSS as text), and the bot loads that file without installing
anything.
