# Changelog

## [0.1.0] - 2026-09-25

### Added

- The bridge plugin for the Discord delivery MCP (`Rackbops/Tooling#742`): the service side of
  `docs/bridge-protocol.md` in [`Rackbops/discord-mcp`](https://github.com/Rackbops/discord-mcp) --
  `GET /capabilities`, `POST /deliveries` and `GET /deliveries/{request_id}` under `/mcp/`, a bearer
  token compared in constant time, async delivery with pending/delivered/failed/unknown states kept
  one file per request, and a catch-up tick that re-drives a delivery a restart left `unknown`.
  Declares the `alerts`, `deals`, `digest` and `ops` destinations. `send_dm`/`update_message` always
  answer `CAPABILITY_UNAVAILABLE` in this version -- the recipient registry and edit ordering arrive
  in `Rackbops/Tooling#737`.
