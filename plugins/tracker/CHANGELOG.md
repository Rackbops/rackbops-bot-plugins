# Changelog

## [0.6.0] - 2026-09-30

### Added

- The web area's admin view (rackbops-bot-plugins#80, slice 3; plan 5.8, 5.10), for tracker admins
  only -- the admin flag in the tracker's store, the one admin definition `/allow` already checks:
  - `/tracker/admin`: everyone on the list (registered or only admitted, zone and hour, delivery on
    or paused, tasks owned by status and received), who admitted each, the decline blocks in force,
    and a form to allow a person by Discord id. `/tracker/admin/tasks`: every task with its owner,
    status and recipients. `/tracker/admin/people/<id>`: one person and their tasks. Any task's page
    and history is readable by an admin (it already was, through `/tracker/tasks/<id>`), now with who
    owns it; an admin still cannot edit, pause or delete someone else's task.
  - Admin acts, each through the function the command path runs: allow (`/allow`'s `allowPerson`,
    with its membership check), make or revoke an admin (never the last one), resume a person's
    delivery paused after failed DMs (`DeliveryHealth.resume`, what their own next command does), lift
    a decline block (docket's `liftBlock`), and remove a person (forget-me, below).
  - The admin flag is read from the store on every request and again in the write queue before every
    act: an admin whose flag is revoked is refused on their next request. To a signed-in non-admin
    every `/tracker/admin` path, any method, answers the unknown page's 404, byte for byte; a visitor
    who is not signed in is redirected to sign in, as on every signed-in path.
  - An admin named in `TRACKER_ADMIN_DISCORD_IDS` (made admin again at every start) cannot be revoked
    or removed from the web: their page says to take them out of the configuration first. Forgetting
    themselves is allowed, with a note that the next start makes them again unless the configuration
    no longer names them.
- Forget-me (plan 5.8): `/tracker/forget`, linked from Settings -- a page, then a post that asks,
  then a post with `confirm=yes` and the typed word `forget`. In one transaction it deletes (not
  archives) the person's tasks, archived ones included, and everything under them; their recipient
  rows, replies, history rows and delivery records on everyone else's tasks; the decline blocks they
  are either side of; their admission, delivery health, sessions and sign-in links; and their person
  row. Another owner's task paused only for them goes back on. Other people's audit columns that
  named them (`admitted_by`, `lifted_by`) become `forgotten`. Text is matched only in the forms the
  code writes ids into, never as any id-like word; their id in another owner's run error is redacted,
  not the row deleted. A pause row from before 0.6.0 (it names the display name) is deleted only on a
  task they received where no other recipient has the same name; one under an older name is kept. They are signed out everywhere and the cookie is cleared; they can come back
  only when an admin allows them again, as a new person with a new id. An admin can remove a person
  the same way, with the same confirmation. Web only: the plan asks for no Discord command.
- The nav shows Admin to admins.

### Changed

- The database now runs with `PRAGMA secure_delete = ON`, so a deleted row's bytes are overwritten.
  The first start on an existing database runs one `VACUUM`, so pages freed before `secure_delete`
  was on are rewritten too. It is recorded in a `tracker_meta` table, not a schema bump -- the schema
  stays at 3, so a rollback to 0.5.0 still opens the database. A VACUUM that fails (a reader holds
  the file) is logged as a warning without failing activation, and retried at the next start. The write-ahead log is checkpointed after an
  erasure without waiting on readers; a busy checkpoint is logged.
- A pause for a recipient is recorded by their id (`delivery to {u5} paused: ...`) and shown with the
  name they have when the history is read, instead of the name they had when it was written.
- Forget-me waits, outside the write queue, until no notify or poll tick is running (at most 20 s,
  then 503 and nothing deleted), so a DM already in flight to the person is not recorded after they
  are gone and nobody else's command waits behind it. A failed DM to a person no longer in the store
  (an invitation's, sent outside any tick) no longer counts toward a pause or writes a row; an
  invitation whose DM comes back after its task or invitee was erased writes nothing; a `/price`
  whose page read finishes after its person was forgotten makes nothing.
- Internal: `DeliveryHealth` exposes its lock (`exclusive`) and `release` for the erasure; docket's
  Store port has no delete, so listing people and blocks and erasing a person are plain SQL in the
  plugin (`src/roster.ts`); docket is unchanged.

## [0.5.0] - 2026-09-29

### Added

- The web area's task editor (rackbops-bot-plugins#80, slice 2, plan 5.10): a signed-in person makes,
  edits, pauses, resumes and deletes their own reminders, renewals and price trackers from the web
  pages, under the rules the commands enforce -- the same functions run both.
  - New: `/tracker/new/reminder`, `/new/renewal` and `/new/price`, linked from My tasks, with the
    options of `/remind`, `/renewal` and `/price` and their defaults, limits and messages (a price's
    page is read once before anything is made; at most 20 price trackers per person, counting the
    ones made in Discord; `near` becomes the same bounded pattern). One new price tracker's page
    read at a time per person on the web, which has no Discord rate limit in front of it.
  - Edit: `/tracker/tasks/<id>/edit`. A reminder's text, time and repeat (an empty time keeps the
    one it has, unless the repeat changes); a renewal's name, amount, currency, date, unit, every,
    lead and note (a new amount replaces the one the next ask quotes; a new date gets `/renewal`'s
    first-ask rule, but a date a run already asked about is not asked about again); a price's name, interval, drop and
    baseline -- not its page, since another page is another tracker. A schedule change cancels and
    replaces what is queued, keeping snoozes, as a zone or hour move does; a changed title or config
    is one `edited` event; nothing changed writes nothing. A field left empty (or not sent) keeps
    what the task has -- an empty note clears it, and an empty price name goes back to the page's
    address. A renewal date that is one of the schedule's own period dates (as the form offers once
    the first date has passed) keeps the stored schedule and its anchor, so a monthly renewal on the
    31st stays on the 31st; only a different date re-anchors. A finished task cannot be edited.
  - Pause and Resume on a task's page. A task the owner paused sends nothing until resumed, and a
    person's delivery resuming does not un-pause it; resuming gives it its next run (a run missed
    while paused fires once, late). A zone or preferred-hour change re-times a paused task's held run
    -- the same occurrence (period date, or local day) at the new zone or hour, still one run, snoozes
    kept -- so resume fires it once, late, never at the old time and never lost. Resume on a task paused for failed DMs goes on without the
    recipients who could not be DMed, as `/task resume` does.
  - Delete takes two posts: the first shows what will happen, the second (with `confirm=yes`)
    archives the task. It leaves every list, its queued runs are dropped and nothing more is sent;
    its history stays on record (an admin can see every task) and its page stays for the owner. The
    store has no way to erase a task; that is forget-me's, later.
  - Every editor post goes through the same gates as settings: the session (re-checked, with the
    membership re-check), the per-session CSRF token and the `Origin` check. The task is loaded by
    its id and must be the viewer's own, checked again in the write queue; anyone else's task, an
    admin's view of one included, answers the same 404 as an unknown id. A refused form comes back
    with what was typed, escaped, and the reason. Only fixed notices are shown after an action;
    nothing from the address is echoed. No GET changes anything.
