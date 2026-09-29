# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8, 5.10). This version is the core
(rackbops-bot-plugins#78), the Discord surface of the first slice (#79) -- reminders by slash
command, delivered by DM, answered by button, with history -- and the first slice of the web area
(#80): sign-in by one-time link, my tasks, a task's history, and settings.

## Commands

Every answer is ephemeral. The commands register globally, so they work in the bot's DMs as well
as in a server (plan 5.5, item 39).

| Command | Who | What |
|---|---|---|
| `/allow user` | a tracker admin | Admits a person: they can now `/register`. |
| `/register [hour] [zone]` | an admitted person | Signs up, or changes the preferred hour (0-23, default 9) and time zone (default `America/New_York`). The reply says an admin can see every task. |
| `/remind text [when] [repeat]` | a registered person | A reminder by DM. `when` is docket's `parseWhen` grammar (`in 20 minutes`, `tomorrow 9am`, `fri at 17:30`); `repeat` is once (the default), daily, weekly or monthly. A repeating one with no `when` starts today at the preferred hour. |
| `/tasks` | registered | Your active tasks and the ones you receive, each with its next run; then your paused ones. |
| `/task done task` / `/task snooze task [until]` | the task's owner | Answers the task's latest reminder (snooze: an hour, or until `until`). |
| `/task history task` | the owner, an accepted recipient, or an admin | Every run -- due, status, how it was answered, text replies -- and the task's changes. |
| `/task share task user` | the task's owner | Invites an admitted, registered member who can be DMed: they get one consent DM with accept and decline. |
| `/task resume task` | the task's owner | Resumes a task paused because a recipient could not be DMed, taking that recipient off it. |
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
| `/` | My tasks: the same list as `/tasks` (active tasks owned and received, next run in your zone; paused ones and why), each linking to its history. |
| `/tasks/<id>` | A task's history: the same as `/task history`, for the owner, an accepted recipient or an admin. Anyone else gets the same 404 as an unknown id. |
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
again. There is no way yet to take a person off the tracker (forget-me and the admin view, below).

**Choose the web origin's domain with care.** A host under the same parent domain as
`TRACKER_WEB_URL` that you do not control can set a `__Secure-` cookie on the parent domain
(cookie tossing), and so plant its own session or sign-in cookie in your browser: a login-CSRF.
The `__Host-` prefix, which would stop that, requires `Path=/` and so cannot be used with
`Path=/tracker/`. Put the bot on a host whose sibling subdomains are all yours.

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on the host tick `notify` (every 60 s), through a view of the store that skips a paused task's due runs. Registers only `reminder` and `renewal`. The execute lane is not ticked. |
| Delivery | `src/notifier.ts`, `src/claims.ts`, `src/buttons.ts` | docket's `Notifier` over `host.dm`, with the buttons. Each (occurrence, person) is claimed in `delivery_claims` before the DM is sent and settled after; a claim never settled is not resent -- it is logged once, as unconfirmed. |
| Pause | `src/delivery-health.ts` | The per-person failure count, the pause and the resume. |
| People | `src/people.ts`, `src/admissions.ts` | Discord id, time zone, preferred hour, admin flag -- in the tracker's store, never usr; who admitted each person and when they registered. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. |
| Commands | `src/discord.ts`, `src/interactions.ts`, `src/discord-common.ts` (discord.js); `src/actions.ts`, `src/press.ts`, `src/history.ts`, `src/access.ts` | The discord.js files read options and render; the rest is Discord-free over the injected store, clock and notifier. Store writes are handled one at a time; Discord lookups and DMs run outside that queue. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. |
| Web area | `src/web/` | `app.ts` routes (pure over the injected store and clock); `pages.ts` and `html.ts` render; `signin-link.ts` and `sessions.ts` hold the sign-in; `theme.ts` the stylesheet; `command.ts` is `/web`. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker. Checked through the interaction's client with a single-member lookup (no privileged intent). Unset = no membership gate, and a warning is logged each time the plugin activates; a malformed value refuses to load. |
| `TRACKER_WEB_URL` | no | The https origin the bot's HTTP is reached at through its tunnel, e.g. `https://clerk.example.com` (no path). `/web` links and the allowed `Origin` come from it, never from a request's `Host`. Unset = no web area (`/web` says so, the pages answer 404); anything but a bare https origin refuses to load. |

`/tracker/healthz` and the web area need the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- The rest of the web area (E5): editing tasks, the admin view, lifting a decline block, forget-me,
  and the JSON task API. Until forget-me and the admin view exist, nobody can be taken off the
  tracker, so a web session ends only by sign-out, expiry, or the membership re-check. Discord OAuth2 as a second sign-in method, if chosen (plan item 41).
- The `Fetch` port (then `price` is registered) and the city-hall Executor adapter (the execute lane).
- An optional Discord-role gate (plan 5.5), and showing unconfirmed deliveries to admins anywhere but the log.

docket-core, docket-types and `@rackbops/styles` are `devDependencies`: `bun build` bundles them
into `dist/plugin.js` (the theme's CSS as text), and the bot loads that file without installing
anything.
