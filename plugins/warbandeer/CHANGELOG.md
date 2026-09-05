# Changelog

## [1.0.0] - 2026-09-04

### Added

- Warbandeer desktop-app character linking, ported from the bot's baked-in connector
  (`rackbops-discord-bot#3`, PR #92) as the first published plugin: the `/link` and `/unlink`
  slash commands and the HTTP ingest endpoint (`POST /link`, `POST /characters`), gated behind
  `WARBANDEER_INGEST_PORT` (unset = connector off). Behaviour is identical to the baked-in
  connector; see the bot's `docs/adr/0001`–`0003` for the transport, auth, and storage design.
