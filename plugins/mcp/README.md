# @rackbops/plugin-mcp

The bridge plugin for the Discord delivery MCP ([`Rackbops/discord-mcp`](https://github.com/Rackbops/discord-mcp),
[Rackbops/Tooling#742](https://github.com/Rackbops/Tooling/issues/742)). It implements the service
side of that repo's `docs/bridge-protocol.md` under `/mcp/` on the bot's own HTTP listener
(rackbops-discord-bot's host-owned router, ADR-0007) -- `GET /capabilities`,
`POST /deliveries` and `GET /deliveries/{request_id}` -- so the MCP service can hand it a message
and get exactly one Discord post out of it, however many times it retries. It also owns Discord-side
agent identity ([Rackbops/Tooling#743](https://github.com/Rackbops/Tooling/issues/743)): the
`/agent` slash command, and `POST /pair/redeem` + `GET /registration/{user_id}` under the same
`/mcp/` path.

## What it does

- Accepts a delivery request, answers `202` immediately, and posts to Discord in the background.
- Keeps one state file per `request_id` (`pending` -> `delivered`/`failed`, or `unknown` after a bot
  restart mid-delivery) so a retry with the same `request_id` never posts twice.
- A tick re-drives any delivery a restart left `unknown`, and prunes records older than 8 days.
- `send_dm` and `update_message` are not implemented in this version -- every `kind: "dm"` or
  `"edit"` request is answered `CAPABILITY_UNAVAILABLE` immediately. The recipient registry and edit
  ordering arrive in later children of [Rackbops/Tooling#737](https://github.com/Rackbops/Tooling/issues/737).
- `/agent register` mints a Discord user a `generation` id; `/agent pair` issues a single-use,
  10-minute pairing code (at least 128 bits, 27 characters; at most 5 live at once -- issuing a 6th
  drops the oldest); a connector exchanges that code for the user's id and generation via
  `POST /pair/redeem`; `/agent unregister` deletes the registration and every outstanding code in
  one write.

## Registration and pairing

`POST /pair/redeem` -- exchanges a code from `/agent pair` for the Discord user id and generation:

```
request:  {"code":"ABCDEFGHJKMNPQRSTVWXYZ23456"}
200:      {"discord_user_id":"123456789012345678","generation":"q1w2e3r4t5y6u7i8o9p0aZ"}
404:      {"error":"invalid or expired code"}     (unknown, expired, already used, or issued before an unregister -- one answer for all)
400:      {"error":"malformed request"}           (not JSON, no string `code`, or `code` not matching ^[A-Z2-9]{27}$)
```

`GET /registration/{user_id}` -- `{user_id}` must match `^[1-9][0-9]{16,19}$`, else `404`:

```
200:      {"generation":"q1w2e3r4t5y6u7i8o9p0aZ"}
404:      {"error":"not registered"}
```

A `generation` changes only across a full unregister-then-register-again -- a connector holding a
stale `generation` for a user has been revoked and re-paired since, not merely re-issued a code.

## Env

| Key | Required | Secret | What it does |
|---|---|---|---|
| `MCP_BRIDGE_TOKEN` | No | Yes | The bearer token the MCP service must present. Unset = every request gets `503 {"error":"bridge not configured"}`. At least 256 bits, base64url -- generate one with e.g. `openssl rand -base64 32 \| tr -d '=' \| tr '/+' '_-'`. |

## Destinations

Declared so the operator can map each to a channel per server in the admin panel (the same
`destinations` mechanism every plugin's `HostApi.announce` uses):

| Name | What it's for |
|---|---|
| `alerts` | Time-sensitive findings and warnings |
| `deals` | Notable deals or opportunities |
| `digest` | Periodic summaries |
| `ops` | Operational status and infrastructure notices |

## Operator steps (not done by this plugin)

1. Set `PLUGINS=...,mcp` and `MCP_BRIDGE_TOKEN` on the bot instance.
2. Map at least one destination to a channel, in exactly one server, from the admin panel.
3. Confirm how the bot's HTTP listener is exposed; if `/mcp/` is not already behind Cloudflare
   Access, front it with an Access application using the existing machine-access service-token
   policy -- the bridge secret above is the second factor, not a substitute for Access.
4. Configure the MCP service (`Rackbops/discord-mcp`) with this bridge's URL and the same token.

None of this runs the plugin's first live end-to-end check by itself -- see
[Rackbops/Tooling#742](https://github.com/Rackbops/Tooling/issues/742)'s acceptance bullets for what
that verifies.

## Design

`docs/bridge-protocol.md` in [`Rackbops/discord-mcp`](https://github.com/Rackbops/discord-mcp) is the
protocol this plugin implements; where this README and that document ever disagree, the protocol
document wins (this plugin is the implementation, not the source of truth). See `CONTEXT.md` in this
repo for the file-by-file breakdown and the state-machine gotchas.
