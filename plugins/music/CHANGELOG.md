# Changelog

## [Unreleased]

### Fixed

- The Spotify connect callback now answers "Something went wrong" and logs which stage failed
  (never the token or the code) when something in the handshake throws (the bot's own store failing
  to write, say), instead of leaving the browser on Bun's error response, and the callback server
  renders no debug page. A party notice in the channel now sets its own mentions instead of
  inheriting the host client's default: it pings nobody, except that the drop-out notice pings the
  member it is about, so Spotify's error text in it can never ping @everyone, @here or a role
  whatever the host's default is (#190).
- The party sweep now honours the abort signal the host gives every tick: it stops between steps
  (before each party, before its per-member checks, before each resync) once the host's 30 s bound
  passes or the bot shuts down, instead of carrying on issuing play commands and writing the party
  file after the host has given up on it, and its player calls to Spotify (the playback read, play,
  devices, transfer) are cancelled with the signal; the token refresh, which is shared with commands
  and must not lose a rotated token, is left to finish. A resync cancelled that way is not counted
  as a strike against the member. The runner also arms no timer once the plugin has been disposed: a
  track change or start that was still playing when it was disposed no longer schedules the next
  boundary afterwards (#147).
- The reply after an add that starts an idle party, and the reply after `/party skip`, are now
  clipped to Discord's 2000 characters as a whole. Before, the per-member outcome list was clipped
  but the leading line ("<@user> queued ...", "Skipped to ...") was added on top, so with many
  members failing at once the message was too long and Discord refused it (#240).
- A party member's failure count now starts fresh with every party and every Join: a strike taken
  in an earlier party, or before leaving and rejoining, no longer follows them into the next one and
  turns a single blip into a drop (or, for the host, into closing the new party). The Join button
  says "Couldn't join the party" when its first sync already dropped the member (a free Spotify
  account, or Spotify refusing the command), instead of "Joined, but ..." for someone who is no
  longer in. A party sweep no longer resyncs a member against a track that ended while it was
  checking or resyncing the members before them: it drops the resyncs it has left and looks again on
  the next sweep. A track ending inside the one member's resync already in flight (its token
  refresh and play call) can still slip through, and the next sweep corrects it (#234).
- `/party skip` now acknowledges Discord before it does anything else, so a slow Spotify no longer
  makes it "not respond". It no longer refreshes the skipper's token ahead of that -- being in the
  party is the authorisation; the runner refreshes every member's token when it plays the next track,
  the skipper's included, now after the reply is deferred -- and a skipper whose own Spotify can't
  play is handled like any other member (named in the reply and, for a permanent problem, dropped
  from the party) instead of being refused privately (#153).
- `/party add` now checks the caller's Spotify access under an ephemeral reply, so the authorize link
  (which carries a single-use sign-in token) and "not connected" / "no longer valid" answers go only
  to the person who ran it; the channel still hears who queued what, through a separate public
  message, exactly as `/party start` already worked (#134).
- One token refresh at a time per user: a second refresh for the same person while one is out (the
  party sweep and a track start, or a command during either) now joins it instead of racing it,
  which used to let the loser delete or overwrite a token Spotify had just rotated. A refresh also
  no longer writes against a snapshot taken before it left: a `/spotify disconnect` while it was
  out stays disconnected (the bot answers "connect first" instead of quietly putting the token
  back), and a `/spotify connect` while it was out keeps the fresh grant, whether the old refresh
  rotated, succeeded or came back dead (#146).
- A party member whose token refresh fails for any reason that is not a dead grant -- Spotify
  unreachable, slow, rate-limiting or erroring, the app's own credentials refused, an answer the bot
  cannot read -- is no longer dropped from the party on that first failure: the runner now treats it
  like any other blip and drops them only on the second consecutive one, exactly as a transient play
  failure already did, so one Spotify hiccup at a track boundary no longer empties a party (or
  closes it, when the host's refresh was the one that hit it). A first strike is logged, since
  nothing else records it. A recognised dead grant (HTTP 400 `invalid_grant`) or a disconnect still
  drops the member at once. The drop-out line also no longer ends in two periods when the reason is
  a full sentence (#154).
- A token refresh that fails because Spotify is unreachable, slow, rate-limiting (429) or erroring
  (5xx), or because the app's own credentials are refused (`invalid_client`), no longer deletes the
  user's stored connection -- only a dead grant (HTTP 400 `invalid_grant`: the refresh token is
  invalid, expired or revoked) does, and a failure the bot cannot read (a 400 with no error code) is
  kept too. The reply says the link is still saved, to try again in a moment, and to run
  `/spotify connect` again if it keeps failing. A party member's token therefore survives a Spotify
  blip instead of sending them back through consent (#133), so rejoining after a drop needs no new
  consent. A dead grant still gets "no longer valid ... reconnect", exactly as before.
- A karaoke upload phrased "Originally Performed by <artist>" (or "Originally by <artist>") no
  longer survives on an instrumental penalty alone -- the phrase joins the same 100-point pattern
  as "tribute" and "in the style of". A candidate whose primary or secondary artist name contains
  the word "karaoke" now also pays the same 100-point penalty regardless of its title, catching a
  karaoke label's uploads that don't otherwise name themselves in the title (#99).

## [1.6.0] - 2026-09-29

### Changed

- `normalize()` now reads `&` and `+` between two words as the word "and", so setlist.fm's
  "By-Tor & the Snow Dog" and Spotify's "By-Tor And The Snow Dog" compare equal in both titles and
  artist names -- the studio recording is now matched at `high` instead of falling to a live cut at
  `low` (#57).
- `pickBestTrack` now ranks any candidate with artist agreement above every candidate with none,
  whatever their titles score -- an exact title from an unrelated artist (e.g. Boomkat's *Rip Her to
  Shreds*) no longer outranks the right artist's own remaster (Blondie's, partial artist match).
  Confidence is unaffected; this changes which candidate wins, not how sure the reply is (#58).
- A song search no longer stops at the first query that finds ANY credible match -- it keeps
  going past a `medium` or `low` result to try the loose query too, and the more confident of the
  two wins (ties keep the filtered query's match, which is the more precise of the two). The
  common case, a confident first hit, still costs exactly one Spotify search; the worst case per
  song is still bounded at two (rackbops-bot-plugins#61). The match log's `queries` field is now
  kept whenever more than one query ran, even if the winner was `high` -- previously it was
  dropped whenever the outcome was `high`, however many queries that took.
- A song is now searched under every artist name it could be filed under, not only the one
  setlist.fm gives: the performer, the lead act of a joined performer name (`Pat Benatar & Neil
  Giraldo` -> `Pat Benatar`), the artist a strict majority of the setlist's cover credits name (a
  tribute act's own recordings), and last -- for a credited cover -- the original artist, so the
  performer's own recording of a song it covers is preferred when Spotify has one
  (rackbops-bot-plugins#63, rackbops-bot-plugins#64). A later name is tried only while the best
  match so far isn't `high`, and only replaces it when strictly more confident -- a band on
  Spotify keeps its own recordings over a same-confidence fallback. The reply now names any added
  song whose winning artist wasn't the one setlist.fm gave, as its last line (so it's the first
  dropped at the 2000-character ceiling): `Matched under a different artist than setlist.fm names:
  Heartbreaker -> Pat Benatar.` `music-match-log.json` gains `foundUnder` per song (the artist that
  actually found it) and keeps `queries` whenever more than one query ran under any name, even a
  `high` reached only after falling back. Worst case per song is now up to 4 names x 2 queries --
  200 for 25 covers on a duo tribute set -- while an ordinary band matching under its own name, or
  any song whose first query is `high`, is unchanged.
- The `/setlist` build reply's first line now names the show date, in the same ISO (`yyyy-MM-dd`)
  form the playlist name already uses: `**Metallica - London Stadium, London, United Kingdom
  (2026-07-05)**`. It was the only place the date wasn't shown, so a band that played the same
  venue twice read identically (#92). Nothing appended when the setlist has no date.
- A tie between candidates with the same title and artist score is no longer broken by `popularity`
  -- a search made with a connected user's token never actually sends it, so it always fell back to
  whichever candidate Spotify happened to list first. The tie now goes to the candidate whose
  primary artist has more editions on the same result page (the album cut, a remaster, a
  compilation), which is what a real catalogue artist looks like; page order still decides a
  genuine tie. **`tieBreak` in `music-match-log.json` is unchanged as a key, but now holds this
  editions count divided by 100, not `popularity / 100`** (#59).
- A title that differs from the song title only by a clean-edition suffix -- a remaster, with or
  without a year, in every spelling the catalogue uses (`2004 Remaster`, `Remastered 2001`,
  `Remastered Version`) -- now counts as an exact title (scored 99, one point short of a genuinely
  un-suffixed title so the plain edition still wins a tie by score, not page order). With an exact
  artist that makes the match `high` instead of `medium`, so the reply stops asking the user to
  check a recording that was always right: *Dreamline* and *Bravado* (Rush) in particular. Other
  suffixes -- `Single Version`, `Radio Edit`, `Retrospective 3 Version`, `Take 2`, `live`, `remix`,
  `demo`, `instrumental` -- are a different edit or recording and stay a mere title prefix (#60).
- setlist.fm lists a suite by its parts -- *2112 Part I: Overture*, *2112 Part II: The Temples of
  Syrinx* -- but no Spotify track title ever carries "Part I:", so every part used to score 0 and
  go missing. A song title of the shape `<stem> Part <n>: <part name>` now matches a candidate
  whose title starts with the stem and names the part -- the whole-suite medley, a two-part track,
  a single-part edit -- scored 60: below an ordinary edition suffix (72), above a bare contains
  (40), so it only wins when nothing names the part more directly, and never above `medium`
  confidence even with an exact artist. Several parts that resolve to the SAME recording (a
  whole-suite medley matching every part) add it once; the reply gains a note,
  `N suite part(s) share a recording already added.`, so the added/attempted counts stay honest. A
  genuine repeat of the same part (an encore reprise) still adds twice, exactly like any other
  repeated song (#66).
- A candidate whose title scores 0 by every other rule may now still match when it's a single
  character away (one substitution, insertion or deletion) from the song's own title -- or from
  such a title followed by a space -- AND the artist agrees: setlist.fm's own typo, *Detroit 422*
  for Blondie's *Detroit 442*, used to go missing entirely. Scored 30, under the `medium` floor
  even with an exact artist, so a typo match is always `low` and the reply always asks the
  listener to check it. Only applies to a song title of 8 characters or more, so a one-edit
  collision on a short title (`Maria`/`Mario`) is never treated as the same song, and only when
  the artist agrees at all -- a one-edit title from an unrelated artist is a different song, not a
  typo (#67).

## [1.5.0] - 2026-09-28

### Added

- Every way a `/setlist` run can stop before a build now logs exactly one line:
  `setlist stopped stage=<stage>: <reason>`, at `info` level, where `<reason>` is the same sentence
  the user was shown (rackbops-bot-plugins#55). `<stage>` is one of a closed set --
  `not-configured`, `usage`, `lookup`, `stale-control`, `not-owner`, `no-pick`, `token` -- so a Loki
  query can count stops by stage: `|= "setlist stopped" | regexp "stage=(?P<stage>[a-z-]+)"`.
  Two more lines cover the same-day picker's lifecycle without counting as stops:
  `setlist picker offered: <shown> of <total> shows` when the menu goes out, and `setlist picked`
  the moment its owner makes a valid selection -- so an abandoned picker (offered minus picked) is
  countable too, and a run that reaches a build is never counted twice.
  No line ever carries a Discord user id or a token. `music-match-log.json` is untouched -- these
  are new bot-log lines only.

### Changed

- `/setlist artist:` (and `date:` search via `showsOn`) now prefers a setlist.fm result whose
  artist name exactly matches what was asked for over a looser match, such as a tribute act --
  `artist:Metallica` no longer resolves to "Some Kind of Metallica" just because it has a newer
  show. When nothing matches exactly, the build still goes ahead from the nearest loose match, but
  the reply's first line now names the artist actually used (#65).

### Fixed

- A cover credit setlist.fm writes entirely in square brackets (`[traditional]`, `[unknown]`) is no
  longer searched as an artist; the song is searched under the performing artist and still counts
  as a cover (#62).

## [1.4.0] - 2026-09-27

### Changed

- `CF-Connecting-IP` is now trusted only from a peer address that resolves to `TRUSTED_PROXY_HOST`
  (rackbops-bot-plugins#69); previously trusted unconditionally, so another container on the same
  compose network could claim a fresh rate-limit budget on every request by spoofing the header.
  New optional env `TRUSTED_PROXY_HOST` (unset = the header is never trusted, matching the old
  fail-closed behaviour minus the spoofable header). Recognizes a peer reported in IPv4-mapped-IPv6
  notation (`::ffff:x.x.x.x`, what `Bun.serve`'s dual-stack default bind reports for a real IPv4
  connection) as the same address DNS resolves in plain form -- without this, the feature above
  would never have actually engaged for a real container-to-container connection.

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
  0.4 MiB when every song of a 25-song setlist matches confidently on its first query, and a song
  that does not keeps its candidate lists, so a run where every song is missing is far larger:
  about 10 MiB across 50 runs while a song cost two queries. Since 1.6.0 a song is searched under
  up to four artist names (up to eight queries), which makes that all-missing figure about 40 MiB
  for a cover on a tribute set, and a confident song reached on its second query or under a
  fallback name keeps its candidate lists too. These are hand estimates, not measurements, and
  there is no byte cap: 50 limits the number of runs, not their size.

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
  `08-09-2026`, with `-`, `/` or `.` between the parts (`2026/9/8`, `8.9.2026`, and mixed ones
  such as `08.09/2026`), and sent on in setlist.fm's own `dd-MM-yyyy`, which its search parameter
  requires -- an ISO date there matches nothing, silently. A date that starts with a one- or
  two-digit group is always read day-first, so `09/08/2026` is 9 August; there is no month-first
  spelling.

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
