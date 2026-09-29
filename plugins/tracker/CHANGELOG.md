# Changelog

## [0.1.0] - 2026-09-29

### Added

- The task tracker's core (rackbops-bot-plugins#78), the host of
  [`Rackbops/docket`](https://github.com/Rackbops/docket) (`@rackbops/docket-core` and
  `@rackbops/docket-types` 0.3.0, bundled): docket's Store port on `bun:sqlite` in
  `<dataDir>/tracker.sqlite`, passing docket's `STORE_CONTRACT`; the notify lane on the host's
  60-second tick, delivering by `host.dm`, with each delivery claimed before it is sent so a
  restart or an abandoned tick never sends one twice; people (Discord id, time zone, preferred
  hour, admin flag) in the tracker's own store, the first admin from `TRACKER_ADMIN_DISCORD_IDS`;
  and `GET /tracker/healthz`, `503` once the last tick is more than three minutes old. No
  commands yet (#79) and no buttons (they wait on rackbops-discord-bot#323).
