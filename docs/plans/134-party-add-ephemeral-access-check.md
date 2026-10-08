# #134 -- /party add checks access under an ephemeral reply, so the authorize link and connection-state errors never reach the channel

Standalone S, priority high. Behaviour change (which of `/party add`'s replies are public): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` at `3356230`. Cites are to that tree.

### What is wrong

`plugins/music/src/commands.ts:708` is `await interaction.deferReply();` with no ephemeral flag, and `:709-713` edits that public reply with `access.message`. For a caller who connected with plain `/spotify connect` (playlist scopes only) that message embeds a fresh authorize URL carrying a single-use OAuth `state` token (`:622-630`, `partyConnectLink` at `:590-595`); for others it leaks their connection state ("You haven't connected Spotify yet", "no longer valid (HTTP 400 ...)"). The `state` token is the only thing binding the callback to the Discord account (`server.ts:95-106`, `store.ts:171-176`), so anyone in the channel who completes consent on that link within ten minutes attaches their Spotify account to the invoker's Discord id, after which the invoker's playlists and party playback go to the wrong account. `/party start` (`:677`) and the Join button (`:854`) already defer ephemerally. `/party add` does not require party membership. No test drives `handlePartyAdd`.

### Decisions

- **The access check runs under an ephemeral defer; only the queue result is public.** `deferReply({ flags: MessageFlags.Ephemeral })`, exactly as `/party start` does. Every `!access.ok` branch, and every search or match failure ("Spotify search failed", "Nothing on Spotify matched", "didn't say how long"), edits that ephemeral reply: they are about the invoker's connection or query, not the party.
- **A successful add still tells the channel, through a `followUp`.** The ephemeral reply is edited to the invoker's own confirmation, and the channel gets one public `followUp`: `<@user> queued **Track** -- Artist.` when the party was already playing, or `<@user> queued **Track** -- Artist` followed by a newline and `formatOutcomes(outcomes)` when the add started an idle party (the per-member problems were public before too, and name what each person should do). This mirrors `/party start`'s edit-then-followUp shape (`:693-699`).
- **Membership is not required to add.** Unchanged; out of scope.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/commands.ts`, `handlePartyAdd`:
   - `await interaction.deferReply({ flags: MessageFlags.Ephemeral });`
   - the `!access.ok`, search-failed, no-match and no-duration branches stay as they are (they now edit an ephemeral reply);
   - playing party: `await interaction.editReply({ content: \`Queued **${track.name}** -- ${track.artist}.\` });` then `await interaction.followUp({ content: \`<@${interaction.user.id}> queued **${track.name}** -- ${track.artist}.\` });`
   - idle party: `const outcomes = await access.runner.start(guildId);` then `editReply({ content: \`Started the party with **${track.name}** -- ${track.artist}.\` })` and `followUp({ content: \`<@${interaction.user.id}> queued **${track.name}** -- ${track.artist}\n${formatOutcomes(outcomes)}\` })`.
   - A comment above the defer: why the check is ephemeral (the link carries a single-use `state` token; the channel must never see it) and why the result is a `followUp`.
2. `plugins/music/src/commands.test.ts`, a new section "the party's add command":
   - `fakePartyCommand(sub: string, options: Record<string, string>, userId: string, guildId = "G1")`: a `ChatInputCommandInteraction` stand-in with `guildId`, `channelId: "C1"`, `client: {}`, `user: { id }`, `options: { getSubcommand: () => sub, getString: (name, required) => options[name] ?? (required ? throw : null) }`, and recorders for `deferReply(opts)` (keep the `flags`), `editReply`, `followUp`, `reply`. Obtain the `/party` handler from `musicCommands()` the way the file obtains `/setlist`'s.
   - `wireParty({ scopes, connected = true, searchHit = true })`: `logged = []`; `resetStoreForTest(connected ? putConnection(freshState(), USER, "RT", 1, scopes) : freshState())`; `initCommands({ config: { setlistFmKey: "KEY", missing: [], spotify: { clientId: "cid", clientSecret: "csecret", redirectUri: "https://bot.example.com/spotify/callback" } }, setlistFm: <the no-op stubs wireBuild uses>, spotify: buildSpotify({ refresh: async () => ({ ok: true, value: { accessToken: "AT", scopes } }), searchTracks: async () => ({ ok: true, value: searchHit ? [{ ...track("One"), durationMs: 180_000 }] : [] }) }), runner: <a PartyRunner double whose start returns [{ discordUserId: USER, ok: true }] and whose other methods are no-ops>, serverRunning: () => true, log: captureLog })`. Check `config`'s type for the `spotify` field's name and shape against `config.ts` before writing it.
   - The party is seeded with `resetPartiesForTest(openParty(freshParties(), { guildId: "G1", channelId: "C1", hostId: "host", members: ["host"], queue: [{ uri: "spotify:track:zero", name: "Zero", artist: "Band", durationMs: 180_000 }], index: 0, trackStartedAt: 1 }))` for a playing party, and with `queue: []`, `index: 0` and no `trackStartedAt` for an idle one.
   - Tests:
     - "a caller without the party scopes gets the authorize link ephemerally and the channel sees nothing": `scopes: SPOTIFY_SCOPES`; the defer's `flags` equal `MessageFlags.Ephemeral`; exactly one edit, containing "Grant it here"; `followUp` and `reply` never called.
     - "a caller who hasn't connected is told so ephemerally": `connected: false`; the edit contains "/spotify connect"; no `followUp`.
     - "a queued track is announced to the channel without any link": `scopes: PARTY_SCOPES`, playing party; the edit contains "Queued **One**"; exactly one `followUp` containing `<@${USER}> queued **One**`; neither the edit nor the followUp contains "authorize" or "Grant it here".
     - "adding to an idle party starts it and the channel hears who queued what": idle party; the `runner` double's `start` is called once with "G1"; the followUp contains `queued **One**` and "Playing for 1 person."
     - "a search failure stays with the invoker": a `searchTracks` answering `{ ok: false, error: "Spotify returned HTTP 503" }`; the edit contains "search failed"; no `followUp`.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: `/party add` now checks the caller's Spotify access under an ephemeral reply, so the authorize link (which carries a single-use sign-in token) and "not connected" / "no longer valid" answers go only to the person who ran it; the channel still hears who queued what, through a separate public message, exactly as `/party start` already worked (#134).
4. This file, committed as `docs/plans/134-party-add-ephemeral-access-check.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- every reply path of `handlePartyAdd`, what Discord does with an ephemeral defer followed by a public `followUp`, the idle-party start path, whether any other handler still answers an access failure publicly (`grep` every `deferReply(` in `commands.ts`); B: claims-vs-code over this plan, the CHANGELOG and the comment, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
8. PR `fix(music): check /party add access under an ephemeral reply so the authorize link never reaches the channel (#134)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #134`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Fix) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The authorize link and connection-state answers never reach the channel | 1, 2 | the no-party-scopes and not-connected tests | defer publicly (drop the flag) -- the defer assertion; answer the access failure through `followUp` -- the no-followUp assertion |
| A successful add still tells the channel who queued what | 1, 2 | the playing-party and idle-party tests | drop the `followUp` -- no public message |
| The invoker still gets their own confirmation | 1, 2 | the playing-party test's edit assertion | drop the `editReply` -- the deferred reply is never resolved |
| Search and match failures stay with the invoker | 1, 2 | the search-failure test | answer them through `followUp` |
| An idle party is started by the add, as before | 1, 2 | the idle-party test | drop the `runner.start` call -- `start` never called, no outcomes line |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
