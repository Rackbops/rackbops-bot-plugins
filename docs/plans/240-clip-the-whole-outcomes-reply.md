# #240 -- the add and skip replies are clipped to Discord's limit as a whole, lead line included

Epic #237 child, XS. Behaviour change (the content of two replies at the limit): the three-reviewer gate applies.

## Plan (execute as written)

Written 2026-10-08 against `main` with #242 merged (#153); cites are to `7faecc9` plus #242's change to `handlePartySkip`, so re-find by function name if the numbers have shifted.

### What is wrong

`formatOutcomes` (`plugins/music/src/commands.ts:636-644`) clips its own text to `MAX_REPLY_LENGTH` (2000, `:50`) with `clip` (`:103-105`: a message over the limit is cut to `limit - 3` characters plus `...`). Two callers put a line in front of it after that clip: the idle-party `/party add` follow-up, `<@user> queued **Track** -- Artist\n` + `formatOutcomes(outcomes)` (`:762-764`), and the `/party skip` reply, `Skipped to **Next** -- Artist\n` + `formatOutcomes(outcomes)` (the last line of `handlePartySkip`). Once `formatOutcomes` is at its cap (about fifteen members failing at once, each with an error sentence), the composed message exceeds 2000 characters: discord.js refuses it before sending, the handler throws after its defer (the spinner case of #194's `music-commands-party-9`), and the channel hears nothing about the add or the skip. `/party start`'s follow-up is fixed text and is not affected; `formatOutcomes` has no other caller (`grep formatOutcomes\( plugins/music/src` finds the definition and these two).

### Decisions

- **`formatOutcomes` takes the leading line and clips the whole message once.** `export function formatOutcomes(outcomes: readonly MemberOutcome[], lead?: string): string`: build `head` and `problems` as today, `body = problems.length === 0 ? head : `${head}\n${problems.join("\n")}``, and return `clip(lead === undefined ? body : `${lead}\n${body}`, MAX_REPLY_LENGTH)`. The clip lives in one place, so the next caller cannot repeat the mistake; a message that fits is returned untouched, as today.
- **Both callers pass their lead instead of concatenating.** `handlePartyAdd`'s idle follow-up becomes `formatOutcomes(outcomes, `<@${interaction.user.id}> queued **${track.name}** -- ${track.artist}`)` and `handlePartySkip`'s reply `formatOutcomes(outcomes, `Skipped to **${next.name}** -- ${next.artist}`)`. The text is unchanged below the limit.
- **What the clip cuts is unchanged:** the tail of the member list, with `...`, exactly as `formatOutcomes` already does; the lead always survives because the cut is from the end.
- **No version bump.** CHANGELOG under `## [Unreleased]` `### Fixed`; `plugins.json` is unaffected.

### Steps

1. `plugins/music/src/commands.ts`: `formatOutcomes(outcomes, lead?)` as decided, its JSDoc saying the lead is clipped with the rest so the whole reply fits Discord's limit; the two call sites pass their lead. Nothing else changes.
2. `plugins/music/src/commands.test.ts`:
   - A helper near the `/party` fixtures: `function failures(n: number): MemberOutcome[]` returning `n` outcomes `{ discordUserId: String(100000000000000000 + i), ok: false, error: "their Spotify didn't take the command: no active device was found" }` (about 95 characters a line, so 40 of them are roughly 3800 characters).
   - `partyRunnerDouble(started, outcomes, calls = [], skipOutcomes: MemberOutcome[] = [])`: `skip` records `skip:<guild>` as today and returns `skipOutcomes` (today it returns `[]`; the default keeps every existing test as it is). `wireParty` gains `skipOutcomes` (default `[]`) and passes it through.
   - `describe("formatOutcomes with a leading line")` (a unit test of the exported function):
     - "the whole message, lead included, fits Discord's limit": `formatOutcomes(failures(40), "<@1> queued **One** -- Band")` -> `.length` is at most 2000, it starts with `"<@1> queued **One** -- Band\nPlaying for 0 people.\n"`, and it ends with `"..."`.
     - "a message that fits is untouched": `formatOutcomes([{ discordUserId: USER, ok: true }], "Skipped to **Two** -- Band")` equals `"Skipped to **Two** -- Band\nPlaying for 1 person."`.
     - "without a lead it reads as before": `formatOutcomes([{ discordUserId: USER, ok: true }])` equals `"Playing for 1 person."`.
   - In `describe("the party's add command")`: "an idle add's announcement fits Discord's limit when many members fail": `wireParty({ scopes: PARTY_SCOPES, party: "idle", outcomes: failures(40) })` -> exactly one follow-up, its `content.length` at most 2000, starting with `<@${USER}> queued **One**` and ending with `...`.
   - In `describe("the party's skip command")`: "a skip's reply fits Discord's limit when many members fail": `wireParty({ scopes: PARTY_SCOPES, members: ["host", USER], queue: [partyTrack("One"), partyTrack("Two")], skipOutcomes: failures(40) })` -> the edit's `content.length` at most 2000, starting with `Skipped to **Two**` and ending with `...`.
3. `plugins/music/CHANGELOG.md`, under `## [Unreleased]` `### Fixed`, a new first bullet: the reply after an add that starts an idle party, and the reply after `/party skip`, are now clipped to Discord's 2000 characters as a whole; before, the per-member outcome list was clipped but the leading line was added on top, so with many members failing at once the message was too long and Discord refused it (#240).
4. This file, committed as `docs/plans/240-clip-the-whole-outcomes-reply.md`.
5. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`, `bun run check-contract`, `bun test plugins/music`, and `bun test plugins/mcp plugins/music plugins/warbandeer plugins/wow packages scripts`; the tracker suite's #232 `EBUSY` set is the Windows baseline and CI is the arbiter for it. Paste the counts.
6. Mutations from the table, each in a scratch worktree of your clone, never in the tree under test; name the red test per row in the PR.
7. Review gate: you plus two read-only reviewers with different lenses (A: correctness and failure modes -- `clip`'s arithmetic at exactly 2000 and 2001 characters, a lead that is itself near the limit, a lead containing a newline, every caller of `formatOutcomes` and of `clip`, and whether any other reply in `commands.ts` composes text around an already-clipped part (`grep clip(` and `MAX_REPLY_LENGTH`); B: claims-vs-code over this plan, the CHANGELOG and the JSDoc, walking every coverage row and deriving mutation survivors). 2-of-3 on the major points; every evidenced finding fixed or declined in writing; a fix with behaviour re-runs the round; four rounds at most, then message the orchestrator.
8. PR `fix(music): clip the whole add and skip replies to Discord's limit, lead line included (#240)`, body per `/work-on` plus the pasted checks, the mutation rows and the gate's rounds; `Closes #240`. Do not merge: the orchestrator merges.

### Coverage

| Outcome (the issue's Acceptance) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The idle-add announcement is at most 2000 characters and still leads with who queued what | 1, 2 | "an idle add's announcement fits Discord's limit when many members fail" | concatenate the lead onto the clipped outcomes at the add site, as before -- the length assertion |
| The skip reply is at most 2000 characters and still leads with "Skipped to" | 1, 2 | "a skip's reply fits Discord's limit when many members fail" | the same at the skip site -- the length assertion |
| The clip keeps the lead and cuts the tail | 1, 2 | "the whole message, lead included, fits Discord's limit" | clip the body first and then prepend the lead -- the length assertion; drop the lead from the clipped text -- the `startsWith` assertion |
| A message that fits is untouched | 1, 2 | "a message that fits is untouched"; "without a lead it reads as before" | always cut to `limit - 3` and append `...` -- the equality assertions |

Run each mutation in a scratch worktree, never in the tree under test; name the red test per row in the PR.
