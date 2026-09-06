# Changelog

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
