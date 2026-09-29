# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8). This version is the core
(rackbops-bot-plugins#78), the Discord surface of the first slice (#79): reminders by slash
command, delivered by DM, answered by button, with history -- and renewals and the price tracker
(#81, plan E6): two more types on the notify side, no model, nothing sent to city-hall.

## Commands

Every answer is ephemeral. The commands register globally, so they work in the bot's DMs as well
as in a server (plan 5.5, item 39).

| Command | Who | What |
|---|---|---|
| `/allow user` | a tracker admin | Admits a person: they can now `/register`. |
| `/register [hour] [zone]` | an admitted person | Signs up, or changes the preferred hour (0-23, default 9) and time zone (default `America/New_York`). The reply says an admin can see every task. |
| `/remind text [when] [repeat]` | a registered person | A reminder by DM. `when` is docket's `parseWhen` grammar (`in 20 minutes`, `tomorrow 9am`, `fri at 17:30`); `repeat` is once (the default), daily, weekly or monthly. A repeating one with no `when` starts today at the preferred hour. |
| `/renewal name amount currency renews [unit] [every] [lead] [note]` | registered | A subscription, domain, warranty or membership (docket's `renewal`, a `period` schedule). `renews` is the next renewal or expiry date, `YYYY-MM-DD`, today or later; `unit` yearly (the default), monthly, weekly or daily, `every` how many of those; the ask comes `lead` days before (default 7) at the preferred hour, with Keep, Cancel, Renewed and Snooze. If that ask is already past but the date is not, the first ask comes within a minute. Keep and Renewed record what was paid; Cancel ends it. |
| `/price url [name] [hours] [drop] [baseline] [near]` | registered | A price (docket's `price`, a `poll` schedule every `hours`, default 12, at most 168). The page is read once at once, and nothing is created unless a price is found in it; then the first check, within a minute, DMs the starting price, and a drop of `drop` percent or more (default 10) from the `baseline` -- the last (default), first or highest price seen -- DMs the owner once per crossing. `near` is the words just before the price, for a page with no structured price. At most 20 per person. |
| `/tasks` | registered | Your active tasks and the ones you receive, each with its next run; then your paused ones. |
| `/task done task` / `/task snooze task [until]` | the task's owner | Answers the task's latest reminder (snooze: an hour, or until `until`). |
| `/task decide task choice [amount]` | the renewal's owner | Answers the renewal's latest ask -- keep, cancel or renewed -- with the amount actually paid when it changed (a button cannot carry one). Use it instead of the button, not after it: a run is answered once. |
| `/task history task` | the owner, an accepted recipient, or an admin | Every run -- due, status, how it was answered, text replies -- and the task's changes; for a renewal, what each period cost and the total; for a price, the last check and the readings with the low and the high. |
| `/task share task user` | the task's owner | Invites an admitted, registered member who can be DMed: they get one consent DM with accept and decline. |
| `/task resume task` | the task's owner | Resumes a task paused because a recipient could not be DMed, taking that recipient off it. |
| `/settings hour hour` | registered | The preferred hour; recurring reminders with no time of their own move to it. |

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

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on two host ticks, every 60 s, through a view of the store that skips a paused task's due runs: `notify` runs every type but the page readers, `poll` runs only them (`price`) with the Fetch port, so a slow page never holds up a reminder. Registers `reminder`, `renewal` and `price`. The execute lane is not ticked. |
| Page reads | `src/fetch.ts` | docket's `Fetch` port for `price`: http or https on the default port, no credentials, every resolved address public (no loopback, private, link-local, CGNAT, multicast or reserved range, IPv4 or IPv6), redirects followed by hand and re-checked (at most 5), 15 s, at most 3 MB kept. A DNS answer that changes between the check and the read is not caught here. |
| Renewals, prices | `src/tracked.ts`, `src/series.ts` | `/renewal`, `/price` and `/task decide`; the series lines of `/task history`. The series (docket's `series` table, schema 1) holds a renewal's paid amounts and a price's readings. |
| Delivery | `src/notifier.ts`, `src/claims.ts`, `src/buttons.ts` | docket's `Notifier` over `host.dm`, with the buttons. Each (occurrence, person) is claimed in `delivery_claims` before the DM is sent and settled after; a claim never settled is not resent -- it is logged once, as unconfirmed. |
| Pause | `src/delivery-health.ts` | The per-person failure count, the pause and the resume. |
| People | `src/people.ts`, `src/admissions.ts` | Discord id, time zone, preferred hour, admin flag -- in the tracker's store, never usr; who admitted each person and when they registered. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. |
| Commands | `src/discord.ts`, `src/interactions.ts`, `src/discord-common.ts` (discord.js); `src/actions.ts`, `src/press.ts`, `src/history.ts`, `src/access.ts` | The discord.js files read options and render; the rest is Discord-free over the injected store, clock and notifier. Store writes are handled one at a time; Discord lookups and DMs run outside that queue. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker. Checked through the interaction's client with a single-member lookup (no privileged intent). Unset = no membership gate, and a warning is logged each time the plugin activates; a malformed value refuses to load. |

`/tracker/healthz` needs the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- The web area (E5): editing tasks, the admin view, lifting a decline block, forget-me.
- The city-hall Executor adapter (the execute lane).
- Editing a renewal or a price tracker after it is made (for now: `/task done`, or cancel, and make it again); a free-form pattern for `price` (`near` is the safe subset: a user's regular expression run on a large page could hang the bot).
- An optional Discord-role gate (plan 5.5), and showing unconfirmed deliveries to admins anywhere but the log.

docket-core and docket-types are `devDependencies`: `bun build` bundles them into `dist/plugin.js`,
and the bot loads that file without installing anything.
