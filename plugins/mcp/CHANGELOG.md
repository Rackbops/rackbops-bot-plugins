# Changelog

## [0.2.0] - 2026-09-25

### Added

- Agent registration and pairing (`Rackbops/Tooling#743`, the first of five children split from
  `Rackbops/Tooling#737`): the `/agent register` | `pair` | `unregister` slash command, plus
  `POST /pair/redeem` and `GET /registration/{user_id}` under `/mcp/`. A registration mints a
  random 128-bit `generation` id; `pair` issues a single-use, 10-minute pairing code (at most 5
  live per user) that a connector redeems for the Discord user id and current generation;
  `unregister` deletes the registration -- and with it every outstanding code -- in one write.
  Every register/pair/unregister/redeem is serialized against every other through the same keyed
  JSON mutator the delivery store uses, on one `registry.json` file.

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
