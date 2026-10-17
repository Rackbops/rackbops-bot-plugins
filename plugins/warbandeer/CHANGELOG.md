# Changelog

## [1.3.2] - 2026-10-17

### Fixed

- The `/link` and failed-auth rate limits now treat an IPv6 client's whole /64 as one client, expired limiter entries are swept by a timer instead of a full scan past 10,000 keys, and a bad `/link` code guess no longer rewrites `links.json` (Rackbops/rackbops-bot-plugins#197, #342).

## [1.3.1] - 2026-10-17

### Fixed

- A blank `WARBANDEER_INGEST_PORT` or `TRUSTED_PROXY_HOST` is treated as unset, the same as leaving it out (Rackbops/rackbops-bot-plugins#317).
- A push that was authenticated before an `/unlink` is refused (401) instead of writing the snapshot back; `/link` and `/unlink` answer a failure instead of hanging, and `/unlink` says when its stored data could not be deleted; expired link codes are swept, malformed `links.json` account entries and wrong-shaped characters files no longer break pushes, and an object key in a rejected push is escaped in the error (#197, #329).
- A failed first lookup of the tunnel sidecar's address no longer leaves the trusted-proxy set empty for a minute: with nothing resolved yet, the first request at least 5 seconds after the failure retries, and the request after that is trusted. A `CF-Connecting-IP` header with more than one value is now untrusted and the peer address is used, instead of taking the first value (Rackbops/rackbops-bot-plugins#181, #332).

## [1.3.0] - 2026-09-27

### Changed

- `CF-Connecting-IP` is now trusted only from a peer address that resolves to `TRUSTED_PROXY_HOST`
  (rackbops-bot-plugins#69); previously trusted unconditionally, so another container on the same
  compose network could claim a fresh rate-limit budget on every request by spoofing the header.
  New optional env `TRUSTED_PROXY_HOST` (unset = the header is never trusted, matching the old
  fail-closed behaviour minus the spoofable header). Recognizes a peer reported in IPv4-mapped-IPv6
  notation (`::ffff:x.x.x.x`, what `Bun.serve`'s dual-stack default bind reports for a real IPv4
  connection) as the same address DNS resolves in plain form -- without this, the feature above
  would never have actually engaged for a real container-to-container connection.
- Link Codes are now 13 characters from a 30-symbol alphabet (~64 bits, up from 8 hex characters /
  32 bits) and are stored as a sha256 hash, never plaintext (rackbops-bot-plugins#69).

## [1.2.0] - 2026-09-09

### Added

- `dispose()` (`rackbops-discord-bot#184`): the ingest server this plugin's `activate()` opens is
  now closed on the way out — a `docker stop`, a self-update's retire, `SIGINT` — instead of being
  left listening until the process is killed out from under it. No behaviour change if the
  connector was never configured (`WARBANDEER_INGEST_PORT` unset) or never started.

## [1.1.0] - 2026-09-06

### Added

- An admin-panel tab, via the plugin admin-UI contract
  (`rackbops-discord-bot#123`): shows whether the ingest connector is configured (a port is set) and
  lets an admin set (or clear) `WARBANDEER_INGEST_PORT` — saved through the panel's
  guarded env-set, which recreates the bot to apply it. No character/link data is
  shown.

## [1.0.0] - 2026-09-04

### Added

- Warbandeer desktop-app character linking, ported from the bot's baked-in connector
  (`rackbops-discord-bot#3`, PR #92) as the first published plugin: the `/link` and `/unlink`
  slash commands and the HTTP ingest endpoint (`POST /link`, `POST /characters`), gated behind
  `WARBANDEER_INGEST_PORT` (unset = connector off). Behaviour is identical to the baked-in
  connector; see the bot's `docs/adr/0001`–`0003` for the transport, auth, and storage design.
