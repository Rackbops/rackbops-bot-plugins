# Changelog

## [1.0.0] - 2026-09-20

### Added

- A `setlist` plugin that turns a setlist.fm show into a Spotify playlist.

  `/setlist url:<setlist.fm link>` builds a playlist from that show; `/setlist artist:<name>`
  uses the artist's most recent show that actually has a song list filled in (setlist.fm is
  full of stubs, so empty ones are skipped rather than returning a playlist of nothing).
  `/spotify connect`, `/spotify disconnect` and `/spotify status` manage the caller's own
  Spotify link.

  Each song is matched by searching Spotify and SCORING the results, not by taking the first
  hit: since Spotify's February 2026 dev-mode changes capped `limit` at 10, a page of ten
  results for a well-known song routinely leads with a karaoke rendition or a live cut.
  Karaoke and "in the style of" uploads are rejected outright, live and remix versions are
  penalised but still eligible (some songs were only ever released live), and a remaster
  suffix costs nothing. A song setlist.fm marks as a cover is searched under the ORIGINAL
  artist, since a band that covers a song live has usually never released it. Matches that
  are not confident are named back to the user rather than silently trusted, and songs played
  from tape (walk-on and interlude music) are skipped with the count reported.

  Connecting uses the standard authorization-code flow. The callback is served by the
  plugin's own HTTP listener on `SETLIST_CALLBACK_PORT`, reachable only through the bot's
  opt-in `cloudflared` sidecar (the same route warbandeer's ingest endpoint uses,
  `rackbops-discord-bot` ADR-0001) -- `docker-compose.yml` publishes no host port for it. The
  OAuth `state` token is single-use and expires in ten minutes, so a leaked callback URL
  cannot be replayed to attach a Spotify account to someone else's Discord id, and a second
  `/spotify connect` invalidates the user's earlier link.

  Every env key is independently optional: the plugin loads with none of them set and its
  commands report exactly which ones an admin still needs to fill in.

### Known limits

- **Spotify allows this app five users, permanently.** Development Mode has been capped at
  five authorised users per client id since 2026-02-11, and requires the app owner to hold
  Spotify Premium. Extended Quota Mode, the only way past it, has been restricted to
  registered businesses with 250k+ monthly active users since 2025-05-15, so there is no
  growth path for an instance like this one. The cap counts linked Spotify accounts, not
  Discord members, so a large server is fine as long as at most five people connect. Spotify's
  own "User not registered in the Developer Dashboard" error is surfaced verbatim when the
  sixth person tries, because that message is the whole diagnosis.
- A Spotify refresh token is stored in plaintext in `data/setlist.json`. Unlike warbandeer's
  Device Tokens, which are only ever compared and so can be hashed, a refresh token has to be
  replayed to Spotify, so the bot must hold the real value. It is never logged and never put in
  a Discord reply, and `data/` should be treated as being as sensitive as the config `.env`.
- Nothing here has run against the live setlist.fm or Spotify APIs -- the suite covers the
  request shapes, the matching and the failure paths against injected fakes. A real
  `/spotify connect` through a real tunnel is what proves the deployed flow.
