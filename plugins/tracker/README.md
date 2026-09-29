# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8). This version is the core
only (rackbops-bot-plugins#78): no slash commands (#79) and no buttons (rackbops-discord-bot#323).

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on the host tick `notify` (every 60 s). Registers only `reminder` and `renewal`: `price` needs the Fetch port and the execute-lane types an Executor, neither wired yet. The execute lane is not ticked. |
| Delivery | `src/notifier.ts`, `src/claims.ts` | docket's `Notifier` over `host.dm`. Each (occurrence, person) is claimed in `delivery_claims` before the DM is sent and settled after; a claim never settled is not resent -- it is logged once, as unconfirmed. A person without a valid Discord id, or a message with no text, is refused before any claim; a host refusal before anything reaches Discord (a bad id, a message it rejects, an unknown user) releases the claim. A host that says the recipient cannot be messaged fails the run (`RecipientUnreachableError`); the schedule's next run still materializes. An aborted tick sends nothing more and leaves the rest queued. |
| People | `src/people.ts` | Discord id, time zone (default `America/New_York`), preferred hour (default 9), admin flag -- in the tracker's store, never usr. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. `localIdentity` answers docket's `Identity` port from the store. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. Stale = no completed tick in three minutes. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |

`/tracker/healthz` needs the bot's `HTTP_PORT` set; without it there is no HTTP at all.

## Not yet

- Commands, admission (`/allow`), `/register`: #79. Buttons (done, snooze, opt-out): after
  rackbops-discord-bot#323. Until then a DM carries the message text only.
- The `Fetch` port (then `price` is registered) and the city-hall Executor adapter (the execute lane).

docket-core and docket-types are `devDependencies`: `bun build` bundles them into `dist/plugin.js`,
and the bot loads that file without installing anything.
- Pausing a task after three consecutive delivery failures (plan 5.5), and showing unconfirmed
  deliveries to admins anywhere but the log.
