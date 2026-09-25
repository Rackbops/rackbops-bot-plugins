# @rackbops/plugin-mcp

The bridge plugin for the Discord delivery MCP ([`Rackbops/discord-mcp`](https://github.com/Rackbops/discord-mcp),
[Rackbops/Tooling#742](https://github.com/Rackbops/Tooling/issues/742)). It implements the service
side of that repo's `docs/bridge-protocol.md` under `/mcp/` on the bot's own HTTP listener
(rackbops-discord-bot's host-owned router, ADR-0007) -- `GET /capabilities`,
`POST /deliveries`, `GET /deliveries/{request_id}` and `GET /recipients` -- so the MCP service can
hand it a message and get exactly one Discord post, DM or edit out of it, however many times it
retries. It also owns Discord-side agent identity ([Rackbops/Tooling#743](https://github.com/Rackbops/Tooling/issues/743)):
the `/agent` slash command, and `POST /pair/redeem` + `GET /registration/{user_id}` under the same
`/mcp/` path.

## What it does

- Accepts a delivery request, answers `202` immediately, and delivers to Discord in the background.
- Keeps one state file per `request_id` (`pending` -> `delivered`/`failed`, or `unknown` after a bot
  restart mid-delivery) so a retry with the same `request_id` never delivers twice.
- A tick re-drives any delivery a restart left `unknown`, and prunes records older than 8 days.
- `kind: "post"` goes through `host.post` (or `host.announce` when the host predates it); `kind: "dm"`
  goes through `host.dm`, to a registered user only; `kind: "edit"` goes through `host.edit`, applied
  against the stored delivery `message_ref` names. `GET /capabilities` reports `dm`/`edit` as `true`
  exactly when the host provides `host.dm`/`host.edit` -- a host without either still gets a clean
  `failed{CAPABILITY_UNAVAILABLE}` for that kind, the same shape a missing `host.post` has always
  gotten.
- `/agent register` mints a Discord user a `generation` id; `/agent pair` issues a single-use,
  10-minute pairing code (at least 128 bits, 27 characters; at most 5 live at once -- issuing a 6th
  drops the oldest); a connector exchanges that code for the user's id and generation via
  `POST /pair/redeem`; `/agent unregister` deletes the registration and every outstanding code in
  one write.

## DM, edit and recipients

Example ids used throughout: user `123456789012345678`, guild `234567890123456789`, channel
`345678901234567890`, message `456789012345678901`; an original send's `request_id` is 64 x `a`, an
edit's is 64 x `b`.

`POST /deliveries`, `kind: "dm"` -- `target.user_id` must match `^[1-9][0-9]{16,19}$`; `body` is
validated as for a post:

```
request:  {"request_id":"<64 hex>","kind":"dm","target":{"user_id":"123456789012345678"},"body":{"content":"hi"}}
202:      {"state":{"state":"pending","kind":"dm","target":{"user_id":"123456789012345678"},"body":{"content":"hi"},"created_at":"2026-09-25T00:00:00.000Z"},"existing":false}
GET once delivered:
          {"state":"delivered","kind":"dm","target":{"user_id":"123456789012345678"},"body":{"content":"hi"},"created_at":"2026-09-25T00:00:00.000Z","message_ref":"<the dm's own request_id>","url":"https://discord.com/channels/@me/345678901234567890/456789012345678901"}
GET when the recipient isn't registered, or has closed DMs:
          {"state":"failed","kind":"dm","target":{"user_id":"123456789012345678"},"body":{"content":"hi"},"created_at":"2026-09-25T00:00:00.000Z","code":"RECIPIENT_UNREACHABLE"}
```

`POST /deliveries`, `kind: "edit"` -- `target.message_ref` is the original post's or dm's own
`request_id` and must match `^[0-9a-f]{64}$`; `target.seq` is the service's own per-message edit
counter, an integer from 1 to 2147483647; `body` is partial -- at least one of `content` (1-2000
characters when present), `card` or `links`:

```
request:  {"request_id":"bbbb...(64)","kind":"edit","target":{"message_ref":"aaaa...(64)","seq":2},"body":{"content":"v2"}}
GET once applied:
          {"state":"delivered","kind":"edit","target":{"message_ref":"aaaa...(64)","seq":2},"body":{"content":"v2"},"created_at":"2026-09-25T00:00:00.000Z","message_ref":"aaaa...(64)","url":"https://discord.com/channels/234567890123456789/345678901234567890/456789012345678901","applied":true}
GET once superseded by a higher seq already applied (reported as unchanged, not an error):
          { ...same..., "applied":false }
```

`failed` codes for an edit:

| Code | When |
| --- | --- |
| `NOT_FOUND` | No record for `message_ref`, the record isn't `delivered`, or it is itself an edit. |
| `CAPABILITY_UNAVAILABLE` | `host.edit` is absent, or the original was delivered by `announce` (`delivery: null`). |
| `RECIPIENT_UNREACHABLE` | The original was a dm and its recipient is no longer registered. |
| `UPSTREAM_UNAVAILABLE` | `host.edit` rejected. |

`applied` appears only on `kind: "edit"` records that are `delivered`. `state` stays
`pending|delivered|failed|unknown` -- there is no new state.

`GET /recipients` -- every registered user, ordered by registration time ascending then `user_id`, at
most 100, each `display_name` truncated to 100 characters (same bearer auth; any other method is
`405`):

```
200: {"items":[{"user_id":"123456789012345678","display_name":"Roshne"}]}
200: {"items":[]}
```

`GET /capabilities` now reflects the host's real `dm`/`edit` support:

```
{"dm":<typeof host.dm === "function">,"targeted_post":<has post>,"cards":<has post>,"edit":<typeof host.edit === "function">,"destinations":[...unchanged...]}
```

A dm/edit's `target` 400s use the existing `{"error":"<reason>"}` shape (`target.user_id`/
`target.message_ref` must be a snowflake/64-hex-string; `target.seq` must be an integer in range;
the edit body must include at least one of `content`, `card` or `links`).

A record created before this version (`kind: "dm"`/`"edit"` with the old coerced target) is never
delivered -- a dm gets `failed{RECIPIENT_UNREACHABLE}`, an edit gets `failed{NOT_FOUND}`, both with
no Discord call. No migration runs; the mismatch between the record's `kind` and its actual target
shape is what a redrive recognizes.

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