- `/task resume` also resumes a task its owner paused on the web (before, it answered that the task
  was not paused by failed DMs).

### Changed

- A form body may now be up to 32 KiB (was 8 KiB), so the longest reminder fits in any script; a
  declared `Content-Length` over it is refused unread, and a body is read only up to the cap.
- The price cap's message says a tracker can also be deleted on the web, when the web area is set up.
- At most 200 active or paused tasks per person, of every type together (`MAX_LIVE_TASKS`), checked
  when a reminder, renewal or price tracker is made, in Discord and on the web alike.
- One set of length limits (`src/limits.ts`) for the slash options, the web forms' `maxlength` and
  the server's own checks: a price's page (1000), a `when` or `until` (100), a name (100), a note
  (300), `near` (100), a reminder's text (1500), a currency (3), a zone (64). The server now checks
  the page's length and the `when`/`until` length itself, not only Discord.
- A `/settings` or `/register` zone or hour change also moves the recurring tasks the person has
  paused (by hand or for failed DMs), not only the active ones: the run each was holding is kept,
  re-timed for the same occurrence (`src/retime.ts`), so a renewal's due ask or a missed reminder
  still goes out once, late, on resume.
- Internal: `/remind`, `/renewal` and `/price` now run shared plan functions (`reminderPlan`,
  `renewalPlan`, `priceSettingsPlan`, `startPrice`/`previewPrice`/`finishPrice`) that the web
  editor runs too; the price tracker moved to `src/price.ts` and reminders to `src/reminders.ts`.
  A renewal's `unit` and a reminder's `repeat` are now checked against their choices there (Discord
  already offered only those). No schema change.

