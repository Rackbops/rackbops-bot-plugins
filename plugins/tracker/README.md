# tracker

The task tracker for Rackbops Clerk: the host of [`Rackbops/docket`](https://github.com/Rackbops/docket)
on a rackbops-discord-bot instance. Plan of record: Rackbops/Tooling
`research/city-hall-task-tracker.md` (sections 0, 5.1-5.3, 5.5, 5.8, 5.10). This version is the core
(rackbops-bot-plugins#78), the Discord surface of the first slice (#79) -- reminders by slash
command, delivered by DM, answered by button, with history -- the first slice of the web area
(#80): sign-in by one-time link, my tasks, a task's history, and settings -- renewals and
the price tracker (#81, plan E6): two more types on the notify side, no model, nothing sent to
city-hall -- the web area's task editor (#80, slice 2): make, edit, pause, resume and delete
your own tasks from the web, under the commands' own rules -- the admin view and forget-me (#80,
slice 3) -- the JSON task API with personal API tokens (#80, slice 4), for a program acting as
you, such as a later intake agent (plan E10) -- and the one-off research request (#82, plan E8,
category 5): a question looked into on the web by a model run, checked by a second run against its
sources, and DMed once, with its claims kept as findings -- and an admin raising one person's
daily model ceiling from the web (#82, plan 5.7), with an operator switch that turns the daily
ceilings off for the alpha and an admin page of daily model usage to evaluate it by -- and the
interest scout (#83, plan E9, category 1): a model run every few days that looks on the web for
things that fit someone's interests through a gift lens, DMs what it found, and does not show the
same link twice -- and the want-list watcher (#83, plan E9, category 2): a watch on one wanted thing
that reads a listing page you paste, or BoardGameGeek's marketplace through BGG's API once its
token is set, every few hours with no model, or, for eBay (and BGG without that token), the
listings you send in through the task API every hour -- the watcher never opens eBay, nor any site
for these; your own browser finds them, such as Claude in Chrome running in it -- and DMs each new
listing within your limits once, until you press Done, and, while the model runner is set up, has
the model look at each new listing first -- is it the thing, and what does it show about the
seller -- before DMing it -- and the daily "today and
overdue" digest (plan 5.5): at most one DM a day at each person's preferred hour listing their
reminders and renewals due today or overdue, never two due within 20 hours of each other. That
skips one local day after a move east into a day whose hour has come, after moving the preferred
hour more than 4 hours earlier, and after a move west across the date line. The model runs never happen here: they go
through city-hall to Rackbops/docket-runner on roshne's own host (plan 5.12), and the whole execute
lane stays off until the city-hall Executor is configured (Configuration below).

## Commands

Every answer is ephemeral. The commands register globally, so they work in the bot's DMs as well
as in a server (plan 5.5, item 39).

| Command | Who | What |
|---|---|---|
| `/allow user` | a tracker admin | Admits a person: they can now `/register`. With the usr link on (0.21.0), run in a server, it also allows them in usr as `tracker:member` and keeps their usr user id. The admin must be linked in usr and hold `tracker:register` and `tracker:member` there. Run again, it asks usr again (usr only ever adds), so it links someone not yet linked and relinks someone whose usr link was made anew. The usr user id is final only once they have signed up on usr: one who finishes signing up while signed in to a usr account they already had is moved to it by usr, and the account `/allow` made is dropped, so their usr sign-in fails until a second `/allow`, or an admin's Refresh usr links, links the one they have. A usr refusal or outage leaves the admission standing and says what to do; in a DM it says to run it in the server. |
| `/register [hour] [zone]` | an admitted person | Signs up, or changes the preferred hour (0-23, default 9) and time zone (default `America/New_York`). The reply says an admin can see every task. With the usr link on (0.21.0), run in a server, it also carries a linked person's one-time usr sign-up link, until usr says they have signed up; in a DM it says to run it in the server. If usr says they are not allowed yet (a usr admin removed their link), it forgets their link and says to ask for `/allow` again. See **First admin and usr** below. |
| `/remind text [when] [repeat]` | a registered person | A reminder by DM. `when` is docket's `parseWhen` grammar (`in 20 minutes`, `tomorrow 9am`, `fri at 17:30`); `repeat` is once (the default), daily, weekly or monthly. A repeating one with no `when` starts today at the preferred hour. |
| `/renewal name amount currency renews [unit] [every] [lead] [note]` | registered | A subscription, domain, warranty or membership (docket's `renewal`, a `period` schedule). `amount` is from 0 to 1,000,000 (`MAX_AMOUNT` in `src/limits.ts`; `/task decide`, the web editor and the task API take the same range); `renews` is the next renewal or expiry date, `YYYY-MM-DD`, today or later; `unit` yearly (the default), monthly, weekly or daily, `every` how many of those; the ask comes `lead` days before (default 7) at the preferred hour, with Keep, Cancel, Renewed and Snooze. If that ask is already past but the date is not, the first ask comes within a minute (a zone or hour change before it fires drops it for the next period's). Keep and Renewed record what was paid; Cancel ends it. |
| `/price url [name] [hours] [drop] [baseline] [near]` | registered | A price (docket's `price`, a `poll` schedule every `hours`, default 12, at most 168). `url` may be any public web page (Page reads, under What it does), eBay's and BGG's included, or a link that redirects to one; only the want-list watcher refuses eBay. The page is read once at once, and nothing is created unless a price is found in it; then the first check, within a minute, DMs the starting price, and a drop of `drop` percent or more (default 10) from the `baseline` -- the last (default), first or highest price seen -- DMs the owner once per crossing. `near` is the words just before the price, for a page with no structured price. At most 20 per person. |
| `/research question [context] [deadline] [at] [sources]` | registered | A one-off research request (docket's `research`, a `once` schedule at `at`, default now). A research run splits the question into its parts and looks each up on the web (read-and-web tools only, plan 5.6), naming each part's best source and trying it -- BoardGameGeek included, read honestly, a page that refuses it listed as one it could not open (with the web area; without it, named as a gap) -- and never opening eBay (eBay's User Agreement, section 3; since 0.30.0, docket-types 0.10.0), a reviewer run checks the draft against its sources, and only a passed answer is DMed to you (and accepted recipients); its claims are kept as findings on the task's page. `deadline` (docket's `parseWhen`) goes into the request; a run that would start past it makes no call and tells you. `question` must hold the question itself: fewer than 3 characters, or no letter at all (a stray `0`), is refused before anything is made. At most 5 waiting per person (a request waiting for pages for a fuller pass, below, not counted: its first answer is delivered); every run counts against the daily budget (below). `sources: browser` (0.28.0, docket-types 0.8.0's `sources: "sent"`; default `web`) answers from pages your own browser gathers instead -- ask Claude in Chrome to gather them and send them in through the task API (`POST /api/v1/tasks/<id>/sources`, then `/sources/ready`; Task API below), for pages a web run cannot or may not read, such as a BoardGameGeek page that refuses it or eBay, which the research never opens: it answers only from the pages sent in, and the request waits for them, its run queued 14 days out or 10 minutes before the deadline, whichever is sooner (a deadline less than 20 minutes away is refused; the margin makes a missed deadline unlikely, not impossible, since a run held by the budget or behind another Job can still start late), and moved to now by `ready`; a request whose `ready` never comes runs then on whatever pages are in, and with none makes no model call and DMs you so. `at` does not go with it, and it needs the web area. **A fuller pass** (0.29.0, docket-types 0.9.0; with the web area only): when the research run lists pages it needed and could not open (a best source that refused it, BoardGameGeek's included), the reviewed answer is DMed with a "Couldn't open:" list, and the request waits for pages for up to 14 days (or until 10 minutes before its deadline), sending, running and charging nothing; ask Claude in Chrome to gather them and send them in as for a browser request, and `ready` starts a second pass that DMs an "Update to ..." of what it adds or corrects. With no `ready` by then, the second pass runs on whatever pages are in, and with none the request ends and the first answer stands. Answers that research is not available while the city-hall Executor is not set up. |
| `/scout new interests [lens] [for] [notes] [every]` | registered | An interest scout (docket-types' `scout` type, since 0.6.0; plan 1.2 row 1): every `every` days (default 1, at most 30) at your preferred hour, a model run looks on the web for 5 to 10 things published or available in the last 30 days that fit the `interests` (separated by commas, at most 20, each at most 80 characters) through the `lens` -- `general` (the default), `birthday` (fun or a little grandiose), `anniversary` (a romantic angle) or `christmas` (tied to their interests) -- for `for` (someone else, e.g. Anne; empty means you), weighing `notes`, and DMs them to you (and accepted recipients). A link it showed before is not shown again (it remembers the newest 300); fewer than five come with the run's reason. At most 3 scouts per person; each run counts against the daily budget (below), up to 1.50 USD. Answers that the scout is not available while the city-hall Executor is not set up. |
| `/want name source [target] [max] [currency] [exclude] [confirm] [unconfirmed] [hours] [judge]` | registered | A want-list watch (docket-types' `wantlist` type, or `wantjudge` when judged, since 0.6.0; plan 1.2 row 2). `source` is `page`: `target` is a shop's listing or search page, checked like `/price`'s page and read once at once -- nothing is made unless its structured product data (JSON-LD `ItemList`s and `Product`s) lists something; `bgg`: `target` is a BoardGameGeek game's address or id, read through BGG's XML API while `TRACKER_BGG_TOKEN` is set; `shopify` (since 0.32.0): `target` is the words to search Shopify stores for (the name when empty), one Shopify catalog search per look through Firecrawl's Alexandria while `TRACKER_FIRECRAWL_KEY` is set (refused without it), for new copies in stock at or under `max`; a product counts only when its title has every word, and each look costs 5 Firecrawl credits, so `hours` is 24 to 168 for it; or `ebay`: with the eBay keys (`TRACKER_EBAY_CLIENT_ID` and `TRACKER_EBAY_CLIENT_SECRET`, since 0.33.0), one search per look through eBay's own Browse API (docket-types' `ebaySource`; eBay US, the newest fifty, narrowed by `max`), for listings whose title has every word of `target` (the words, the name when empty), new and used, an auction at its current bid (or its Buy It Now price, when it has one), the seller's name, feedback percentage and score shown; every hour by default, and the watcher still never opens an eBay page. Without the keys, `ebay` is an **inbox watch** (since 0.19.0; docket-types' `inbox` source), whose listings are sent in rather than read -- the watcher never opens eBay. A watch made before the keys were set stays an inbox watch; one made with them that outlives the keys fails each look and tells its owner once. An eBay API watch takes no alert emails: an alert for its words is left without a DM. It keeps no eBay data, so that the keyset may opt out of eBay's account-deletion notices: no finding is stored, its listings are in the DM only, six hours after a run its stored copy of the DM keeps only its first line and a link to eBay's own search (`ebay-forget.ts`; a send still owed then sends that), and it is never judged, whatever `judge` says, since a judged watch's Job is kept by city-hall's queue. For an inbox eBay watch, `target` is the words to search eBay for (the name when empty); the answer gives the watch's id, how listings reach it -- you search eBay in your own browser, such as with Claude in Chrome, and send what it finds to `POST /api/v1/tasks/<id>/listings` (Task API below), or, while the alert-email route is on (0.25.0, Alert emails below), forward eBay's saved-search alert emails to your alert address, which the answer gives -- and the eBay search itself, with `max` as eBay's own top price, to save on eBay too. `bgg` while the token is unset (BGG declined the application) is an inbox watch the same way: `target` is then a BGG game (kept as its id) or the words to look for (the name when empty). An inbox watch needs the web area (`TRACKER_WEB_URL`), since its listings arrive through the task API; without it, it is refused. It also needs the bot's `HTTP_PORT`, which the tracker cannot see: with `TRACKER_WEB_URL` set and `HTTP_PORT` unset, the watch is made but nothing can send it listings. Every `hours` (default 12 for a page, 24 for BGG and Shopify, 1 for eBay's API and for an inbox watch, whose reads cost nothing, at most 168) on the `poll` tick, the watch DMs each listing at or under `max` (then only listings that show a price) and in `currency` (when set) that it has not DMed before, up to 5 lines with the rest in `/task history`'s second message (up to 20, as many as fit in one message, the newest kept; the task's page in the web area shows the newest 50), with a Done button that ends the watch. Each listing DMed is a finding (an eBay API watch's excepted, above: its extra listings are left to eBay's own search). Three reads in a row that find nothing tell you once (a page whose list is empty is a search with no results, not nothing read). At most 20 new listings a run, the rest the next run. A redirect to eBay is refused on every hop. At most 20 watches per person, judged or not. eBay's pages are refused as a `page`. **Judged** (`judge`, default yes while the model runner is set up; `judge: true` without it is refused; fixed once made): the reads stay plain code, and new listings within the limits go to one `claude -p` Job first (docket-types' `wantjudge`, plan 5.4, item 63), which may open only those listings' pages on the watch's own site (never eBay, no web search) and says for each `match`, `maybe` or `no`, why, and what its page shows about the seller, as signals; the DM shows the `match` and `maybe` ones with those notes, and every listing is a finding with its verdict. 12 turns, 0.50 USD, 5 minutes a look; a look that fails for good sends the listings unchecked. Its reads are uncharged and its looks charged, like any model run; both wait while its owner is at a daily ceiling (with the budgets on). The judge may open only pages on the watch's own host (the pasted page's, or BGG's), and none at all for an inbox, Shopify or eBay watch: it judges from what each listing says. **`exclude`** (since 0.38.0, docket#77): words or phrases separated by commas, at most 20 of 80 characters each (1,000 characters in all); a listing whose title has any of them, as whole words in that order (case, accents and punctuation ignored, docket-types' `isExcluded`), is left out of every source before it is DMed or judged, and the confirmation names them. For a Shopify or eBay-API watch, a one-word entry that is one of the words searched for is refused, since every listing it keeps has that word. A field with no words in it is refused. **`confirm`** and **`unconfirmed`** (since 0.40.0, docket 0.20.0; the Arkham pilot of #368): words or phrases in the same form, at most 300 characters each field. A listing whose title has no `confirm` word is read in full where its source can (an eBay API watch reads it through eBay's getItem: its item specifics and description), then DMed if that has one, left out if its title or full listing has an `unconfirmed` word (remembered as told, so it is not read again), and otherwise DMed marked `check: not confirmed as "<first confirm word>"`. For a plain watch only: with `judge: true` they are refused (but an eBay API watch is never judged, so it takes them whatever `judge` says), and with `judge` left out they make a plain watch; the web editor always sends `judge`, so set it to no there. `unconfirmed` needs `confirm`; for a Shopify or eBay-API watch, a one-word `confirm` entry that is a searched word is refused. Every new listing of an eBay API watch is read in full once (at most 20 a run, together), so its DM lines also show shipping; nothing of the read is kept but that shipping text in the DM, which is cut after six hours like the rest of an eBay DM. |
| `/scout edit task [interests] [lens] [for] [notes] [every]` | registered | Changes your scout: `interests` replaces the whole list; anything left out stays; `for` or `notes` set to `-` clears it. A change of `every` keeps the start day. |
| `/news new subject [include] [exclude] [disambiguate] [shows] [every]` | registered | A news watch (docket-types' `news` type, since docket 0.19.0; plan item 153): every `every` days (default 7, at most 30) at your preferred hour, a model run looks on the web for items about the `subject` (at most 200 characters, with enough to tell it apart) from the last 30 days that are of a kind `include` names (separated by commas, at most 10, each at most 80 characters; empty means any news). Items seen before, eBay links, and items whose title or kind has an `exclude` word or phrase (separated by commas, at most 20) are dropped; `disambiguate` (at most 500 characters) says what similarly named acts or things it is not, and `shows` asks for each show's city, venue, date and tickets. When anything is left, a second run checks each item against its own page, and only what it keeps is DMed to you (and accepted recipients), each kept as a finding; a run with nothing new sends nothing and says "no news" in its history, and three failed runs in a row (search or review) are told to you once. At most 3 news watches per person; each run counts against the daily budget (below), up to 1.50 USD for the search and 0.75 USD for the review, each try (a failed try is retried once). Answers that the news watch is not available while the city-hall Executor is not set up. |
| `/news edit task [subject] [include] [exclude] [disambiguate] [shows] [every]` | registered | Changes your news watch: anything left out stays; `include`, `exclude` or `disambiguate` set to `-` clears it. A change of `every` keeps the start day. |
| `/tasks` | registered | Your active tasks and the ones you receive, each with its next run; then your paused ones, each naming up to three people it could not DM (then how many more). A list longer than one message (Discord's 2000 characters) is cut between whole lines and keeps your paused tasks in preference to the active ones that do not fit, since their ids are what `/task resume` needs (any paused ones that still do not fit are counted); it says how many active ones it left out and, when the web area is set up, points to `/web`, which lists them all. |
| `/task done task` / `/task snooze task [until]` | the task's owner | Answers the task's latest reminder (snooze: an hour, or until `until`). |
| `/task decide task choice [amount]` | the renewal's owner | Answers the renewal's latest ask -- keep, cancel or renewed -- with the amount actually paid when it changed (a button cannot carry one). Use it instead of the button, not after it: a run is answered once. |
| `/task history task` | the owner, an accepted recipient, or an admin | The newest 10 runs -- due, status, how it was answered, text replies -- and the newest 5 of the task's changes, older ones counted (only the shown rows are loaded; SQLite still counts the rest, and for the runs sorts them too); sent with Discord's suppress-embeds flag, so a link in a reply, a finding or an error does not unfurl into a preview; for a renewal, what each period cost and the total; for a price, the last check and the readings with the low and the high; for a want-list watch, how many listings it has kept, and once there are any, a second message with the newest of them, up to 20 and as many as fit in one message, then how many more there are (and, while the web area is set up, that the task's page there shows the newest 50). |
| `/task share task user` | the task's owner | Invites an admitted, registered member who can be DMed: they get one consent DM with accept and decline. An invitation still open when the task is deleted or finishes is withdrawn, with a history event; a late Accept or Decline is refused with "That task was deleted." or "That task is done." and records nothing (one on a paused task still counts). |
| `/task resume task` | the task's owner | Resumes a paused task: one paused because a recipient could not be DMed goes on without that recipient; one its owner paused on the web simply goes on. |
| `/settings hour hour` | registered | The preferred hour; recurring reminders with no time of their own move to it. |
| `/web` | registered | A one-time link to sign in to the web area (below), good for 10 minutes and one use. Says so when `TRACKER_WEB_URL` is unset. |

**Gates.** Every command and button checks, in order: membership of a `TRACKER_GUILD_ID`
server (when set; a member of any listed server passes, and in a server `TRACKER_GUILD_ROLES` names
roles for, only while holding one of them), admission (in the tracker's store), then
what the action needs (an admin for `/allow`, admission for `/register`, registration for the
rest). A person nobody admitted is told to ask an admin to `/allow` them. Decline and opt-out skip the membership and registration gates,
so anyone can always stop the messages; the Reply button checks membership when its modal is sent.

**Buttons.** The owner's DM carries Done, Snooze 1h and Reply; a recipient's copy carries the
opt-out and Reply; the consent DM carries Accept and Decline. Reply opens a modal whose text is
kept on the task as one plain line: each run of line breaks, spaces, control characters and
invisible format characters becomes one space, but for a few format characters real text needs
(the zero-width joiner in an emoji, the non-joiner in a Persian or Indic word, the soft hyphen,
and the signs Arabic, Syriac and Kaithi write with a number). A reply of only spaces, line breaks,
zero-width characters or blank fillers is refused as empty. `/task history`, the web task page and
the task API show up to 80 characters of it, on one line; in `/task history` a masked link,
mention, timestamp, spoiler or code in it is shown as typed, except that a mention or timestamp
typed right after a bare link may still show as one. A mention there never pings. docket decides
who may answer what (the owner alone answers a run, item 34). A pressed DM is edited to say what
happened.

**Pause after failed DMs** (plan 5.5). Three DMs in a row that the host says cannot be delivered
pause the person's delivery and every active task that would DM them, theirs and the ones they
receive (a `paused` event in each task's history; one for a recipient is shown only to that
recipient, the task's owner and admins -- a row from before 0.6.0, only to the owner and admins;
another recipient sees `paused: delivery paused` in its place, as they see the owner's own delivery
pause, and `resumed: delivery resumed` for the resume after either, and a failed run's error that
names another recipient, forgotten or not, reads `a recipient cannot be messaged`);
a DM to them still owed waits for the resume.
A task that comes to DM them while they stay paused -- one made on the web or through the task API,
one its owner had paused and resumes by hand, one a pause stopped part way never reached -- pauses
the same way at its first DM, which then waits too. Only a send for a task already finished (a
research answer, say) is not held: docket's eight deferrals of it run out (about two hours), and it
fails; a research answer's claims are still on its task page (Findings, below).
The owner of a task paused for a recipient is DMed once and sees why in `/tasks`; the task
resumes when the recipient next uses the tracker, or `/task resume` goes on without them. A person
paused for their own DMs is resumed, with every task nothing else holds, by the next command or
button they use (all but Decline and opt-out), which tells them why (a command tells them above its
answer, or in a message of its own after it when the two would not fit in one); by Resume DMs, on
the banner every web page shows them while they are paused; by resuming a paused task of their own
(`/task resume`, or Resume on the web or through the task API); or by an admin's Resume delivery.
Nothing else on the web or through the task API resumes them.
A DM that goes through clears the count. Only a DM the host says cannot reach that person (Discord's
50007, or 10013 for an account that is gone) counts, once per run: docket fails it for good at once. A DM refused for
its content is retried by docket (three tries, a minute apart and doubling) and does not count; nor
does one whose outcome is unknown (see Delivery below).

**Delivery** (docket 0.4.0). docket records each DM in the store's `deliveries` table before it is
sent (a claim) and settles it after: sent, failed (for good, or owed and retried later), or
unconfirmed -- the send may or may not have reached Discord, so it is never resent, and a warning is
logged. A run has fired once its record is written; the other recipients of a run still get their
copies when one of them cannot be reached, and the run is `done`, not `failed`, whatever a DM did.
At start the plugin runs docket's `recover()`: a run left running is requeued, and a claim left open
by a stop mid-send is settled unconfirmed and logged.

**Research and the execute lane** (docket 0.5.0, #82). A research request is two model Jobs, run
one after the other through city-hall's execute lane ([Lepid-Labs/city-hall#18](https://github.com/Lepid-Labs/city-hall/pull/18)) by the runner that
carries `TRACKER_CITY_HALL_CAPABILITY` -- only docket-runner, on roshne's subscription (plan items
70, 71). The tracker submits each Job with `POST /api/execute/jobs` under a prefixed key,
`rackbops-tracker:<database id>:<docket's Job key>` -- the database id is random, made once and kept
in `tracker_meta`, so two tracker databases (two instances, or one whose database was replaced)
never share a key at city-hall. A `200` (a key city-hall already knew) must carry this Job's own
prompt, or the run is refused and the mismatch logged. The tracker stores city-hall's job id in its
own `executor_jobs` table before going on -- if that write fails, the run is asked again and the
same key hands back the same job -- and asks `GET /api/execute/jobs/:id` each minute until it is
done: one Job at a time across everyone (plan 5.3), on a tick of its own that runs in the
background, so a slow city-hall never holds up a reminder. While that tick waits on city-hall it
holds its tasks: the notify tick sends their DMs a minute later, and a command, button or web
action on one of them answers "That task is with the model runner right now; try again in a
minute." at once, so no one else's command waits behind it. The one exception is a zone or hour
change by the owner of a scout the tick holds: it waits for the tick, and so does every command,
button and web write queued behind it (see **One task at a time** below). city-hall unreachable or
timed out (logged once an hour, naming only the error's kind, never its message), a 5xx, or a
refused credential or edge redirect (logged once an hour as such, and the admins told once per Job)
holds the run and asks again; a Job still not back after six hours is given up (docket's
`PENDING_LIMIT_MS`). A record in `executor_jobs` goes once its run is gone, or once it was
submitted over 30 days ago and its run is no longer queued or running.

**A runner that stops: city-hall requeues, the tracker waits.** city-hall puts a job back in its
queue when the runner's claim ends in `usage_limit` or `auth_failed`, or its lease expires, so
docket does not see that result then and the job reads `queued` again. Both are capped: once
city-hall has requeued a job after `usage_limit` or `auth_failed` its configured maximum number of
times (ten by default, `CITY_HALL_MAX_REQUEUES`), the next claim that ends that way fails the job
instead, as does the expiry that brings its expired leases to their configured maximum (three by
default, `CITY_HALL_MAX_EXPIRED_LEASES`). The tracker reads how the last claim ended -- city-hall's
`job.lastOutcome`, or the last entry of `runs` where the field is absent -- and treats a queued job
whose last claim ended in any of those ways (`usage_limit`, `auth_failed` or an expired lease) as
"unavailable", not "pending": the run is held and asked again, never given up after six hours while
the runner is paused, and nothing new is submitted meanwhile. docket counts its
six hours from the submission, so once a Job has been seen paused (`executor_jobs.paused_at`) every
unfinished answer for it -- queued or running -- stays "unavailable": a runner that resumes after
six hours is collected, not given up and run a second time. That hold is capped at 48 hours from
the first sight (a judgement, not a measured figure): past it the Job answers "pending" again, so
docket gives the run up, and the admins are told once. It logs "the model runner is paused" naming
the outcome once an hour per Job, and tells the admins once per Job and outcome. docket's own
usage-limit pause (which waits for the reset the CLI named) applies only to a `usage_limit` result
that reaches docket, and that happens only when the job ends failed with that result still stored.
Mainly, that is the requeue cap (`CITY_HALL_MAX_REQUEUES`): the job fails with the `usage_limit`
(or `auth_failed`) result of the claim that went past it, and the tracker answers docket with that
result, if docket is still asking (within the 48-hour hold above). The other way is the lease cap
(`CITY_HALL_MAX_EXPIRED_LEASES`), when a job requeued after `usage_limit` or `auth_failed` later
fails at its maximum of expired leases with that earlier claim's result still stored.
The plugin never calls a model, holds no Claude credential and no `ANTHROPIC_*` variable; model
output is data, cleaned by docket before it reaches a DM or a finding, and every research DM goes
out with no allowed mentions: the host sends every `dm` with `allowedMentions: { parse: [] }`
(CONTEXT.md). **The wire is city-hall#18's**
([Lepid-Labs/city-hall#18](https://github.com/Lepid-Labs/city-hall/pull/18), merged as 90a06ec),
but its decision record 0002 is still "proposed" pending Nazu's review
([Lepid-Labs/city-hall#17](https://github.com/Lepid-Labs/city-hall/issues/17)): the source pair is
a stand-in for the source and responder contracts, so it may change, and this adapter with it --
the requeue reading above and `lastOutcome` (present in the merged 90a06ec) included.

**Research while the lane is off.** If an instance that had city-hall configured loses that
configuration, its research requests stay queued: nothing runs them until research is available
again, a request whose deadline passes meanwhile makes no call and tells its owner when it next
runs, and those waiting requests still count toward the 5 a person may have waiting. `/research`
says research is not available; it does not list the waiting ones (`/tasks` does).

**Budgets** (plan 5.7, docket's defaults): 2 USD and 20 model calls a person a day, 10 USD and 100
calls in all. At a ceiling the person's research waits until midnight Eastern; the person gets one
DM and the admins one each. Reminders, renewals and prices never count. An admin can raise one
person's ceiling from their admin page (0.13.0, below); the global ceiling still applies to everyone
together. **For the alpha the ceilings can be switched off** (0.14.0; roshne, 2026-10-02, choosing option
A: "A.  but lets build in an unlimited budget "flag" during alpha, evaluate usage during alpha, then
test budgets during beta"): with `TRACKER_BUDGET_UNLIMITED` on (Configuration, below) no daily ceiling holds a run,
while each Job's own caps (15 turns and 1 USD for a research run) still bound it and every run is
still charged, so `/admin/usage` (below) shows what the defaults would have held.

**The interest scout** (#83). A scout is one model Job per run on the execute lane, under the same
switch, budgets and runner as research, with no reviewer run (plan item 62 keeps one for research
only). Its prompt, JSON schema and caps are the web-search spike's scout case (docket-runner
`spike/cases.json`; plan items 59 to 61): five to ten items, each with the page it was confirmed
on, why it fits, and a price if shown; a `shortfall` reason rather than padding; 30 turns, 1.50
USD and 10 minutes a run. Every item is cleaned and kept only with an http(s) URL. What it showed
is remembered in the task's state (the newest 300, by a digest of the URL without its fragment);
the next prompt names the latest 40, and an item already shown is dropped from the DM whatever the
model returns. Plan 5.2 and #83 word this as a check "against `findings`"; the state is the same
record kept beside the run, so the check needs no store read. Dedupe is by URL: the same thing at
another address is caught only by the prompt's list of titles. Those titles are model output fed
back to the model, cleaned and cut to 150 characters. Each item shown is also a finding, keyed by that digest. A run that fails with
`schema_miss`, a malformed answer, `timeout` or `error` is retried once at once, `auth_failed`
once an hour later; `turn_cap` and `budget_cap` are not retried. A run that fails for good sends one
line to the owner (and accepted recipients) and the scout goes on to its next run. A scout runs at its owner's preferred hour,
so `/settings hour` moves it with their reminders. With budgets on, mind the arithmetic: a run can
cost up to 1.50 USD of a person's 2 USD day, so two or three daily scouts, or a scout and a
research request, can reach the ceiling; a held run waits until midnight Eastern, and the next
scheduled one is made only once it has fired. The type lives in this plugin, not in
`@rackbops/docket-types` (0.5.0 has no scout); giving it back to docket is a follow-up.

**Findings.** A passed research answer's claims are stored with their first source (docket's
`findings`), shown on the task's page to its owner, accepted recipients and admins (docket's
`visibleFindings`), listed in `/task history`, and returned by the task API's `GET /tasks/<id>`.
Each source is a link with `rel="noopener noreferrer nofollow"`; every value is escaped. A recipient
sees a task without its `config` and `state` (docket 0.5.0): the request's context and draft are the
owner's.

**One task at a time.** A task's runs, the answers to them (buttons, `/task done`, Reply) and its
edits (the editor, pause, resume, delete, a zone or hour change) take that task's lock
(`src/locks.ts`), so none of them overlap. The notify and poll ticks run one pass per task that has
work; an answer that lands while its own task runs waits for that pass. The execute tick is the
exception: it can wait on city-hall, so an answer or edit about a task it holds does not wait but
answers "That task is with the model runner right now; try again in a minute." A zone or hour
change (`/register`, `/settings hour`, the web area's settings page) is the one edit that waits
instead, since it re-times every recurring task that follows the zone or hour and may skip none.
Of the tasks the execute tick holds, only a scout is one of those: a zone or hour change by its
owner waits for the rest of that tick's pass, each city-hall call or page read in it bounded at 15
seconds, and every command, button and web write queued behind it waits too.

## Web area

Served under `/tracker/` on the bot's own HTTP (it needs `HTTP_PORT`) and reached from outside
only through the instance's tunnel, at `TRACKER_WEB_URL`. Server-rendered HTML with forms and no
script, styled with `@rackbops/styles`' rackbops-noir theme (bundled into `dist/plugin.js` and
served at a hashed path, cached for a year).

| Path | What |
|---|---|
| `/` | My tasks: the same list as `/tasks` (active tasks owned and received, next run in your zone; paused ones and why), each linking to its history, and links to make a new one. |
| `/tasks/<id>` | A task's history: the same as `/task history`, for the owner, an accepted recipient or an admin. Anyone else gets the same 404 as an unknown id. The owner also sees Edit (not for a research request), Pause or Resume, and Delete. |
| `/new/wantlist` | A new want-list watch (GET, POST), by `/want`'s rules (`judge` too, yes or no): a page, a BGG game, or eBay (an inbox watch: `target` is the words to search for, the name when empty). Its edit changes the name, top price, currency, exclude, confirm and unconfirmed words and hours; an emptied top price, currency, exclude, confirm or unconfirmed field clears it, and where it looks -- an inbox watch's key and words too -- stays as made. |
| `/new/reminder`, `/new/renewal`, `/new/price`, `/new/research`, `/new/scout`, `/new/news` | The editor's new-task forms (GET), and making one (POST). `/new/research`, `/new/scout` and `/new/news` are linked from My tasks only while the model runner is set up (a news watch's kinds go one per line, and an emptied "What counts", "What never counts" or "How to tell it apart" clears it); without it the page says the type is not available instead of showing a form. A scout's interests go in a text box, separated by commas or one per line; its edit form shows the list one per line, and an emptied "Who it is for" or "Notes" clears it. |
| `/tasks/<id>/edit` | The owner's edit form (GET) and saving it (POST). |
| `/tasks/<id>/pause`, `/resume`, `/delete` | POST only. Delete answers a confirmation first; only a second post carrying `confirm=yes` deletes. |
| `/resume-dms` | POST only: Resume DMs, the button on the banner every page shows a person whose DMs are paused (Pause after failed DMs, above). It resumes them as their next command would, and My tasks then says how many tasks are back on; pressed when they are not paused, it changes nothing. |
| `/settings` | Preferred hour and time zone, checked as `/register` checks them. Links to API tokens and Forget me. |
| `/tokens` | Your API tokens (below): each one's name, when it was made, last used and expires, with Revoke; and the form to make one (POST), which sends the new token to you by Discord DM -- never on the page. |
| `/tokens/<id>/revoke` | POST only: revokes one of your own tokens. Anyone else's answers the same 404 as an unknown id. |
| `/forget` | Forget me (below): what it deletes (GET); a POST asks for the confirmation; a POST with `confirm=yes` and the word `forget` erases. Linked from Settings. |
| `/admin` | Admins only: everyone on the list, the decline blocks in force (each with Lift), and a form to allow a person by Discord id. |
| `/admin/tasks` | Admins only: every task in the store, with its owner, status and how many receive it, each linking to its page. |
| `/admin/deliveries` | Admins only: the DMs that did not arrive (below), newest first. |
| `/admin/usage` | Admins only: model usage per budget day (below). |
| `/admin/people/<id>` | Admins only: one person -- Discord id, registration, zone and hour, delivery, task counts, their tasks -- with Make admin or Revoke admin, Resume delivery (when paused), and Remove from the tracker; their daily ceiling, with the form to change it; and their API tokens, each with Revoke. |
| `/admin/usr-link` | Admins only, POST only, with the usr link on: Link everyone to usr (below). |
| `/admin/usr-refresh` | Admins only, POST only, with the usr link on: Refresh usr links (below). |
| `/admin/allow`, `/admin/people/<id>/grant`, `/revoke`, `/resume-delivery`, `/ceiling`, `/forget`, `/admin/blocks/<id>/lift`, `/admin/tokens/<id>/revoke` | Admins only, POST only: the acts below. |
| `/api/v1/...` | The JSON task API (below): bearer tokens only, never the cookie. |
| `/signin` | Where a request that is not signed in is sent (a POST, or any request with the usr link off): says to run `/web`, and with the usr link on offers Sign in with usr. |
| `/login?t=...` | The link `/web` gives. |

**Signing in** (plan item 41; the one-time link is the method for now, kept in
`src/web/signin-link.ts` so another, such as Discord OAuth2, can sit beside it and feed the same
sessions). `/web` answers, ephemerally, `<TRACKER_WEB_URL>/tracker/login?t=<token>`. Opening it
does not use it up -- a link preview or a prefetcher would otherwise burn it -- it shows a Sign in
button; pressing it uses the token (once, within 10 minutes), starts a session and redirects to
`/tracker/` so the token leaves the address bar. The login pages send `Referrer-Policy:
same-origin` and `Cache-Control: no-store` (every page does). Not `no-referrer`: under it a browser
sends a form post's `Origin` as `null`, which the Origin check refuses, so no form would work; the
pages link nowhere else, so the token never leaves in a Referer either way.

**Signing in through usr** (0.22.0, while the usr link is on: `TRACKER_USR_URL`). A GET with no
session reads usr's `nz_id` cookie, which usr sets on the parent domain named by its
`USR_SSO_COOKIE_DOMAIN`. That domain must cover `TRACKER_WEB_URL`'s host: otherwise usr refuses the
return address and keeps the browser on its own site. The token is checked offline, as usr's
`docs/sso-verifier.md` says: an ES256 signature against usr's `/.well-known/jwks.json` (cached five
minutes, fetched again on an unknown key at most every 30 seconds), `iss` "usr", not expired, and
never a delegation token. A valid token whose account holds `tracker:member` and is linked to a
registered person (`users.usr_subject`) opens a session as the one-time link does, once server
membership is checked (as `/web` checks it), and the browser goes on to the page and query it asked
for, marked `?usr=in`: arriving there without the session (a browser that refuses the cookie) says
so instead of signing in again. A signed-in GET still carrying a `?usr=` mark goes on to the same
address without it. With no valid token the browser is sent to usr's `/api/auth/sso/refresh` once, returning to
the same address marked `?usr=1`; coming back still without one (usr's keys could not be fetched,
the clocks disagree) says the sign-in could not be confirmed, instead of going round again. A token
without the member role goes the same way once, since it can predate an `/allow` (an `nz_id` lives
30 minutes by default); still without it, or for an account linked to no one registered here, the
page shows what to ask an admin for. While signed in, a usr cookie for the person's own account that
no longer carries `tracker:member` signs them out of every session and revokes their API tokens, but
only on a GET back from usr's refresh: any other request with it, a POST included, is first sent
there (a POST's form is not kept: the browser comes back to that page, or to My tasks). That happens
only in the web area: the task API never reads usr, so a token keeps working until the person next
uses the web area while still signed in to it; opened signed out, it only shows the not-member page
and the tokens stay (revoking their tokens or admission in the tracker ends them at once). Sign out
ends the tracker's session only, not usr's: for 12 hours after it, a GET does not sign back in from
usr's cookie unless it carries `?usr=go` (the sign-in page's "Sign in with usr" button, whose trip to
usr ends those 12 hours); a `/web` link signs in as always. Any site under usr's cookie domain can set an
`nz_id` of its own, so every host under that domain must be trusted. The one-time `/web` link stays
beside it. `src/usr-identity.ts` uses WebCrypto only.

**Sessions and forms.** The session cookie is `__Secure-tracker-session`, `HttpOnly; Secure;
SameSite=Lax; Path=/tracker/`, for 7 days from sign-in; a browser never sends it to the bare
`/tracker`, which redirects to `/tracker/` first. A person holds at most 20 sessions: a 21st ends
their oldest. The store keeps only SHA-256 hashes of
link tokens and session ids. Every request re-reads the person: one no longer in the tracker's
store, or no longer registered, is signed out of every session. Every state change is a POST
carrying the session's CSRF token (compared in constant time), and a POST with an `Origin` other
than `TRACKER_WEB_URL`'s is refused. The sign-in post has no session yet, so it carries a
double-submit token from a `SameSite=Strict` cookie the link's page sets: another site cannot sign
you in as someone else. Sign out is a POST too.

**The task editor** (slice 2). The forms take the options of `/remind`, `/renewal`, `/price` and
`/research` (#82), and the same functions check and make them: the same defaults, limits and messages, the page read
once before a price tracker is made, at most 20 price trackers per person wherever they were made,
and `near` turned into the same bounded pattern; a person has one first page read (a new price
tracker's or `page` watch's) in flight at a time. Every person may have at most 200 active or paused tasks of all types together,
made anywhere. The length limits are one set (`src/limits.ts`) for the slash options, the forms
and the server's checks. An edit changes a reminder's text, time and repeat
(an empty time keeps the one it has, unless the repeat changes); a renewal's name, amount,
currency, date, unit, every, lead and note (a new amount is the one the next ask quotes; a new date
gets `/renewal`'s first-ask rule, but a date a run already asked about is not asked again); a price's name, interval,
drop and baseline, never its page. A schedule change cancels and replaces what is queued and keeps
snoozes, as a zone move does, and each change is in the task's history. An empty field keeps what
the task has (an empty note clears it; an empty price name is the page's address). A renewal date
that is one of the schedule's own period dates keeps the schedule and its anchor as they are, so the
31st stays the 31st; only a different date re-anchors. A finished task cannot be
edited. Pause holds everything the task would send until Resume, and a person's delivery resuming
does not undo it; a run missed while paused fires once, late, on resume, and a zone or hour change
re-times the run a paused task holds -- same period date or local day, new zone or hour, still one
run -- so it is neither lost nor sent at the old time. Resume on a task paused
for failed DMs is `/task resume`. Delete archives the task: it leaves every list, its queued runs
are dropped and nothing more is sent, but its history is kept (an admin can see every task) and
its page stays for the owner. Every editor post passes the session, CSRF and `Origin` checks; the
task is loaded by the id in the path and must be the viewer's own, checked again in the write
queue, and anyone else's -- even one an admin can see -- answers the same 404 as an unknown id. A
refused form comes back with what was typed and why. A research request made on the web is
`/research`'s exactly -- the question, the optional context, deadline and start in `/research`'s
words, where its pages come from (the web, or your browser), the cap of 5 waiting, the daily budget -- and, as in Discord, it is never edited: its page
has Pause, Resume and Delete but no Edit. Making one only queues its run; nothing reaches city-hall
until the execute tick. Form bodies are capped at 32 KiB, read no
further than that.

**Headers.** `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'none';
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`. Every value on a page is HTML-escaped. An unknown path is 404; a method
other than GET or POST (or the wrong one of the two for a path) is 405.

**Membership on the web.** With `TRACKER_GUILD_ID` set, `/web` issues a link only to a member,
and the session remembers when that was confirmed. A web request more than 15 minutes after the
last confirmation re-checks membership (one lookup per listed server, all at once, the first yes enough; about 3
seconds at most, outside the write queue), through the host's own member lookup (`HostApi.member`,
rackbops-discord-bot#623), or on an older host through the discord.js Client of an interaction the
plugin has handled since it started (held in memory, never stored). Not a member of any listed server: every session of theirs ends, on a page that says why. A member: the time is
refreshed. A failed or slow lookup, or (on an older host) no interaction yet since a restart: they stay signed in
while the last confirmation is under 24 hours old, and are then signed out and told to run `/web`
again. Concurrent requests share one lookup per person, and after a failed one that person is not
looked up again for a minute, so an outage or rate limit does not pile up calls. A confirmation
time in the future (a clock set back) counts as stale. Every lookup asks Discord (`force: true`),
never discord.js's member cache, which with only the Guilds intent never learns that someone left.

**The admin view** (slice 3, plan 5.8, 5.10). An admin is a person whose row in the tracker's store
has the admin flag -- the one admin definition; `/allow` checks the same flag. `TRACKER_ADMIN_DISCORD_IDS`
grants it at start; admins grant and revoke it here. The flag is read from the store on every
request, and again inside the write queue before any admin act, so an admin whose flag is revoked is
refused on their very next request. To a signed-in person who is not an admin, every `/admin` path --
any method -- answers the same 404, byte for byte, as an unknown page; a visitor who is not signed in
is sent to sign in, as on every other signed-in path. An admin sees every person, every task
and every task's page and history, read-only: an admin never edits, pauses or deletes another
person's task (the owner's acts answer them 404, as in slice 2). What an admin can do, each through
the function the command path runs:

- **Allow** a person by Discord id: `/allow`'s own `allowPerson`, with the same server-membership
  check when `TRACKER_GUILD_ID` is set (one bounded lookup; on an older host, no Discord client yet
  since a restart refuses, as an unknown answer does). A form cannot tell a bot's id from a person's; a bot's row can
  never `/register`.
- **Make admin / Revoke admin** (plan 5.8). The last admin can be neither revoked nor removed. An
  admin who revokes themselves lands on My tasks. Each change is logged (`u1 made u2 an admin`).
  An admin named in `TRACKER_ADMIN_DISCORD_IDS` is made an admin again at every start, so their page
  offers another admin neither Revoke nor Remove, and both are refused: take them out of the
  configuration first. Such an admin may still forget themselves (if another admin is left): their
  own page offers Remove but not Revoke, and the pages say that the next start makes them again, as
  a new person, unless the configuration no longer names them.
- **Resume delivery** of a person paused after failed DMs: `DeliveryHealth.resume`, what the
  person's own next command does -- the count clears and the tasks nothing else holds go back on.
- **Lift** a decline block in force: docket's `liftBlock`, recorded as that admin's lift.
- **Revoke an API token** of anyone's, from their page, which lists their tokens (never the
  secret). It stops working at once; the owner is not told. Logged by token id.
- **Raise a person's daily ceiling** (0.13.0, plan 5.7: "The admin raises a person's ceiling from
  the web area"). Their page shows what they spent today (the budget day ends at midnight Eastern),
  their ceiling now, a form with both numbers -- dollars to the cent and whole model calls -- and
  the latest 20 changes an admin made, newest first (older ones stay in the table). Each number
  must be at least the default (2 USD, 20 calls) and at most the global ceiling (10 USD, 100
  calls), which docket checks first anyway; those bounds are proposed on #82, roshne's to confirm.
  Setting exactly the default is a reset to it, not a raise.
  **A raise stands until an admin changes it** -- raises it again or presses **Back to the
  default**. That default is proposed on #82 and is roshne's to confirm; a today-only raise
  would be a small change (`limitsOf` and `isRaised` plus a clock in `Ceilings`, and the page's
  badge). Enforcement stays docket's: the
  execute lane hands docket's `budgetHold` a policy whose `personFor` reads the person's newest
  change, before every run, so a raise lets a held request run on the next tick. docket
  sends its ceiling notices once a day per person (`noticeOnce`, key `budget:person:<id>:<day>`),
  so every change -- raise or reset -- deletes that person's key for the current budget day in the
  same transaction: meeting the new ceiling the same day DMs the person and the admins again (plan
  5.7: "nothing fails silently"). Every change is an append-only `ceiling_changes` row (who, for whom, the values,
  when) and a log line (`u1 set u2's daily ceiling to 4 USD / 40 calls (c1)`).
- **Remove from the tracker**: forget-me for that person (below), with the same confirmation.

**Usage** (0.14.0). `/admin/usage`, linked from every admin page, shows the model spend per budget
day (midnight Eastern) for the last 14 days, newest first: dollars and calls for everyone together,
then per person. Each row is measured against the default ceilings, not a person's raise -- a
"would have hit the 20 call limit" (or "2.00 USD") marker on a day that reached one, and how many
calls were charged after it had, roughly what that ceiling would have held (docket checks before a
run and charges at its end). It reads docket's `usage` table, which every run is charged to whether
budgets are on or off -- the way to evaluate the alpha with `TRACKER_BUDGET_UNLIMITED` on
(Configuration, below). Read-only, and like every admin page answers anyone who is not an admin
with the unknown page's 404.

**Deliveries** (0.10.0). `/admin/deliveries`, linked from every admin page, lists the DMs that
settled `failed`, `unconfirmed` or `deferred` in the last 30 days, newest first, at most 200 rows
(the page says how many matched when the bound cuts it). Each row: the task (its title, linking to
its page, its id and owner), the run's due time, the recipient (linking to their admin page), the
status, attempts and deferrals, the error text, and when it settled. `unconfirmed` means the DM may
have gone out and is never resent; `deferred` is still owed (a recipient whose delivery is paused,
say). Before 0.10.0 these showed only in the bot log, where the warnings still go. The page is
read-only, and like every admin page answers anyone who is not an admin with the unknown page's 404.

Not here yet, though plan 5.10 lists them: grants and retry, and an admin pause of someone else's
task. Of budgets, raising one person's ceiling and the usage page are here; the global ceiling and
the defaults are docket's constants, and turning budgets off is the operator's
`TRACKER_BUDGET_UNLIMITED`, not a web control. While it is on, the ceiling section says the ceiling
is not enforced; a change is still recorded and applies once it is off.

**Forget me** (plan 5.8). A signed-in person erases themselves from `/forget` (web only: the plan
asks for no Discord command, so without `TRACKER_WEB_URL` the only path is an admin with the web
area). Two posts: the first asks, the second must carry `confirm=yes` and the word `forget`. Then,
in one SQLite transaction in the write queue, **deleted, not archived**:

- every task they own, archived ones too, with everything under it: runs, run events, replies
  (anyone's), history, series, recipients, deliveries (anyone's), charges and pauses;
- on everyone else's tasks: their recipient rows, their replies and answers, the history rows they
  made or that name them (an invitation of them, a pause for them), the run events and deliveries
  of DMs to them (docket's `deleteDeliveries`), charges made for them, and their pause rows;
- the budget notices kept for them (`budget:person:<id>:...`) and the changes to their ceiling;
- every decline block they are either side of;
- their admission, delivery health, web sessions, unused sign-in links and API tokens, their DM
  conversations with the intake (transcripts and all), and their person row.

What stays, and why: another person's task that they received stays that owner's; one paused only
because DMs to them failed goes back on (one that cannot finish, on a store error, is named in an
admin's answer and logged with its status then -- still paused, or active with its next run maybe
missing -- and the rest of the erasure stands). Another person's row keeps its own audit fact but not their
id -- `admitted_by` of someone they admitted, `lifted_by` of a block they lifted, and `set_by` of a
change they made to someone's ceiling become
`forgotten` ("an admin since forgotten"; null already means "the configuration"). Text is matched
only in the forms the code writes a person's id into -- docket's consent rows (`u5`, `u5 24h`), the
tracker's `u5: ...` removals and `delivery to {u5} paused` pauses, docket's `u5 <message>` delivery
events, and the notifier's error phrases (`recipient u5 cannot be messaged`, ...; both written only
before 0.9.0, when a run's own row recorded its DMs) -- never as any
id-like word, so an address with `/u5/` in someone else's text is left alone. A history row or a
delivery event of theirs is deleted; the error of someone else's run keeps its row and has the id
replaced with `(forgotten)`. A pause for a recipient now names them by id and shows their current
name when read; a pause row written before 0.6.0 names the recipient's display name of the time,
and is deleted when it is on a task they were a recipient of, names their current name, and no
other recipient of that task has that name. A row written under an older name of theirs, or shared
with a same-named recipient, is kept: the one known gap. A reply other people wrote on the erased
person's own tasks is deleted with those tasks. Outside the store, nothing is touched: the DMs the
bot sent stay in the person's Discord DMs, and the host's log may hold their tracker id. With the
usr link on, their usr account -- which holds their Discord id and `tracker:member` -- is usr's:
forget-me never calls usr, so it stays until it is removed there. **city-hall
keeps its own copy of a research Job** -- the spec (the question and context are in its prompt) and
the result -- under city-hall's retention, not the tracker's (Nazu, plan 5.8): forget-me deletes the
tracker's `executor_jobs` rows for the erased runs (no tombstone is kept; the keys name only the
database and a run id), but cannot reach city-hall's job. The same holds for each turn of a DM
conversation with the intake (below): city-hall keeps that turn's Job, whose prompt carries the
conversation so far.

Bytes: the database runs with `secure_delete` on, so a deleted row is overwritten, and the first
start of 0.6.0 on an existing database runs one `VACUUM`, so pages freed before that are rewritten
too. That one-time VACUUM is recorded in a small `tracker_meta` table, not by a schema bump (0.6.0
kept the schema at 3; 0.7.0's API tokens are schema 4, see the CHANGELOG). If the VACUUM cannot run (a
reader holds the file), the start goes on, a warning is logged, and the next start tries again.
Not a VACUUM per erasure: it rewrites the whole file under an
exclusive lock, and `secure_delete` already covers every later delete. After an erasure the
write-ahead log is checkpointed without waiting; when a reader keeps it busy, that is logged and
SQLite's next checkpoint copies it back.

Timing: forget-me first waits, outside the write queue, until no notify or poll tick is running (at
most 6 seconds, under the bot's 10-second bound on a web request, so the answer reaches the browser;
then it answers 503, try again, and deletes nothing; the queue turn after the wait has no bound of
its own, but nothing slow runs in the queue), so a reminder DM to them
already in flight cannot be recorded after they are gone -- and no one else's command waits behind
it. Inside the queue it only checks that no tick started meanwhile (else the same 503). A DM sent
outside any tick -- an invitation's -- that fails after they are gone writes nothing: the failure
count is not kept for a person no longer in the store, and the withdrawn invitation is not
recorded. A `/price` whose page is read while its person is forgotten makes nothing. No execute
tick starts from forget-me's wait to its erasure, so a model run every minute cannot keep it busy;
one already running is waited for like the others. Their sessions
are among the rows, so they are signed out everywhere at once, and the browser's cookie is cleared. They can come back only as someone new: an admin
`/allow`s them again, and the tracker never reuses an id.

**Choose the web origin's domain with care.** A host under the same parent domain as
`TRACKER_WEB_URL` that you do not control can set a `__Secure-` cookie on the parent domain
(cookie tossing), and so plant its own session or sign-in cookie in your browser: a login-CSRF.
The `__Host-` prefix, which would stop that, requires `Path=/` and so cannot be used with
`Path=/tracker/`. Put the bot on a host whose sibling subdomains are all yours.

## Alert emails

eBay's saved-search alerts reach eBay watches by mail (0.25.0), while `TRACKER_MAIL_DOMAIN` and
`TRACKER_MAIL_KEY` are set. The tracker still never opens eBay: it reads only the alert eBay mailed.

- **Each person has one alert address**, `m-` and 24 random hex digits at the domain, made the first
  time it is shown: in `/want source: ebay`'s answer and on the web area's settings page. It is
  theirs alone (whoever knows it can send listings to their eBay watches), and forget-me deletes it.
- **The route.** Cloudflare Email Routing receives the domain's mail and hands every message to the
  Email Worker in `mail-worker/worker.js` (a catch-all rule, "Send to a Worker"). The Worker posts it,
  as it came, to `POST /tracker/mail/inbound` with `Authorization: Bearer <TRACKER_MAIL_KEY>`,
  `X-Envelope-To: <the address>` and, while the web area is behind Cloudflare Access, a service
  token's `CF-Access-Client-Id` / `-Secret`; the Access application covering `/tracker/*` then
  needs a Service Auth policy that includes that token, or Access answers with a redirect and every
  message bounces as `status 302`. Up to 1 MiB; bigger is `413` and refused. An address that is no
  one's is `404`. The Worker refuses back to the sender, with a permanent error, anything the
  tracker does not answer `200` (a `503` while it starts too), so a mistyped forwarding address, or
  an outage, bounces to the mailbox that forwarded it; that day's alert is not retried. The Worker
  is deployed by pasting `mail-worker/worker.js` into the Cloudflare dashboard's Worker editor; it is
  not in the plugin's npm bundle.
- **What a message does.** Gmail's forwarding confirmation: its code is DMed, to enter in Gmail's
  Forwarding and POP/IMAP settings. Since 0.26.0 it is any sender at Google naming forwarding. Since
  0.27.0 the code is a run of digits standing alone in the subject or shortly after the word
  "code" in the body, and Gmail's verify link (a `/mail/vf-` address on `mail.google.com`,
  `mail-settings.google.com` or a subdomain of either, never its cancel link) is DMed too; digits inside
  an address are never the code. An eBay alert: the
  matches above "You might also like" (never eBay's suggestions) -- title, the item's bare
  `/itm/<number>` address, the price's lower end -- go into the inbox of each of the person's live
  eBay watches whose words are the saved search's (case and spacing aside), exactly as listings sent
  through the task API; the watch's next look DMs the new ones. Words match with case, spacing and
  the marks `` ` * _ ~ | < > @ # [ ] ( ) \ : / `` ignored. An alert no watch searches for gets a
  DM saying so, with the `/want` that would watch it, each time eBay sends it. Anything else is
  dropped. A message is never stored, only the listings read from it, and its words are never
  logged: one that does nothing is logged only with why (the owner is not registered, or its
  sender's domain -- a Google no-reply sender whole -- which bodies it had, and whether its
  subject names forwarding; for Google's no-reply senders also its subject's shape, letters `a`,
  digits `9` and each address `<addr>`, and counts from its body as read, plain text else the
  HTML's text).
- **Only eBay's own domains** (ebay.com, .co.uk, .de, .ca, .com.au and the rest of eBay's sites;
  never a lookalike such as `ebay.com.de`) count as eBay, for the sender and for every item link.
  The sender is its `From` address, not a checked signature: the private address is the guard, and
  anyone who learns it can send listings to its owner's eBay watches. A price's own sign gives its
  currency (`$` on ebay.com, `C $`, `AU $`, `£`, `€`); otherwise none is set. The HTML read is
  capped at 512 KiB, in bounded steps.
- **Setting it up in Gmail.** Settings, Forwarding and POP/IMAP, Add a forwarding address: the alert
  address. Gmail mails a confirmation code there, and the bot DMs it; enter it. Then add a filter --
  from `ebay@ebay.com`, has the words `"Turn off alerts for"` -- that forwards to the alert address.
  Never turn on "Forward a copy of incoming mail" for everything.
- **The format** was read from the first real alert (2026-10-13, one match), kept with its
  tracking parameters and account names taken out as `src/fixtures/ebay-saved-search-alert.eml`.
  An alert with several matches is read the same way, which is inferred until one arrives.

## Talking to Clerk (the plain-language intake)

0.34.0, plan E10. With `TRACKER_INTAKE` on, a person DMs Clerk what they want in their own words
("remind me to call Anne on Friday", "watch eBay for Wingspan Oceania under 40 dollars"). Clerk asks
one short question at a time and then shows a draft: the task's type and each field, with **Save**,
**Change** and **Cancel**. Only Save makes the task, through the same create as the task API's
`POST /tasks` and the web editor, as the person who pressed it and under the same rules (not the API's per-token rate limit);
its history then reads `created: in conversation`. The card shows every value whole (line
breaks as spaces), so the person confirms what Save stores; a draft too long to show whole is not offered, and
the person is asked to shorten it. Change takes the draft away and asks what should change; Cancel
ends the conversation with nothing saved. Only one press acts on a card, and none while a turn or a
Save of the person's is out. A refused Save says why, and the
conversation goes on. The model never writes anything (the tier rule: the agent proposes, the owner
confirms, plain code acts).

A person can change one of their own tasks the same way ("move my Anne reminder to 10am"). Each
turn shows the model the id, type and title of their newest 30 active or paused tasks of a type
the intake can make (so not a research request, nor a judged watch, which the web editor can still
change); the card names the task by id and title and lists the fields that change, and Save makes
the change through the task API's `PATCH /tasks/<id>`, as that person. The history rows that Save
writes then read `edited: in conversation` (a renamed text, a changed price) or `schedule changed:
in conversation` (a new time). A change to a task that is not theirs, or that finished or went
away meanwhile, is never saved.

- **Who.** `off` (the default: DMs are not read at all), `admins` (Rod's "I'll test it first",
  2026-10-19: anyone else registered is told it is not open yet), or `everyone` registered. While
  it is on, every DM to the bot is answered: one from someone not admitted or not registered gets
  the same answer a command would. The same gates as a command first: membership of `TRACKER_GUILD_ID` with its role, then being on
  the list and registered. Membership is checked through the Discord client of the last interaction
  the plugin handled, so right after a start, with a gate set, a DM is answered "could not check"
  until someone has used a command or button.
- **Each turn** is one `claude -p` Job with web search only (no page is opened; since 0.35.0, so it
  can look up a public fact such as when a game kicks off instead of sending the person off to look),
  at most 8 model turns, 0.25 USD and 120 s (docket-types' `intakeJob`), through city-hall to the
  runner on the subscription, never an API key. The tracker keeps the conversation and sends it whole each turn, so no turn keeps a session
  on the runner (Rod, 2026-10-19, "Clerk keeps it"). A turn is submitted when the DM arrives and
  asked about every 2 s, beside the execute lane rather than through it, for at most 5 minutes;
  past that the person is told to send it again. It names `TRACKER_INTAKE_CAPABILITY` when set,
  so a runner of its own can take turns and none waits behind research; else the execute lane's tag.
- **Limits.** One turn at a time per person (a DM while one is out is turned away). A draft that
  does not fit the type's fields goes back to the model once, unseen. Each model call is one call
  against the person's daily budget (unless `TRACKER_BUDGET_UNLIMITED`), charged as any Job is; a
  turn given up after 5 minutes is charged one call when a runner had started its Job (which still
  runs), and nothing when it was still queued. When city-hall puts a turn's Job back in its queue
  after a usage limit or a refused credential, the person is told at once that the assistant is
  busy, nothing is charged and nothing is kept. Only that turn is told so: the runner then stops
  claiming until its usage window resets or its credential works again, and city-hall cannot show that, so a later turn waits the
  5 minutes and is told it took too long, uncharged. A Job put back after a lost lease (a runner
  restarting) is waited for as usual. city-hall has no cancel, so a Job given up on still runs once
  a runner takes it, and its answer is dropped. Without `TRACKER_INTAKE_CAPABILITY`, turns queue
  behind research Jobs on the one runner. The intake sends the admins no notices (each turn is a new
  Job, so they would come once per DM); its executor logs a paused runner. The admins hear of a
  pause only through the execute lane's own Jobs, so not of a pause on an intake runner of its own. A conversation closes after 20 model calls (a retry counts) or a day
  idle; the next DM starts a new one.
- **Privacy.** The transcript lives in the tracker's store (`intake_conversations`, schema 12),
  deleted seven days after the conversation ends and at once by forget-me. city-hall keeps each
  turn's Job, which carries the conversation so far, under its own retention (Forget me, above).
  Since 0.35.0 a turn may run web searches, through the CLI's own search, for a public fact; the
  prompt tells it to search at most twice and to keep the person's own details out of them (rules
  the model follows, not limits in code).
  The bot host needs the DM seam (rackbops-discord-bot#620); the plugin declares the
  `DirectMessages` intent (4096), which is not privileged.

## Task API

A JSON API over your own tasks, for a program that acts as you -- a script, or the plain-language
intake agent the plan defers (E10, item 31), which would end its dialogue by posting a task here.
It is served under `/tracker/api/v1/` on the same origin as the web area, and only when
`TRACKER_WEB_URL` is set. Every write goes through the same functions as the web editor and the
slash commands -- the same fields, defaults, limits, caps and messages -- in the same write queue.

The Claude in Chrome route (#125) is one such program: this repo's `clerk-browser-search` skill
(`.claude/skills/clerk-browser-search/SKILL.md`) searches eBay and BoardGameGeek in the owner's own
Chrome, looking only, and sends listings to inbox watches and pages to research requests through
`scripts/clerk-browser.ts`, which reads the Access service token and the tracker token from files.

**Tokens.** Make one on the web area's `/tokens` page (linked from Settings): a name, and an expiry
of 30, 90 (the default) or 365 days -- every token expires. The token -- `trk_` and 43 characters --
is sent to you once, by Discord DM from the bot; it never appears in any web page or response, and
the tracker keeps only its SHA-256. If that DM cannot be delivered (DMs closed), the token is
deleted at once and the page says so: open your DMs and try again. At most 10 live tokens per
person, and at most 10 made per person in any rolling hour, revoked ones counted (each is a DM, so
a script riding your session cannot flood your DMs by making and revoking); the count is kept in
memory only, so a restart clears it. Each lists when it was made, last used (recorded at most once a minute) and expires, and
can be revoked there at once; an admin sees and revokes anyone's from the admin view's page for
that person. Forget-me erases a person's tokens with the rest. The log names a token by its id
(`k1`), never by its secret.

**Authentication.** `Authorization: Bearer <token>` on every request. The web area's session
cookie is never read here: every plugin shares one browser origin, so a cookie-authenticated JSON
API could be called by any script on it. A token acts as its owner with the owner's rights only,
and only on the owner's own tasks -- an admin's token included; an admin's wider reads stay on the
signed-in web pages. Every request re-reads the owner, as the web does a session: a person no
longer on the tracker, or no longer registered, is refused and their tokens deleted; with `TRACKER_GUILD_ID` set, membership
is re-checked on the web's schedule (after 15 minutes, one check, shared with the web), and one who
has left every listed server loses every token and every session; a lookup that keeps failing
lets them on for 24 hours from the last confirmation, then answers 503 until one succeeds (the token is kept).
A token is looked up by the SHA-256 of what was sent, so the comparison is over a hash the sender
cannot steer.

**usr delegation tokens** (0.37.0, #370). With `TRACKER_API_DELEGATES` set, the task API also takes a
usr delegation token (usr `docs/design/tokens.md`) from the services it names -- tracker-mcp, the
ChatGPT connector of #368 -- acting for one person. It is checked offline against usr's JWKS, as the
web sign-in checks `nz_id`: header `typ` `dlg+jwt`, ES256, `iss` `usr`, `aud` this tracker's usr app
(`TRACKER_USR_APP`), unexpired with no more than usr's 30-minute cap left (plus a minute for usr's
clock running ahead), a `jti`, and `act.sub` one of the listed keys. Its `sub` must be a usr account
linked to a registered person (`/allow`), and the Discord membership re-check applies, with one
difference: when it was last confirmed is kept in memory, so after a restart a person's first
delegated request needs a lookup that runs, with no 24-hour grace (`503 membership_unknown` until
one does).

The token carries no roles, so the tracker cannot see `tracker:member` the way the web sign-in does,
and usr mints one for anyone holding any `tracker:` role. A listed service must therefore check the
member role itself: tracker-mcp asks usr's role lookup on every OAuth refresh. Nor can the tracker
see a revocation: a token minted before the person unlinked the service, or lost the role, works
until it expires (5 minutes by default, 30 at most). It does only what its `scope` names, one operation per route:
`whoami` (`GET /me`), `list_task_types`, `get_capabilities`, `list_tasks`, `create_task`, `validate_task`, `get_task`, `update_task`
(PATCH), `delete_task`, `pause_task`, `resume_task`, `run_task`, `send_listings`, `send_sources`,
`sources_ready`, each as `<app>:<operation>`; a missing one is `403 insufficient_scope`. `get_capabilities`,
`validate_task` and `run_task` are new in 0.37.0, so a service link made before it does not cover them until it is made again. usr's keys
out of reach is `503 usr_unavailable`, never a pass. Its rate limit is the person's, shared by every
service acting for them; each write is logged with the acting key and the token's `jti`.

**Browsers.** No answer carries a CORS header, and a request with an `Origin` header -- which a
browser adds to every cross-origin request and to any same-origin one that is not a GET -- is
refused with 403: the API is for programs, not pages. A browser page cannot send a cross-origin
`Authorization` header without a CORS preflight, which is refused. A script of another plugin on
the same origin (or an XSS there) can ride a signed-in person's cookie and use the web area as
them for as long as the session lasts -- that is the shared origin's cost, as for the cookies above
-- but it cannot get a token's secret: the page that makes one never shows it, the secret goes
only to the person's Discord DMs (a token made that way is one they are told about and can
revoke), and every token expires within a year. Put nothing on that origin you do not trust.

**Limits.** Each token may make 60 requests at once, refilled at one per second; over that, `429`
with `Retry-After`. A limited request is refused before its owner is looked up. Requests whose
token does not look up (unknown, revoked, expired, malformed) share one global bucket of 30,
refilled at one every two seconds; past it they get `429` instead of `401`, and valid tokens are
unaffected. A body is at most
16 KiB, read no further. One new price tracker's or `page` watch's first read in flight per person,
shared with the web editor (`409 busy`). That first read gives up 8 seconds after the request
arrived -- counted from before the token check, the membership re-check, the body and the create's
first turn in the queue, not from when the read starts -- and then makes nothing (`503 slow_page`
with `Retry-After`; the web form says the same words). The person stays busy until the read itself
ends (15 s at most), so a retry cannot start a second one. The about 2 seconds of the host's 10 s
left after a read in time are a margin for making the task in the queue, not a bound: a queue
slower than that can still make it after the host has answered `504`, so after a `504` on a create,
`GET /tasks` before trying again.

**Requests.** A `POST` or `PATCH` body is one JSON object with `Content-Type: application/json`
(else `415`), and names only the fields listed for that type (else `400 unknown_field`), each of
its JSON type: text as a string, a whole number or a number as a JSON number. A field left out of a
create gets the command's default; a field left out of an edit keeps what the task has, and an empty
string does the same, except that an empty `note` clears a renewal's note and an empty `name` gives
a price back the page's address -- exactly as the web editor's empty fields do. `null` is a value
only for a want-list watch's `max` in a `PATCH`, where it clears the top price; anywhere else it is
refused as the wrong JSON type (send `""` to clear a note).

Which types: `GET /tasks`, `GET /tasks/<id>`, pause, resume and `DELETE` work on any task you own,
whatever its type. `POST /tasks` takes `reminder`, `renewal` and `price`, by the web editor's rules,
`wantlist`, by `/want`'s rules, and, while the model runner is set up on this bot, `research`
(#82), by `/research`'s rules, and `scout` (#83), by `/scout new`'s; while it is not, a `research`
or `scout` create answers `503 unavailable`. `PATCH` takes `reminder`, `renewal`, `price`, a
want-list watch (`wantlist` or `wantjudge`) and `scout` (a scout made while the runner was set up stays editable):
a research request cannot be edited, here or in Discord, and a `PATCH` of one answers
`409 conflict`.

| Method and path | What |
|---|---|
| `GET /api/v1/me` | The token's owner (id, name, zone, preferred hour) and the token (id, name, made, expires). |
| `GET /api/v1/types` | Each type this bot makes now (research, scout and news only while the model runner is set up), whether a `PATCH` takes it (`editable`; false for research, whose `edit` is empty), and its create and edit fields: name, JSON type, required (never, for an edit), description, and limits (`maxLength`, `minimum`, `maximum`, `enum`). This describes the tracker's own editor fields -- what these endpoints take -- and is **not** docket-core's `TaskType.intake` (`IntakeSpec`), which describes a type's config. |
| `GET /api/v1/capabilities` | What this bot can make for you, in one read: `types` (as `GET /types`), `owner` (your zone and preferred hour), `limits` (`liveTasks`, `priceTrackers`, `researchWaiting`, `scouts`, `wantWatches`, `pageSize`, `requestsBurst`, `requestsPerSecond`, and `newsWatches` since 0.39.0) and `sources`, which say whether each is set up on this bot -- `runner` (research, scouts and news watches), `bgg`, `ebay` (eBay's own API), `shopify`, `mail` (alert email) and `webArea` (the web area, `TRACKER_WEB_URL`, which browser research needs) -- as true or false only, never a key, token or address. (0.37.0, #369.) |
| `GET /api/v1/tasks` | Your tasks that are not deleted -- active, paused and done -- oldest first. Not the ones shared with you. With `?limit=N` (1 to 200) one page of them, and `nextCursor` (null on the last page): send it back as `?limit=N&cursor=<nextCursor>` for the next. A task made or deleted between two pages moves no other across the cut, so each one still there is listed exactly once. Without `limit`, all of them, and no `nextCursor`. Any other query parameter is ignored; `limit` or `cursor` given twice is `400 invalid`. (0.37.0, #369.) |
| `POST /api/v1/tasks` | Makes one: `type` is `reminder`, `renewal`, `price`, `research`, `scout`, `news` or `wantlist`, and the rest are that type's create fields. A news watch's are `subject` (required), `include`, `exclude` and `disambiguate` (text; an empty string clears one in an edit), `shows` (`"yes"` or `"no"`) and `every` (a whole number of days); without the model runner it is a `503`, as a scout is. `201`, with `Location`. A price's page is read first, and nothing is made unless a price is found in it. A research request's fields are `question` (required), `context`, `deadline`, `at` and `sources` (`web`, the default, or `browser`: it waits for the pages your browser sends in, below), all text. A scout's are `interests` (required, text, separated by commas or new lines), `lens`, `for` and `notes` (text) and `every` (a whole number of days). A want-list watch's (`wantlist`) are `name` (required), `target` (required but for an inbox watch), `source` (`page`, `bgg` or `ebay`), `max` (a number), `currency` (text), `exclude` (text: words or phrases separated by commas; an empty string clears it in an edit, and `settings.exclude` reads them back joined by `, `), `confirm` and `unconfirmed` (text, the same way; a plain watch only, since 0.40.0), `hours` (a whole number) and `judge` (`"yes"` or `"no"`; `"yes"` without the model runner is a `503`); a judged one comes back as `type: "wantjudge"`, edited by the same fields but `judge`; a task's JSON shows its `source` and `target`, which no edit changes -- an inbox watch's `source` reads back as `inbox` and its `target` is its inbox key -- and for an inbox watch its `site` (`ebay` or `bgg`), its words to `search` for and a BGG `game` when one was named. |
| `POST /api/v1/tasks/validate` | A dry run of `POST /tasks`: the same body, checked, and nothing made or written. A reminder, a renewal, a scout or a news watch gets every check its create runs before it writes (the type's rules, the live-task cap, the scout or news-watch cap) and `{"valid": true, "checked": "full", "timeZone", "cadence", "firstAt", "thenAt", "message"}`: its first run and the run after, as UTC instants, placed in your zone as the scheduler places them (a renewal already within its lead is asked at once: its `firstAt` is then the ask's own date, already past, as the made task's `nextAt` will be). A price, a want-list watch or a research request gets its fields checked and the live-task cap (`"checked": "fields"`), and none of its type's own checks: its create reads a page or a source, or asks the model runner, so the rest is known only when it is made, and its create may refuse first for another reason (a bad address, the price-tracker cap). A refusal is the create's own (`400 invalid`, `unknown_field`, `409 limit_reached`, `503 unavailable`). Advice, not a reservation: a create made after it can still meet a cap. Takes no `If-Match`; an `Idempotency-Key` is ignored, as nothing is written. (0.37.0, #369.) |
| `GET /api/v1/tasks/<id>` | One of your tasks (a deleted one too), with its history: the newest runs and changes, as `/task history` shows them. Each run carries `delivery` (0.37.0, #369): `state` is `not_run` (not finished yet: queued or running, so no copy is planned), `nothing_to_send` (no copy: it fired with no message for anyone, was skipped, or failed before it had one), `sending` (a copy still owed: not tried, out now, or retrying), `delivered` (every copy went out), `unconfirmed` (a send failed in a way that does not say whether it went out; never resent) or `failed` (a copy failed for good); when copies differ, `failed` outranks `unconfirmed`, which outranks `sending`, then `delivered`. `reason` is the error of the failed or unconfirmed copy; `sends` lists each copy, `to`, `status` and `error`. |
| `PATCH /api/v1/tasks/<id>` | Edits it: the fields to change. A price's page is not editable. |
| `POST /api/v1/tasks/<id>/pause`, `/resume` | Body `{}`. As the web's Pause and Resume, and `/task resume`. |
| `POST /api/v1/tasks/<id>/run` | Body `{}`. One extra run now, off the schedule: `202`, and its lane's next tick takes it -- a reminder within a minute (`notify`), a price or want-list watch within a minute (`poll`), a scout, news watch or judged watch to the model runner on the `execute` tick, against your daily ceilings like any model run (one met holds it until midnight Eastern). The next scheduled run stays where it was. For an active reminder that repeats, a price, a want-list watch (judged or not), a scout or a news watch; anything else is `409 cannot_run_now`: a one-off (its own run stays queued, so it would run twice), a renewal (its ask is about its own date), a research request, a task with a run already due, or one waiting on a retry of its last look (or, for a news watch, on its review). A paused or finished task is `409 conflict`. Pausing the task drops a run now not yet taken; a pause for failed DMs keeps it, to run on resume. At most 10 runs now per person in any 24 hours, over all your tasks: `409 limit_reached` past that. An extra run of a price or want-list watch counts toward its "nothing found N times in a row" warning like any run. Takes no `If-Match`. (0.37.0, #369; docket 0.18.0's `runNowKey`.) |
| `POST /api/v1/tasks/<id>/listings` | Sends listings in to your inbox watch (an eBay watch made without the bot's eBay keys, or a BGG one made without BGG's API): `{"listings": [{"title", "url", "price", "currency", "condition", "seller"}, ...]}`, 1 to 40 of them, `title` and an absolute http(s) `url` on the watch's own site (one of eBay's own domains, `EBAY_DOMAINS` in `src/web/api-listings.ts`, or a subdomain, for an eBay watch; `boardgamegeek.com` or a subdomain for a BGG one) required, `price` a number or text such as `"$30.00"`, `currency` three letters. Each is cleaned by docket-types' `submittedListing` (an eBay item's address becomes its bare `/itm/<number>`, so one item stays one listing); the usable ones are kept, the others counted: `200 {"accepted", "rejected", "message"}`. None usable, or the wrong shape, is `400`; more than 40 is `400 too_many`; anyone else's, a deleted or finished watch, or not a watch, is `404`; a page, BGG-API, Shopify or eBay-API watch is `409` (its listings are read, not sent). The next look DMs the new ones within the watch's limits, each once. The newest 100 per watch are kept, as many as one look reads: more than 100 sent between two looks loses the oldest. Body up to 64 KiB. |
| `POST /api/v1/tasks/<id>/sources` | Sends pages in to your research request made with `sources: browser` (0.28.0, #125), or to one waiting for pages for a fuller pass (0.29.0, its JSON's `waitingForPages`): `{"pages": [{"url", "title", "text"}, ...]}`, 1 to 10 of them, an absolute http(s) `url` and the page's main `text` required. Each is cleaned by docket-types' `gatheredPages` (the text cut to 12,000 characters, the title to one line), and a second page with the same address in one request is left out; a page whose address the request already holds replaces it in its place: `200 {"accepted", "rejected", "overBudget", "pages", "message"}`, `accepted` being how many were stored, `rejected` how many were unusable (no absolute http(s) address or no text, or an address sent twice), `overBudget` how many were left out whole because their text would take the request past 99,800 characters of page text in all (what docket's 100,000-character budget across a request's pages uses whole, the text a replaced page held not counted), and `pages` how many it holds. A request holds at most 10 pages: more is `409 too_many`, saying how many it holds; when no page fits the text budget, `409 too_much_text`. None usable, or the wrong shape, is `400`; more than 10 in one request `400 too_many`; anyone else's, a deleted or finished one, or not a research request, is `404`; a web request not waiting for a fuller pass, or one whose run was moved or has started, is `409`. Body up to 1 MiB. |
| `POST /api/v1/tasks/<id>/sources/ready` | Body `{}`. Starts that request on the pages it holds: its queued run is moved to now (docket-core's `reschedule`), and the execute lane submits it within a minute or two. For a request waiting for a fuller pass (0.29.0), it moves the request to now and then deletes the queued follow-up its wait rests on, under the task's lock, so the next execute tick runs the second pass on the pages; refused (`409`) once that follow-up has started, fired or has its Job out at the runner. No page in yet, a paused request, or one no longer waiting is `409`; the others as for `/sources`. From then the request takes no more pages; nor does it once a run of it has started, `ready` or not (the run at its expiry). Both routes take the task's lock: while the model runner has the task, either is `409 busy`. |
| `DELETE /api/v1/tasks/<id>` | Deletes it as the web does: archived, nothing more sent, history kept. No confirmation step. |

A task is `{"id", "type", "title", "status", "version", "cadence", "nextAt", "createdAt", "updatedAt",
"settings"}`, and a price also has a top-level `url`: `status` is `active`, `paused`, `done` or
`deleted`; `cadence` is the schedule in words, in your zone; `nextAt` the next run's instant (UTC),
null when paused or nothing is due; `settings` exactly the fields a `PATCH` takes, as the task has
them. A research request's `settings` are what was asked -- `question`, and `context` and
`deadline` (an instant) when given, and `sources` (`web` or `browser`) -- shown to you alone and changed by no `PATCH`; a browser request also has a top-level `sources: "browser"` (the same value as `settings.sources`, for a helper that reads only the top level), `pages` (how many are in) and `waitingForPages` (true until `ready` moved its run, or a run of it started). So does a request whose first answer listed pages its run could not open (0.29.0, top-level `sources: "web"`, `waitingForPages` true while it waits for a fuller pass), and both have `blocked`, the pages to gather, each `{site, url?, why}` (empty when there are none). A price's `url` is read-only -- another page is another tracker -- so it is not in `settings`
and a `PATCH` naming it is refused (`unknown_field`). A write answers
`{"task", "message"}`, `message` being the words the web and the command say.

**Retries and versions** (0.37.0, #369). Any write -- `POST`, `PATCH` or `DELETE` -- may carry
`Idempotency-Key`, 8 to 128 letters, digits, `-`, `_`, `.` or `:` (a UUID will do). The same key
with the same method, path, body (its keys in any order) and `If-Match` within 24 hours is one write: a retry
gets the first answer again, with `Idempotency-Replayed: true`, and makes nothing more. Only a `2xx`
answer is kept, so a retry of a refused write runs again; a write that failed partway with a server
error may have made its change, so its key answers `500 outcome_unknown` from then on. The same key for a different request is
`409 idempotency_conflict`; a retry while the first is still running is `409
idempotency_in_progress` with `Retry-After`. Keys are per person, and forget-me erases them. A claim
still unfinished after 2 minutes is treated as abandoned (every write here ends well before that). A
task's `version` (also the `ETag` of `GET /tasks/<id>` and of every create, edit, pause, resume and
delete answer) changes when its title, settings, schedule, status or capabilities do, not when it
runs -- unless the run finishes the task, which changes its status. Send it back as `If-Match: "<version>"` on a `PATCH`,
`DELETE`, pause or resume to make the write conditional: a task changed since is `412
version_mismatch` and nothing is written. Without `If-Match` a write goes through as before.

**Errors** are `{"error": {"code": "...", "message": "..."}}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid` | A rule refused a value; `message` is the rule's own words, as the web editor shows them. Also a field of the wrong JSON type, or no `type`; a `limit` not 1 to 200, a `cursor` without one, or either given twice. |
| 400 | `unknown_field` | A field that type does not take (on a pause or resume, any field). |
| 400 | `invalid_cursor` | A `cursor` this API did not give (or the owner's tasks were erased since). |
| 400 | `invalid_json` | The body is not JSON, or not one object. |
| 400 | `too_many` | More than 40 listings in one `/listings` request. |
| 400 | `invalid_idempotency_key` | An `Idempotency-Key` not 8 to 128 of the characters above. |
| 400 | `if_match_unsupported`, `invalid_if_match` | `If-Match` on a write that is not to one task (a create, a validate, a run now, listings, sources), or not one quoted version. |
| 401 | `unauthorized` | No `Authorization` header. With `WWW-Authenticate: Bearer realm="tracker"`. |
| 401 | `invalid_token` | A token unknown, revoked or expired, or whose owner is no longer registered (their tokens are then deleted); a usr delegation token that fails a check above, comes from a service not in `TRACKER_API_DELEGATES`, or acts for a usr account linked to no one registered: one answer for all, with `WWW-Authenticate`. An owner forgotten while their write waited in the queue gets the same code with its own message and no `WWW-Authenticate`. |
| 403 | `origin_refused` | The request carried an `Origin` header. |
| 403 | `insufficient_scope` | A usr delegation token whose `scope` lacks this route's operation. With `WWW-Authenticate` naming the scope it needs. |
| 403 | `not_member` | The owner has left every `TRACKER_GUILD_ID` server (or lacks the `TRACKER_GUILD_ROLES` role where one is asked); their tokens are revoked. |
| 404 | `not_found` | No such endpoint, or no such task of yours. Anyone else's task -- one shared with you, or any task to an admin's token -- answers exactly as an unknown id. |
| 405 | `method_not_allowed` | With `Allow`. |
| 409 | `conflict` | A finished task edited, a research request edited, a pause of a task not active (a resume of one not paused), or pages sent to (or `ready` for) a research request that does not wait for them. |
| 409 | `limit_reached` | 200 active or paused tasks, 20 price trackers, 5 research requests waiting (one waiting for a fuller pass not counted), 3 scouts, 3 news watches, or 20 want-list watches, as the commands count them; or 10 runs now in the last 24 hours. |
| 409 | `cannot_run_now` | A run now of a task that cannot run now: a one-off, a renewal, a research request, one with a run already due, or one waiting on a retry (its message says which). |
| 409 | `too_many` | Pages sent to a research request that would then hold more than 10. (As a `400`, more than a request takes in one body.) |
| 409 | `too_much_text` | None of the pages sent to a research request fits in the text it may still hold (99,800 characters in all). |
| 409 | `idempotency_conflict`, `idempotency_in_progress` | That `Idempotency-Key` was used for another request; or its first request is still running (with `Retry-After`). |
| 409 | `busy` | Your last new price tracker's page is still being read, or the task is with the model runner right now (try again in a minute). |
| 412 | `version_mismatch` | `If-Match` names a version the task no longer has: read it again. |
| 413 | `too_large` | Body over 16 KiB (64 KiB for `/listings`, 1 MiB for `/sources`). |
| 415 | `unsupported_media_type` | Not `application/json`. |
| 429 | `rate_limited` | With `Retry-After`: this token's bucket, or the shared one for bad tokens. |
| 500 | `outcome_unknown` | A retry under an `Idempotency-Key` whose first request failed partway: it may have made its change, so read your tasks before sending it again under a new key. |
| 503 | `slow_page` | A new price's or page watch's page did not answer within 8 seconds of the request's arrival: nothing was made. With `Retry-After`. |
| 503 | `usr_unavailable` | A usr delegation token, and usr's signing keys could not be fetched to check it. With `Retry-After`. |
| 503 | `starting`, `membership_unknown`, `unavailable` | The plugin is starting; the owner's membership could not be checked for 24 hours, or, for a delegation token, since the plugin started (on a host with its own member lookup this is an outage; on an older host the lookup goes through the Discord client of the last command or button the bot handled, so after a restart none runs until someone uses one); the type is not available on this bot. |

**Example.**

```
$ curl -s https://clerk.example.com/tracker/api/v1/tasks \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" \
    -d '{"type": "reminder", "text": "water the plants", "when": "tomorrow 9am", "repeat": "week"}'
{"task":{"id":"t7","type":"reminder","title":"water the plants","status":"active",
 "cadence":"weekly on Fri at 9:00","nextAt":"2026-10-02T13:00:00.000Z",
 "createdAt":"2026-10-01T12:00:00.000Z","updatedAt":"2026-10-01T12:00:00.000Z",
 "settings":{"text":"water the plants","repeat":"week"}},
 "message":"Reminder `t7` set: water the plants\nNext: Fri Oct 2, 9:00, weekly on Fri at 9:00."}

$ curl -s -X PATCH https://clerk.example.com/tracker/api/v1/tasks/t7 \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" \
    -d '{"repeat": "day"}'

$ curl -s -X POST https://clerk.example.com/tracker/api/v1/tasks/t7/pause \
    -H "Authorization: Bearer $TRACKER_TOKEN" -H "Content-Type: application/json" -d '{}'

$ curl -s https://clerk.example.com/tracker/api/v1/tasks/t9 -H "Authorization: Bearer $TRACKER_TOKEN"
{"error":{"code":"not_found","message":"No such task."}}
```

## What it does

| Piece | File | Notes |
|---|---|---|
| Store | `src/store.ts`, `src/schema.ts` | docket's `Store` port on `bun:sqlite`, in `<dataDir>/tracker/tracker.sqlite` (WAL). A Discord id belongs to at most one user. Schema versioned by `PRAGMA user_version`; a shipped migration is never edited. Schema 5 (0.9.0) is docket 0.4.0's: a run's `record`, a series point's `key`, `deliveries` (from `delivery_claims`), `usage` and `notices`. Schema 6 (0.11.0) is docket 0.5.0's, all additive: `findings`, a charge's `usage.key`, and the Executor's `executor_jobs`. Forget-me erases a person's findings and their runs' Job records too. Schema 8 (0.19.0) adds `want_inbox`, the listings sent in for an inbox watch. Schema 9 (0.20.0) adds `users.usr_subject`, a person's usr user id, null until linked, unique when set. Schema 10 (0.25.0) adds `mail_addresses`. Schema 11 (0.28.0) adds `research_sources`, the pages a browser sent in for a research request (at most 10 per request, one per address, 99,800 characters of text in all), dropped once the request ends (by the execute tick's housekeeping, so only while the execute lane is configured) and always erased by forget-me. Schema 12 (0.34.0) adds `intake_conversations`, the intake's DM conversations. `store.test.ts` runs docket's `STORE_CONTRACT` against it. |
| Notify lane | `src/notify-lane.ts` | docket's `Lanes.tickNotify` on two host ticks, every 60 s, one pass per task with work (a due run, a run in flight, a DM owed or claimed), each under that task's lock through a view of the store limited to that task: `notify` runs every type but the page readers, `poll` runs only them (`price`, `wantlist`) with the Fetch port, so a slow page never holds up a reminder. A task the execute tick holds is left for the next notify tick, never waited on. Registers `reminder`, `renewal`, `price`, `research`, `scout`, `news`, `wantlist` and `wantjudge`. |
| Want-list watcher | `src/want.ts`, `src/inbox.ts`, `src/web/api-listings.ts`; the types and sources are `@rackbops/docket-types`' (0.7.0: `wantlist`, `wantjudge`, `pageSource`, `bggSource`, `inboxSource`) | `/want`'s rules; the `wantlist` type over a `Source` port; the `inbox` source over the `want_inbox` table (schema 8, 0.19.0: the listings sent in per watch, keyed `ebay-` or `bgg-` and 24 random hex digits, the newest 100 kept, as many as one look reads; a watch's rows go when it is deleted or finishes (#208), and forget-me erases them with the person's tasks), filled by the task API's listings route; the `page` source (JSON-LD listings through the fenced Fetch port, no HTML guessing) and the `bgg` source (BGG's XML API with the Bearer token, on `boardgamegeek.com`, never `www.`, at least 5 s between requests (a read due sooner is put back for the next tick, never waited on), read by a bounded `indexOf` parser, never a pattern over the whole body; a 401 or 403 is the token refused, a 202, 429 or 5xx a miss). The BGG fixture is hand-written to BGG's documented shape: BGG declined the application, so there is no token to capture a real response with. The judged watch (`wantjudge`) is an execute-lane type: its `prepare` reads the source in plain code (an uncharged `NoJob` when nothing is new), keeps new listings in the task's state as `pending` and asks for a follow-up, whose `prepare` makes the judge Job; `finish` maps the verdicts back by number, so a Job collected after a restart still has its listings. On this lane a BGG read due too soon waits out the spacing once. |
| Execute lane | `src/execute-lane.ts`, `src/executor.ts`, `src/research.ts`, `src/research-sources.ts`, `src/web/api-sources.ts`, `src/scout.ts` (the `scout` and `research` types are docket-types'; `research` over `researchType({ readSources })`, 0.8.0, reading a browser request's pages from `research_sources`, and since 0.29.0 a fuller pass's, given only with the web area) | Only when the city-hall Executor is configured: a third host tick, `execute`, that starts docket's `Lanes.tickExecute` in the background (one at a time, at most once per host tick, about a minute) over every task with a due execute-lane run, reserving those tasks and then holding their locks in id order, through one docket `Lanes` kept while the plugin is active (docket keeps its usage-limit pause on it). The Executor is city-hall#18's source pair (above), its I/O injected; `executor_jobs` keeps each Job key's city-hall id. `/research`'s and `/scout`'s rules, and the scout type. |
| Intake | `src/intake.ts`, `src/intake-store.ts`; the turn is docket-types' (0.14.0: `intakeJob`, `readIntake`, `checkDraft`) | The DM hook, the turn loop on its own poll with its own city-hall Executor (Job ids in memory only), the draft card's buttons and Save through `web/api-tasks.ts`'s create; the conversations table. |
| Budgets, usage | `src/ceilings.ts`, `src/usage.ts`; `src/web/ceiling-pages.ts`, `src/web/usage-pages.ts` | The execute lane's `BudgetPolicy` (docket's defaults plus each person's raise, or no ceiling at all while `TRACKER_BUDGET_UNLIMITED` is on), the ceiling changes, and the pure usage report `/admin/usage` renders from docket's `usage` table. |
| Page reads | `src/fetch.ts` | docket's `Fetch` port for `price` and the want-list's `page` source: http or https on the default port, no credentials, every resolved address public (no loopback, private, link-local, CGNAT, multicast or reserved range, IPv4 or IPv6), redirects followed by hand and re-checked (at most 5; a redirect to something that is not a web address is refused), 15 s including the name lookup, at most 3 MB kept. The body is then rebuilt in linear time (`src/page.ts`) to just what extraction reads -- at most 200 JSON-LD blocks and 300 meta tags, the first ones in page order (room for a shop search page with one JSON-LD block per product beside its other blocks; the `page` source keeps at most 100 listings a page, docket-types' `MAX_LISTINGS`, and a look takes at most 20 new ones, the rest on the next look), and the page with every `<` blanked, so `near` still reads text, attributes and script data -- because docket's extraction patterns take quadratic time on a page of unclosed tags. Tag names are matched with only `A`-`Z` folded to lower case, so a letter that changes length when lower-cased (the Turkish `İ`) does not shift the tags after it out of reach. A read the tick's abort cuts short requeues its run instead of counting a miss. A DNS answer that changes between the check and the read is not caught here. A refusal says why -- the name did not resolve, or it is not on the public internet -- so anyone who may make a price tracker or page watch (a command, the web editor or the task API) can learn which names the bot host's resolver maps to private addresses; one read at a time per person and the API's rate limit slow that, they do not stop it. A want-list page read (docket-types' `page` source) carries `NEVER_EBAY` and is refused on any hop to eBay; a price read is not. |
| Renewals, prices | `src/tracked.ts`, `src/price.ts`, `src/series.ts`, `src/page.ts` | `/renewal`, `/price` and `/task decide`; the series lines of `/task history`. The series (docket's `series` table, schema 1) holds a renewal's paid amounts and a price's readings. |
| Delivery | `src/notifier.ts`, `src/buttons.ts` | docket's `Notifier` over `host.dm`, with the buttons. docket claims each (run, person) in the store's `deliveries` before the DM and settles it after. The notifier maps the host's answers to docket's errors: cannot be messaged (50007) or an unknown user is `DeliveryFailedError(msg, true)` (failed for good; 50007 and 10013 count toward the pause); a message refused for its content is a plain `DeliveryFailedError` (retried); a paused person is `ExecutorUnavailableError` (deferred); anything else is rethrown, so docket settles it unconfirmed and never resends it. |
| Daily digest | `src/digest.ts` | Plan 5.5's "today and overdue" DM, on the `notify` tick after the runs due now, no model. For each person whose preferred hour has come in their zone, the day is claimed first (docket's `claimNotice`, key `digest:<user>:<YYYY-MM-DD>`, research-triage's exactly-once pattern; forget-me erases it) unless a read of their last claim finds it already claimed or due less than 20 hours before today's hour (a move east, a preferred hour moved over 4 hours earlier, or a move west across the date line; a claim dated in the future counts as none), then their own active reminders and renewals are read: overdue is the latest fired run before today with no done or decision from the owner, due today is a run not yet fired today or the latest fired run today still unanswered. A snoozed run, an older run behind a newer one, other types and received tasks are left out. Nothing listed, no DM; too long for one message, it caps both sections at the same, smaller number of lines (the most that fit) and counts the rest; a paused person is passed by unclaimed; a failed send is not retried. |
| Task lock | `src/locks.ts` | One task at a time: its runs, answers and edits never overlap (docket 0.4.0 asks the host to serialize per task). |
| Pause | `src/delivery-health.ts` | The per-person failure count, the pause and the resume. |
| People | `src/people.ts`, `src/admissions.ts` | Discord id, time zone, preferred hour, admin flag -- in the tracker's store, with each person's usr user id once the usr link links them (`src/usr.ts`, 0.20.0); who admitted each person and when they registered. `TRACKER_ADMIN_DISCORD_IDS` only ever grants admin. |
| Commands | `src/discord.ts`, `src/interactions.ts`, `src/discord-common.ts` (discord.js); `src/actions.ts`, `src/press.ts`, `src/history.ts`, `src/access.ts` | The discord.js files read options and render; the rest is Discord-free over the injected store, clock and notifier. Store writes are handled one at a time; Discord lookups and DMs run outside that queue. |
| Health | `src/health.ts` | `GET /tracker/healthz` (through the bot's HTTP router): `200` `ok`/`starting`, `503` `inactive`/`stale`/`blocked`. |
| Admin, forget-me | `src/admin.ts`, `src/roster.ts`; `src/web/admin.ts`, `src/web/admin-pages.ts` | The admin acts and forget-me, Discord-free; the SQL docket's Store has no method for (listing people and blocks, erasing a person); the routes and pages. |
| Web area | `src/web/` | `app.ts` authenticates and dispatches (pure over the injected store and clock), `routes.ts` names the paths; `pages.ts`, `editor-pages.ts` and `html.ts` render; `form-input.ts` reads the editor's fields and `editor.ts` calls the shared rules with them; `signin-link.ts` and `sessions.ts` hold the sign-in; `theme.ts` the stylesheet; `command.ts` is `/web`. |
| Task API | `src/web/api.ts`, `src/web/api-tasks.ts`, `src/web/api-tokens.ts`, `src/web/tokens.ts`, `src/web/token-pages.ts` | The JSON API's authentication, gates and rate limit; its task routes over editor.ts's writes; the tokens (SQL, hashed); the tokens page and its routes. |
| Task rules | `src/reminders.ts`, `src/tracked.ts`, `src/price.ts`, `src/research.ts`, `src/scout.ts`, `src/news.ts`, `src/want.ts`, `src/edit.ts`, `src/manage.ts`, `src/limits.ts` | What makes, edits, pauses, resumes and deletes a task, and the limits on it, Discord-free, for the commands and the web editor alike. |

## Configuration

| Env key | Secret | Meaning |
|---|---|---|
| `TRACKER_ADMIN_DISCORD_IDS` | no | Comma-separated Discord user ids (spaces around commas allowed; an empty entry, as from a trailing comma, is refused and the plugin does not load) made admin at start. Unset = none. Removing an id does not revoke it. |
| `TRACKER_GUILD_ID` | no | The Discord server whose members may use the tracker, or a comma-separated list of them (spaces around commas allowed; a repeated id counts once): a member of any listed server passes. Checked through the interaction's client with a single-member lookup per server (no privileged intent), all asked at once; a yes from any server is a member, a no from every server is not, and otherwise the answer is unknown (refused, never revoked). Inside a listed server, the person running a command needs no lookup. Unset = no membership gate, and a warning is logged each time the plugin activates; a malformed or empty entry anywhere in the list refuses to load, naming it. One store and one admission list serve every listed server; there are no per-server admins. |
| `TRACKER_GUILD_ROLES` | no | The Discord-role check (plan 1.1, 5.5): comma-separated `serverId:roleId` pairs (spaces allowed; a server named twice takes either role). In a server named here, a member counts only while they hold one of its roles, read off the same forced single-member lookup (so the in-server shortcut is skipped there); a `TRACKER_GUILD_ID` server not named here stays membership-only. The `TRACKER_ADMIN_DISCORD_IDS` admins skip the role, never the membership, so a wrong or removed role cannot lock them out. Lacking the role is a no for that server, exactly like leaving it: commands and buttons are refused (decline and opt-out still work), `/allow` and `/task share` refuse the person, and the web area and API tokens sign them out and revoke on their next re-check; their tasks, history and DMs stay as they are. A named role the server does not have is logged once; when none of a server's named roles exists there, everyone else's answer is unknown (refused, never a no: no token is revoked, and a web session ends only when its 24-hour grace runs out, as in an outage). A server's own id (its @everyone role) is refused. Every server named must be in `TRACKER_GUILD_ID`, and anything that is not a list of id pairs refuses to load, naming the entry. Unset = no role check. |
| `TRACKER_WEB_URL` | no | The https origin the bot's HTTP is reached at through its tunnel, e.g. `https://clerk.example.com` (no path). `/web` links and the allowed `Origin` come from it, never from a request's `Host`. Unset = no web area (`/web` says so, the pages answer 404); anything but a bare https origin refuses to load. |
| `TRACKER_BUDGET_UNLIMITED` | no | Budgets off for the alpha (0.14.0): `true` or `1` means no daily ceiling -- a person's or the global one -- holds a model run, bot-wide. Each Job's own caps still apply, usage is still recorded (see `/admin/usage`), the bot logs one line at start saying so (or, with the execute lane off, that no model work runs), the People and Usage admin pages show a "Budgets off (alpha): unlimited" banner, and the person page's ceiling section shows a "not enforced" note. Unset, empty, `false` or `0` = the ceilings apply (the default); anything else refuses to load. |
| `TRACKER_CITY_HALL_URL` | no | The https origin of the city-hall that queues the tracker's model Jobs (no path). |
| `TRACKER_CITY_HALL_KEY` | yes | The source bearer key city-hall checks on `/api/execute/jobs` (its `CITY_HALL_API_KEY`, city-hall#18). Visible ASCII only: a value with whitespace inside it or any other character outside visible ASCII refuses to load (whitespace at either end is trimmed), naming the variable. Never logged. Kept in the instance's own env, never in a repo. |
| `TRACKER_CITY_HALL_CAPABILITY` | no | The capability tag every Job names, one only docket-runner carries (plan item 71), e.g. `claude-cli:subscription`. No default: a guessed tag could send the tracker's Jobs to another agent. |
| `TRACKER_CITY_HALL_ACCESS_CLIENT_ID`, `TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET` | yes | A Cloudflare Access service token for city-hall's edge (`CF-Access-Client-Id` / `-Secret`), when one is in front. Both or neither, each visible ASCII only, as for the key. |
| `TRACKER_INTAKE` | no | The plain-language intake (above): `off`, `admins` or `everyone`, any case. Unset or empty = off; anything else refuses to load. On with the execute lane off, a DM is answered that the assistant is not set up. |
| `TRACKER_INTAKE_CAPABILITY` | no | The capability tag the intake's turn Jobs name, e.g. `claude-cli:intake`, for a runner that takes only those. Unset = `TRACKER_CITY_HALL_CAPABILITY`; one that is not a tag refuses to load. |
| `TRACKER_FIRECRAWL_KEY` | yes | A Firecrawl API key for `/want source: shopify` (0.32.0): each look is one Shopify catalog search through Firecrawl's Alexandria (`shopify` / `catalog/search_catalog`, 5 credits), sent only to `https://api.firecrawl.dev/v2/scrape` with no redirect followed. Unset or empty = `source: shopify` is refused. Never logged. The runner's Firecrawl key can be used here too, in which case both draw on that one account's credits. |
| `TRACKER_EBAY_CLIENT_ID` | yes | The App ID (client id) of an eBay developer Production keyset, for `/want source: ebay` through eBay's own Browse API (0.33.0). Goes with `TRACKER_EBAY_CLIENT_SECRET`: both set = `source: ebay` searches eBay US through the API; both unset or empty = `source: ebay` is an inbox watch; one without the other refuses to load. Sent only to `https://api.ebay.com`, with no redirect followed. Never logged. eBay's Dev ID is not needed. |
| `TRACKER_EBAY_CLIENT_SECRET` | yes | The Cert ID (client secret) of that keyset. The tracker mints an application token from the pair (client credentials, scope `https://api.ebay.com/oauth/api_scope`), keeps it in memory only, and mints again a minute before it ends or once when a search answers 401. A look is one of the keyset's Browse calls (5,000 a day). eBay US prices in USD, so an API eBay watch takes no other `currency`. Never logged. |
| `TRACKER_BGG_TOKEN` | yes | BoardGameGeek's XML API Bearer token for the tracker's registered application. Set = `/want source: bgg` watches a game's BGG marketplace; unset or empty = `/want source: bgg` makes an inbox watch instead, whose listings are sent in (as for eBay). Never logged. BGG declined the tracker's application (applied 2026-09-29, non-commercial), so no token exists today; if BGG ever grants one, put it in the instance's `.env` and recreate the bot. BGG's terms ask for attribution: every BGG line in a DM says "via BoardGameGeek". |
| `TRACKER_USR_URL` | no | The https origin of our usr (Rackbops/usr), e.g. `https://id.example.com` (no path). With `TRACKER_USR_KEY` it turns the usr link on (0.20.0): people stay in the tracker, and each is linked to a usr account by usr's user id (`users.usr_subject`). Unset = off, and the tracker behaves as before (migration 9 still adds the empty column). `/allow` and `/register` use it since 0.21.0, and the web sign-in since 0.22.0 (Signing in through usr, above). |
| `TRACKER_USR_KEY` | yes | The tracker's usr API key, with the role `usr:discord` only (usr's `/api/discord/allow` and `/register-link`), never `tracker:admin` or `tracker:register`, and a usr Discord service (`PUT /api/discord/services/<keyId>`) set to the tracker's app. Required with `TRACKER_USR_URL`; set without it, or with whitespace in it, refuses to load. Never logged. |
| `TRACKER_MAIL_DOMAIN` | no | The domain the alert-email route (0.25.0, Alert emails below) receives mail at, e.g. `alerts.example.com`: lower case, at least one dot. With `TRACKER_MAIL_KEY`; both unset = off (`/tracker/mail/inbound` answers 404 and no address is shown). One without the other, a domain that is not one, or a key under 32 characters or with white space refuses to load, never echoing either. |
| `TRACKER_MAIL_KEY` | yes | The bearer the Email Worker posts to `/tracker/mail/inbound` with, at least 32 characters; the same value is the Worker's `CLERK_MAIL_KEY` secret. Never logged. |
| `TRACKER_API_DELEGATES` | no | usr API key ids (digits, comma-separated) of the services whose usr delegation tokens the task API takes, such as tracker-mcp's. Unset = only `trk_` tokens. Needs `TRACKER_USR_URL`. |
| `TRACKER_USR_APP` | no | The usr app the tracker's roles live under (`tracker:member`, `tracker:register`): lowercase words joined by `-`. It must match the app on the key's usr Discord service row, which is what usr goes by. Unset = `tracker`. Needs `TRACKER_USR_URL`. |

**The execute lane is off until all three of `TRACKER_CITY_HALL_URL`, `_KEY` and `_CAPABILITY` are
set**: no `execute` tick, and `/research` answers that research is not available, so nobody can
make a request that would wait forever. With some but not all set, the plugin logs which are
missing at start; a malformed value (not an https origin, not a tag, one half of the Access pair)
refuses to load, naming the variable and never echoing a secret or a URL (one with credentials in it
answers "must not contain credentials"). This is the tracker's credential
toward city-hall that plan item 50 moved to E8; until Nazu settles how sources authenticate
(city-hall#2, item 25), it is city-hall#18's interim shared source key. One city-hall source key
may serve more than one tracker instance: Job keys are `rackbops-tracker:<database id>:<docket Job
key>`, so two databases never collide.

`/tracker/healthz` and the web area need the bot's `HTTP_PORT` set; without it there is no HTTP at all.

**Link everyone to usr** (0.23.0, the admin page, with the usr link on). People admitted before the
link was on are not linked to usr. One press starts a run in the background (the bot answers a web
request it waited on for 10 seconds with a 504, so the press does not wait) and goes back to the
admin page, which shows how far the run has got and then how it ended; a second press while it runs
starts nothing. For each person on the list with a Discord id and no usr link, one at a time, it
checks they are a member of the server with its role, as `/allow` does; re-reads them just before asking
usr, so someone forgotten before then is never sent; allows them in usr as `tracker:member`, with the pressing
admin as the one who allowed them; then links them. usr records each link against
`TRACKER_GUILD_ID`'s first server, so with no gate it refuses and says to `/allow` in the server
instead. Only a 400 from usr whose reason starts with one of the person's own fields (`discord_user_id`,
`display_name`) is theirs, listed by name while the rest go on; any other 400, refusal or failure (the admin not linked in usr or missing `tracker:register` or `tracker:member`,
the key, usr unreachable) stops the run, since it would fail everyone the same way. It never starts
on its own. It passes over everyone already linked, so it does not fix a link usr moved at sign-up
(`/allow` above); Refresh usr links does.

**Refresh usr links** (#170, the admin page, with the usr link on). The same run, over everyone on the
list already linked. usr answers each with the account it has for them now, and a link usr moved at
sign-up is updated, so their usr sign-in works. It changes usr: it puts `tracker:member` back for
everyone still linked and in the server, undoing a usr admin's removal of it, and someone whose usr
link a usr admin removed gets a new usr account (an existing account's display name and who allowed
it stay as they were). It ends with how many were refreshed, how many moved to another account, how
many got a new usr account, how many failed and how many were skipped, naming each failure (not a
member, a 400 about them, or the account usr names already linked to someone else here) while the
rest go on; a failure that would fail everyone stops it, as above, with the counts so far. Someone
forgotten is never sent, and one run of either kind goes at a time.

**First admin and usr.** usr's `/api/discord/allow` needs the admin running `/allow` to be linked in
usr already, so the first admin cannot be `/allow`ed by anyone. With the usr link on, a configured
admin (`TRACKER_ADMIN_DISCORD_IDS`) who is not linked gets usr's open sign-up link from `/register`,
run in a server. They finish signing up on usr, a usr admin gives them `tracker:register` and
`tracker:member` there, and they run `/allow` on themselves, which links their tracker account.
From then on they `/allow` everyone else. (usr's own "Setup" step 3, in `docs/discord-registration.md`, has the owner `/register` through the bot; the tracker uses the open link for that one step only, since its `/register` otherwise asks with the allow policy.)

## Not yet

- The rest of the web area (E5): sharing a task from the web, and the admin view's grants and
  retry. The task API makes reminders, renewals, prices, research requests, scouts and
  want-list watches -- not `/task done`, `snooze`, `decide`, `share` or the settings -- and no intake agent uses it yet
  (E10, deferred). Discord OAuth2 as a second sign-in
  method, if chosen (plan item 41).
- For the alert emails: checking the sender's DKIM signature, not only its `From` address (the private address is the guard today), and a captured alert with several matches.
- For the want-list watcher (#83): a captured BGG response to replace the hand-written fixture, if
  BGG ever grants a token (it declined the application), a live check that the CLI holds the judge to its `WebFetch(domain:...)` rules,
  and giving the scout, wantlist and wantjudge types back to `Rackbops/docket`.
- The rest of #82: per-type grants beyond tier 0 (research needs only `notify`), the transcripts
  policy, and live verification against a real city-hall and docket-runner
  ([Lepid-Labs/city-hall#18](https://github.com/Lepid-Labs/city-hall/pull/18) is merged as
  90a06ec, its decision record still "proposed" pending
  [Lepid-Labs/city-hall#17](https://github.com/Lepid-Labs/city-hall/issues/17); the research lane
  still needs a deployed city-hall with a runner).
- Editing in Discord (the editor is on the web only; `/scout edit` is the one exception), and changing a price tracker's page or `near` after it is made (make a new one); a free-form pattern for `price` (`near` is the safe subset: a user's regular expression run on a large page could hang the bot).
- Showing a run's deliveries in its history (admins see the ones that did not arrive on `/admin/deliveries`).

docket-core, docket-types and `@rackbops/styles` are `devDependencies`: `bun build` bundles them
into `dist/plugin.js` (the theme's CSS as text), and the bot loads that file without installing
anything.
