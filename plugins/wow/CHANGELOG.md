# Changelog

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
