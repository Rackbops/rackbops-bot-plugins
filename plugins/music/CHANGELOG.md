# Changelog

## [1.3.0] - 2026-09-20

### Added

- A match log: every `/setlist` build that actually ran -- fully matched, partly matched, or failed
  -- is recorded in `music-match-log.json`, in the bot's `data/` directory beside `music.json` and
  `parties.json`. It keeps the most recent 50 runs, oldest dropped first, and exists so the
  matching can be tuned against real setlists instead of guesses: until now a build kept only the
  winning track and threw away the candidates the search returned, their scores and the query that
  found them.

  Per run it records when, which setlist (id, link, artist, date, venue, city, tour), whether the
  build succeeded, how many songs were attempted and how many were added, and one entry per song.
  Per song: the title and the artist it was searched under, the outcome (`high`, `medium`, `low`,
  `missing` or `error`), the track that was picked and which query found it. For every outcome
  except `high` it also keeps each query that was issued, with the candidates the search returned
  for it in Spotify's own order and each candidate's score split into its parts (title, artist,
  tie-break, penalty, total). A `high` match keeps no candidate lists -- a confident match needs
  no second look, and a 25-song setlist can be up to around 500 candidates.

  Read a candidate's total as its score and the parts as how it was reached, not as a sum: a
  candidate whose title doesn't match scores all zeros whatever its artist, and a penalty larger
  than the rest clamps the total at 0 while the parts stay non-zero.

  A build that fails part-way -- a Spotify error on song 12, or none of the songs found -- is
  recorded too, with the error and the songs searched up to that point (a setlist with no songs
  is recorded as a failed run with none). Nothing is recorded when the caller never got as far as
  a build, e.g. Spotify isn't configured, isn't connected, or the connection no longer refreshes.

  Each build also leaves one line in the bot log, so `docker logs` shows builds happening:
  `setlist <id> "<artist> <date>": added A/N, missing M, loose L`, with `-- failed: <error>`
  appended when the build failed. "Loose" counts `medium` and `low` matches together.

  **Matching is unchanged.** Scores, confidence, the queries tried and the reply text are exactly
  what they were in 1.2.0; the log only records what the search already did.

  **The log holds no Discord user id and no token** -- it records what was searched and what came
  back, never who asked.

  Recording is best-effort. It happens after the reply has been sent, and a failure to write the
  file is logged as a warning and never reaches the `/setlist` reply.

### Known limits

- The file is rewritten in full, pretty-printed, on every build. At the 50-run cap it is about
  0.4 MiB when every song of a 25-song setlist matches confidently and about 10 MiB when every
  song of every run is missing, since those keep their candidate lists.

## [1.2.0] - 2026-09-20

### Added

- A listening party: `/party start` opens one in a channel, a Join button puts anyone else in it,
  and `/party add <query>` queues a track and starts the music. Everyone hears it on their OWN
  Spotify, at the same point in the same track, so it works while people are in a voice chat --
  which Spotify's own Listen Along refuses to do. `/party skip`, `/party status`, `/party leave`
  and `/party stop` round it out.

  **The bot is the sequencer; Spotify's queue is never used.** Each member's player is told
  exactly which track to be on and where, one explicit URI at a time. Handing Spotify a playlist
  context instead would let each member's own shuffle and repeat settings decide what came next,
  and a member who skipped on their phone could never be brought back in line. Track boundaries
  ride on the plugin's own timer rather than the host's shared 60-second tick, since that tick
  runs every plugin's checks in sequence and is the wrong place to land a track change; the tick
  is used only to repair -- it re-arms a timer lost to a restart and pulls back a member who has
  drifted more than three seconds.

  A member who PAUSES is left alone rather than restarted: the bot never fights the person
  holding the phone. A member whose player stops answering twice is dropped from the party with a
  note saying why. Stopping a party stops the bot steering; it does not silence anyone's Spotify.

  **Playback scopes are asked for only when someone actually wants a party.** `/spotify connect`
  still requests just the two playlist scopes, and `/party` mints its own link for
  `user-read-playback-state` and `user-modify-playback-state` when a caller hasn't granted them.
  The grant Spotify reports is recorded on the connection and checked BEFORE a call, so a
  connection made before this feature existed produces a one-click reconnect prompt rather than
  a raw 403; an insufficient-scope error is still translated the same way as a backstop, since a
  user can narrow a grant in their Spotify settings at any time.

### Known limits

- **A party needs Spotify Premium and an awake player, for everyone in it.** Playback control is
  Premium-only, and Spotify rejects a command to an account with no active device -- the party
  makes one rescue attempt by transferring to an idle device, and otherwise tells the person to
  open Spotify and press play once. Members are capped by the app's permanent five-account
  ceiling, recorded under 1.0.0, since a party and a playlist are the same Spotify app.
