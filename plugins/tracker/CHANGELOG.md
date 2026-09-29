# Changelog

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