## [0.4.0] - 2026-09-29

### Added

- Renewals and the price tracker (rackbops-bot-plugins#81, plan E6): two more task types on the
  notify side, no model, nothing sent to city-hall.
- `/renewal name amount currency renews [unit] [every] [lead] [note]`: docket's `renewal` on a
  `period` schedule from the next renewal date, asking `lead` days before each (default 7) at the
  preferred hour, with Keep, Cancel, Renewed and Snooze. When that ask is already past but the date
  is not, the first ask comes within a minute. Keep and Renewed record what was paid; Cancel ends it.
- `/task decide task choice [amount]`: answers a renewal's latest ask with the amount actually paid,
  instead of a button.
- `/price url [name] [hours] [drop] [baseline] [near]`: docket's `price` on a `poll` schedule every
  `hours` (default 12, at most 168). The page is read once before anything is created, and nothing is
  created without a price in it; a drop of `drop`% (default 10) from the last, first or highest price
  seen DMs the owner once per crossing. `near` (the words before the price) stands in for a
  free-form pattern. At most 20 per person.
- `/task history` shows a renewal's paid periods and total, and a price's last check, readings, low
  and high.
- Page reads (`fetch.ts`) go only to the public internet: http or https on the default port, no
  credentials, every resolved address public, redirects re-checked (at most 5), 15 s, 3 MB. The body
  is rebuilt in linear time to what price extraction reads (`page.ts`), since docket's extraction
  patterns take quadratic time on a page of unclosed tags.
- A second host tick, `poll`, runs the page readers after `notify`, so a slow page never holds up a
  reminder due now. A read the tick's abort cuts short requeues its run instead of counting a miss.
  No schema change.

## [0.3.0] - 2026-09-29

### Added

- The web area's first slice (rackbops-bot-plugins#80, plan 5.10), served under `/tracker/` on
  the bot's HTTP through the instance's tunnel: my tasks (the same list as `/tasks`, each linking to
  its history), a task's history (the same data and the same rule as `/task history`: the owner, an
  accepted recipient or an admin; anyone else gets the same 404 as an unknown id), and settings
  (preferred hour and time zone, checked as `/register` checks them, recurring reminders moved
  with them). Server-rendered HTML, forms only, no script, styled with `@rackbops/styles`'
  rackbops-noir theme bundled into the plugin and served at a hashed path.