- Sync is approximate. Each member gets their own HTTP round trip, so a few hundred milliseconds
  of spread between the first and last is expected; the party corrects only drift beyond three
  seconds, because a re-issued play is an audible jump rather than a nudge.
- A party survives a bot restart -- its state is on disk and the tick re-arms the timer -- but
  its CHAT messages go quiet until someone runs a `/party` command again, because a plugin can
  only reach an arbitrary channel through a client borrowed from a live interaction.

## [1.1.0] - 2026-09-20

### Added

- `/setlist artist:<name> date:<date>` builds the playlist from the show on a particular night,
  rather than only the artist's most recent one. The date is accepted as `2026-09-08` or
  `08-09-2026` and sent on in setlist.fm's own `dd-MM-yyyy`, which its search parameter requires
  -- an ISO date there matches nothing, silently.

  A band can play a festival slot in the afternoon and a club show the same night, and setlist.fm
  also carries genuine duplicate entries for one gig, so an artist-and-date search can honestly
  have more than one answer. Every match is shown in a menu, labelled by venue with the song count
  and tour beside it, and the user picks; nothing is guessed. One match is used straight away.
  Shows with no song list yet are counted but not offered, so "there were two shows, neither
  written up" reads differently from "there was no show".

  The menu is bound to whoever ran the command. The `/setlist` reply is public, so anyone in the
  channel can see the menu -- the playlist is built with the clicker's own Spotify grant, and a
  bystander clicking would get a playlist they never asked for or be told to connect an account by
  a command they never ran. The chosen show is re-fetched by id when it is clicked rather than
  held in memory, so the menu still works across a restart or a self-update.

### Fixed

- setlist.fm rate limits and server errors are now retried instead of being handed straight to the
  user. A `Retry-After` is obeyed when the server sends one, otherwise the wait doubles from half
  a second; three retries at most, and no wait longer than five seconds -- past that, and for a
  `Retry-After` in whole minutes, it gives up at once rather than holding a Discord reply open on
  a spinner. Only 429 and 5xx are retried: every other 4xx is a statement about the request, so
  repeating it unchanged would only waste the user's time. A transport failure is not retried
  either, the ten-second timeout having already been spent.
- A search returning a single result now reads it. setlist.fm's JSON comes from an XML schema and
  a one-element collection arrives as a bare object rather than a list -- the same wrinkle already
  guarded for a setlist's `sets.set` in 1.0.0, but the search results themselves were still being
  read as an array only, so a one-result search looked like no results at all.

## [1.0.0] - 2026-09-20

### Added

- A `music` plugin. Its first feature turns a setlist.fm show into a Spotify playlist.

  `/setlist url:<setlist.fm link>` builds a playlist from that show; `/setlist artist:<name>`
  uses the artist's most recent show that actually has a song list filled in (setlist.fm is
  full of stubs, so empty ones are skipped rather than returning a playlist of nothing).
  `/spotify connect`, `/spotify disconnect` and `/spotify status` manage the caller's own
  Spotify link.

  Named `music`, not `setlist`, for the domain rather than the one feature -- the same way `wow`
  covers four unrelated commands. The plugin already owns the Spotify account link, which any
  later music feature would share rather than duplicate, and a plugin's name is the `PLUGINS=`
  token, the log prefix and the `data/plugins/<name>` directory, so it is fixed the moment this
  publishes.

  Each song is matched by searching Spotify and SCORING the results, not by taking the first
  hit: since Spotify's February 2026 dev-mode changes capped `limit` at 10, a page of ten
  results for a well-known song routinely leads with a karaoke rendition or a live cut.
  Karaoke and "in the style of" uploads are rejected outright, live and remix versions are
  penalised but still eligible (some songs were only ever released live), and a remaster
  suffix costs nothing. A song setlist.fm marks as a cover is searched under the ORIGINAL
  artist, since a band that covers a song live has usually never released it. Matches that
  are not confident are named back to the user rather than silently trusted, and songs played
  from tape (walk-on and interlude music) are skipped with the count reported. A medley, which
  setlist.fm records as one slash-separated entry, is split into its parts, because no track is
  named after the whole medley and the entry would otherwise match nothing at all.

  Connecting uses the standard authorization-code flow. The callback is served by the
  plugin's own HTTP listener on `MUSIC_CALLBACK_PORT`, reachable only through the bot's
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
- A Spotify refresh token is stored in plaintext in `data/music.json`. Unlike warbandeer's
  Device Tokens, which are only ever compared and so can be hashed, a refresh token has to be
  replayed to Spotify, so the bot must hold the real value. It is never logged and never put in
  a Discord reply, and `data/` should be treated as being as sensitive as the config `.env`.
- Nothing here has run against the live setlist.fm or Spotify APIs -- the suite covers the
  request shapes, the matching and the failure paths against injected fakes. A real
  `/spotify connect` through a real tunnel is what proves the deployed flow.
