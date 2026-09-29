# Changelog

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
