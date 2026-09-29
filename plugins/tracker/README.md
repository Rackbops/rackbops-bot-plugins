# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8). This version is the core
(rackbops-bot-plugins#78) and the Discord surface of the first slice (#79): reminders by slash
command, delivered by DM, answered by button, with history.

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
| `/task share task user` | the task's owner | Invites an admitted, registered person: they get one consent DM with accept and decline. |
| `/settings hour hour` | registered | The preferred hour; recurring reminders with no time of their own move to it. |

**Gates.** Every command and button checks, in order: membership of the `TRACKER_GUILD_ID`
server (when set), admission (in the tracker's store), then what the action needs (an admin for
`/allow`, admission for `/register`, registration for the rest). A person nobody admitted is told
to ask an admin to `/allow` them.

**Buttons.** The owner's DM carries Done, Snooze 1h and Reply; a recipient's copy carries the
opt-out and Reply; the consent DM carries Accept and Decline. Reply opens a modal whose text is
kept on the task. docket decides who may answer what (the owner alone answers a run, item 34).
A pressed DM is edited to say what happened.

**Pause after failed DMs.** Three DMs in a row that the host says cannot be delivered pause the
person's delivery: their active tasks pause (a `paused` event in each task's history), and as a
recipient they are left out of other people's runs. Their next command or button resumes it and
tells them why it stopped; a DM that goes through clears the count.

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on the host tick `notify` (every 60 s), through a view of the store that skips a paused task's due runs and a paused recipient. Registers only `reminder` and `renewal`. The execute lane is not ticked. |
| Delivery | `src/notifier.ts`, `src/claims.ts`, `src/buttons.ts` | docket's `Notifier` over `host.dm`, with the buttons. Each (occurrence, person) is claimed in `delivery_claims` before the DM is sent and settled after; a claim never settled is not resent -- it is logged once, as unconfirmed. |
| Pause | `src/delivery-health.ts` | The per-person failure count, the pause and the resume. |
| People | `src/people.ts`, `src/admissions.ts` | Discord id, time zone, preferred hour, admin flag -- in the tracker's store, never usr; who admitted each person and when they registered. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. |
| Commands | `src/discord.ts` (discord.js), `src/actions.ts`, `src/press.ts`, `src/history.ts`, `src/access.ts` | discord.ts reads options and renders; the rest is Discord-free over the injected store, clock and notifier. Interactions are handled one at a time. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker. Checked through the interaction's client with a single-member lookup (no privileged intent). Unset = no membership gate (logged at start); a malformed value refuses to load. |

`/tracker/healthz` needs the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- The web area (E5): editing tasks, the admin view, lifting a decline block, forget-me.
- The `Fetch` port (then `price` is registered) and the city-hall Executor adapter (the execute lane).
- An optional Discord-role gate (plan 5.5), and showing unconfirmed deliveries to admins anywhere but the log.

docket-core and docket-types are `devDependencies`: `bun build` bundles them into `dist/plugin.js`,
and the bot loads that file without installing anything.