- `/web`: an ephemeral one-time sign-in link, through the usual gates, good for 10 minutes and one
  use. Opening the link never uses it up (a link preview cannot burn it); its page's Sign in button
  does, then sets a 7-day session cookie (`HttpOnly; Secure; SameSite=Lax; Path=/tracker/`) and
  redirects so the token leaves the address bar. Only SHA-256 hashes of link tokens and session
  ids are stored. Every request re-checks that the person is still on the tracker and registered,
  and signs them out everywhere when not. Every form post carries a per-session CSRF token, and a
  post whose `Origin` is not `TRACKER_WEB_URL` (or is `null`) is refused; the sign-in post carries
  its own double-submit token, so another site cannot sign a person in as someone else. Pages send
  `Referrer-Policy: same-origin` (under `no-referrer` a browser sends a form's `Origin` as `null`).
- With `TRACKER_GUILD_ID` set, the web area re-checks membership: a session last confirmed 15
  minutes ago or more is checked with one member lookup (at most about 3 seconds), through the
  discord.js Client of an interaction the plugin has handled since start. Someone who left the
  server is signed out of every session; a lookup that fails, or no interaction yet, is allowed
  while the last confirmation is under 24 hours old, and signs them out after that. Concurrent
  requests share one lookup per person, and a person whose lookup failed is not looked up again
  for a minute.
- The README says to keep the web origin on a domain whose sibling subdomains are all yours: a
  sibling can set a `__Secure-` cookie on the parent domain, and `__Host-` cannot be used with
  `Path=/tracker/`.
- The new optional `TRACKER_WEB_URL` (not secret): the https origin the bot is reached at, e.g.
  `https://clerk.example.com`. Links and the allowed `Origin` come from it, never from the
  request's `Host` header. Unset = no web area: `/web` says so and the pages answer 404; a value
  that is not a bare https origin refuses to load.
- Schema 3: `web_login_tokens` and `web_sessions`. A 0.2.0 database migrates in place on first
  start. **Rolling back** to 0.2.0 afterwards does not work (0.2.0 refuses a newer database); keep
  a copy of `tracker.sqlite` from before the upgrade to roll back.

### Fixed

- The membership gate (`TRACKER_GUILD_ID`) asked discord.js's member cache rather than Discord:
  the member lookup now passes `force: true`. With only the Guilds intent the bot never hears that
  a member left, so someone who had once used the tracker in the server stayed a member forever
  when they used it from DMs (0.2.0's gate) -- and would have on the web.

## [0.2.0] - 2026-09-29

### Added

- The Discord surface (rackbops-bot-plugins#79, the first slice of plan E2): `/allow @user`
  (admins), `/register [hour] [zone]` with the disclosure that an admin can see every task,
  `/remind text [when] [repeat]` (a one-off, or daily, weekly or monthly), `/tasks`,
  `/task done|snooze|history|share|resume`, and `/settings hour`. Every answer is ephemeral, and the
  commands work in the bot's DMs as well as in a server.
- The admission gate (only people an admin has `/allow`ed, or the configured admins, can
  `/register`; everything else needs a registered person) and the membership gate: the new
  optional `TRACKER_GUILD_ID` names the one server whose members may use the tracker, checked on
  every command and button, DMs included. Unset = no membership gate.
- Buttons on every DM: done and snooze for the owner, accept and decline on the one consent DM a
  shared task sends, an opt-out on every copy a recipient gets, and a Reply button that opens a
  modal, so the tracker never reads a typed DM and never needs the Message Content intent. A
  pressed DM is edited to say what happened. A host from before rackbops-discord-bot#323 gets the
  DM again without buttons.
- Pausing delivery after three DMs in a row that the host says cannot be delivered (plan 5.5):
  every task that would DM the person pauses, on record in its history, and their other runs due
  in the same tick are held for the resume rather than failed. The owner of a task paused for a
  recipient is DMed once and sees why in `/tasks`; the task resumes when the recipient next uses
  the tracker, or `/task resume` goes on without them. A person paused for their own DMs is told,
  and resumed, the next time they use a command.
- Declining an invitation and opting out always work: those two buttons skip the membership and
  registration gates.
- Schema 2: `admissions` (who admitted each person, when they registered; the people 0.1.0 made
  from `TRACKER_ADMIN_DISCORD_IDS` are backfilled as admitted by the configuration),
  `delivery_health` and `delivery_pauses`. A 0.1.0 database migrates in place on first start.
  **Rolling back** to 0.1.0 afterwards does not work: 0.1.0 refuses a database newer than it knows
  and does not load. Keep a copy of `tracker.sqlite` from before the upgrade to roll back.

### Fixed

- A due run of a task that is not active (paused) is no longer run: docket 0.3.0's notify lane
  runs every queued occurrence whatever its task's status, so the tracker's lane now skips them.

## [0.1.0] - 2026-09-29

### Added

- The task tracker's core (rackbops-bot-plugins#78), the host of
  [`Rackbops/docket`](https://github.com/Rackbops/docket) (`@rackbops/docket-core` and
  `@rackbops/docket-types` 0.3.0, bundled): docket's Store port on `bun:sqlite` in
  `<dataDir>/tracker/tracker.sqlite`, passing docket's `STORE_CONTRACT`; the notify lane on the host's
  60-second tick, delivering by `host.dm`, with each delivery claimed before it is sent so a
  restart or an abandoned tick never sends one twice (a refusal before anything reaches Discord
  releases the claim); people (Discord id, time zone, preferred
  hour, admin flag) in the tracker's own store, the first admin from `TRACKER_ADMIN_DISCORD_IDS`;
  and `GET /tracker/healthz`, `503` once the last tick is more than three minutes old. Runs the
  `reminder` and `renewal` types only (`price` waits on the Fetch port). No commands yet (#79)
  and no buttons (they wait on rackbops-discord-bot#323).
