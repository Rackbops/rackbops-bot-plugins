# Changelog

## [1.0.4] - 2026-10-17

### Fixed

- `/transmog` accepts a character of at most 24 characters and a realm of at most 40, and the values it echoes back, item names and Blizzard error text are clipped, so an oversized value can no longer make the reply exceed Discord's 2000 characters and leave the command on "thinking" (Rackbops/rackbops-bot-plugins#200, #340).
- A missing or corrupt `wow.json` is seeded from the bot's `state.json` and written back, so an open Faire, weekly reset or realm state no longer announces a second time after the plugin's own file is lost. A `wow.json` that loads is used as it is (#200, #341).

## [1.0.3] - 2026-10-17

### Fixed

- The Darkmoon Faire, weekly-reset and realm announcements now write their dedup key to `wow.json` before posting and put it back if the post fails, so a stop while a post is in flight no longer re-announces after the restart. A hard kill between the save and the post loses that one announcement (Rackbops/rackbops-bot-plugins#200, #331).
- `wow.json` gains `realmKey` (`<region>/<realm>`): a realm status stored for another realm or region is no longer compared with the new realm's reading, so switching realm or region seeds silently instead of announcing a phantom up/down. A file without the key is read as the realm configured now (#200, #331).
- Each Blizzard request is bounded at 10 seconds and the realm tick's requests also stop with the host's tick signal, so a connection that is accepted but never answered no longer holds a tick in flight (Rackbops/rackbops-bot-plugins#319).
- The admin tab rejects a time zone this engine does not know, instead of saving a name that fails at the next start (#318).

## [1.0.2] - 2026-10-14

### Fixed

- The `format` of `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` is now spelled as plain printable ASCII (`[!-~]`) instead of `\S`, which is not POSIX ERE: on a host whose `regcomp` reads `\S` as a literal `S`, `bot-ops.sh env-set` would refuse every real value. Values already set are unaffected (Rackbops/rackbops-bot-plugins#202, #307).

## [1.0.1] - 2026-09-09

### Fixed

- `rackbops-discord-bot#55` item 1: `/transmog` with a non-Latin-script realm name (e.g. a
  Cyrillic EU realm typed as shown in-game) used to slug to an empty string, reach Blizzard's
  API anyway, and reply blaming the *character* ("No character **Name** on **** (EU)") rather
  than naming the actual problem. An empty or hyphen-only slug is now rejected before any fetch,
  with a reply naming the realm as typed and asking for the English realm name. No name→slug map
  for non-Latin realms in this release — the plugin's own embedded realm list carries only
  English names, so there's nothing to resolve a Cyrillic name *from* yet. Latin realm names with
  hyphens or apostrophes (`rackbops-discord-bot#32`) are unaffected.

## [1.0.0] - 2026-09-06

### Added

- World of Warcraft features, ported from the bot's baked-in code
  (`rackbops-discord-bot#107`): the `/dmf`, `/reset`, `/status`, and `/transmog`
  slash commands; the Darkmoon Faire, weekly-reset, and realm up/down
  announcements; and a realm-chooser admin-panel tab (via the plugin admin-UI
  contract, `rackbops-discord-bot#123`) with a region-filtered realm dropdown and
  a Darkmoon Faire timezone picker. Behaviour is identical to the baked-in code;
  the dedup state lives in the plugin's own `data/wow.json`, seeded once from the
  bot's `state.json` so an existing instance never re-announces after the move.
