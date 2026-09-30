# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8, 5.10). This version is the core
(rackbops-bot-plugins#78), the Discord surface of the first slice (#79) -- reminders by slash
command, delivered by DM, answered by button, with history -- the first slice of the web area
(#80): sign-in by one-time link, my tasks, a task's history, and settings -- renewals and
the price tracker (#81, plan E6): two more types on the notify side, no model, nothing sent to
city-hall -- and the web area's task editor (#80, slice 2): make, edit, pause, resume and delete
your own tasks from the web, under the commands' own rules.

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
| `/settings` | Preferred hour and time zone, checked as `/register` checks them. |
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
never discord.js's member cache, which with only the Guilds intent never learns that someone left. There is no way yet to take a person off the tracker (forget-me and the admin view, below).

**Choose the web origin's domain with care.** A host under the same parent domain as
`TRACKER_WEB_URL` that you do not control can set a `__Secure-` cookie on the parent domain
(cookie tossing), and so plant its own session or sign-in cookie in your browser: a login-CSRF.
The `__Host-` prefix, which would stop that, requires `Path=/` and so cannot be used with
`Path=/tracker/`. Put the bot on a host whose sibling subdomains are all yours.

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
| Web area | `src/web/` | `app.ts` authenticates and dispatches (pure over the injected store and clock), `routes.ts` names the paths; `pages.ts`, `editor-pages.ts` and `html.ts` render; `editor.ts` reads the editor's forms and calls the shared rules; `signin-link.ts` and `sessions.ts` hold the sign-in; `theme.ts` the stylesheet; `command.ts` is `/web`. |
| Task rules | `src/reminders.ts`, `src/tracked.ts`, `src/price.ts`, `src/edit.ts`, `src/manage.ts`, `src/limits.ts` | What makes, edits, pauses, resumes and deletes a task, and the limits on it, Discord-free, for the commands and the web editor alike. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker. Checked through the interaction's client with a single-member lookup (no privileged intent). Unset = no membership gate, and a warning is logged each time the plugin activates; a malformed value refuses to load. |
| `TRACKER_WEB_URL` | no | The https origin the bot's HTTP is reached at through its tunnel, e.g. `https://clerk.example.com` (no path). `/web` links and the allowed `Origin` come from it, never from a request's `Host`. Unset = no web area (`/web` says so, the pages answer 404); anything but a bare https origin refuses to load. |

`/tracker/healthz` and the web area need the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- The rest of the web area (E5): the admin view, lifting a decline block, forget-me (which would
  erase a deleted task), sharing a task from the web, and the JSON task API. Until forget-me and the admin view exist, nobody can be taken off the
  tracker, so a web session ends only by sign-out, expiry, or the membership re-check. Discord OAuth2 as a second sign-in method, if chosen (plan item 41).
- The city-hall Executor adapter (the execute lane).
- Editing in Discord (the editor is on the web only), and changing a price tracker's page or `near` after it is made (make a new one); a free-form pattern for `price` (`near` is the safe subset: a user's regular expression run on a large page could hang the bot).
- An optional Discord-role gate (plan 5.5), and showing unconfirmed deliveries to admins anywhere but the log.

docket-core, docket-types and `@rackbops/styles` are `devDependencies`: `bun build` bundles them
into `dist/plugin.js` (the theme's CSS as text), and the bot loads that file without installing
anything.
