# #129 -- the register and pair replies name the invoked command

Standalone XS. Behaviour change (reply text): the three-reviewer gate applies.

## Plan (execute as written)

Written by the orchestrating session on 2026-10-08 against `main` of this repository (`plugins/mcp` at 0.3.0). The implementer re-reads every cite on the tree it works from and corrects any that moved; a verbatim copy of this plan goes into the PR as `docs/plans/129-agent-reply-prefix.md`, the way `docs/plans/92-show-date.md` does.

Standalone XS. Behaviour change (two reply strings): the three-reviewer gate applies, lightweight -- one round with two read-only reviewers is expected to be enough.

### Decisions

- **Use the invoked command's own name, never a hardcoded `/agent`.** The host registers every plugin command under the instance's `COMMAND_PREFIX` (rackbops-discord-bot `src/commandNaming.ts:13`, `src/plugins/host.ts` `buildCommandBody`), and `interaction.commandName` on a `ChatInputCommandInteraction` is that registered, already-prefixed name -- `agent` on prod, `ragent` on debug, `pipagent` on Pip. The Host API exposes no prefix to plugins (rackbops-discord-bot `src/plugins/contract.ts` has none), and it does not need to: the interaction carries the truth.
- **Both strings that name a subcommand change**, not just the one reported: `plugins/mcp/src/commands.ts:25` (`Run \`/agent pair\``) and `:31` (`Run \`register\` first.`, which names the subcommand without the command). The pair-success text (`:36-37`) names `discord-mcp pair`, a CLI command, not a slash command: unchanged. `index.ts:11` is a doc comment describing the command generically: unchanged.
- **One helper, so the shape is tested once:** `function subcommandRef(interaction, sub: string): string` returning `` `/${interaction.commandName} ${sub}` `` (with the backticks the replies already use), in `commands.ts`, not exported.
- **Release as a patch, 0.3.1, in this PR**, because the fix is only useful once an instance can install it (the bot installs published versions from the index; Pip runs `mcp@0.3.0`). The tag that publishes is the orchestrator's step after the merge, not the implementer's.

### Steps

1. `plugins/mcp/src/commands.ts`
   - Add `subcommandRef` as above, next to `replyEphemeral` (`:10-12`).
   - `:25` becomes `` await replyEphemeral(interaction, `Registered. Run ${subcommandRef(interaction, "pair")} to generate a pairing code for your agent.`); ``
   - `:31` becomes `` await replyEphemeral(interaction, `Run ${subcommandRef(interaction, "register")} first.`); ``
   - One sentence in the module's header comment (`:1-5`): reply texts name the command the user actually invoked, because the host prefixes it per instance.
2. `plugins/mcp/src/commands.test.ts`
   - `fakeInteraction` (`:8-18`) gains a `commandName` parameter, default `"agent"`, placed on the fake (`commandName,` beside `user`).
   - `:62`: the expected string stays `` "Registered. Run `/agent pair` ..." `` for the default fake (an unprefixed instance still reads exactly as before).
   - New test in `describe("agentCommand: register")`: `names the invoked command, so a prefixed instance reads /pipagent pair` -- `fakeInteraction("register", "Ash", "ash123", "pipagent")` -> reply content equals `` "Registered. Run `/pipagent pair` to generate a pairing code for your agent." ``.
   - New test in `describe("agentCommand: pair")` beside the existing not-registered case: `the not-registered refusal names the invoked command` -- `pair` with `store.pair` returning `{ ok: false }` and `commandName "ragent"` -> `` "Run `/ragent register` first." ``; and pin the unprefixed form in the existing test if it is not already asserted verbatim (read it; `:79-` onward).
3. Release plumbing, same PR
   - `plugins/mcp/package.json`: `"version": "0.3.1"`.
   - `plugins/mcp/CHANGELOG.md`: a `## [0.3.1] - 2026-10-08` section above `[0.3.0]`, `### Fixed`: "The `/agent register` reply and the not-registered `pair` refusal name the command the user actually invoked (`/<prefix>agent ...`) instead of a hardcoded `/agent`, so a prefixed instance is told the right command (Rackbops/rackbops-bot-plugins#129, found on rackbops-discord-bot's `pip` instance)." `publish.yml` greps the CHANGELOG for exactly `## [0.3.1]` (`.github/workflows/publish.yml:38-39`).
   - `bun run generate-index` and commit the regenerated `plugins.json` (`README.md:26`: never hand-edit; CI's `generate-index -- --check` gate enforces sync).
   - `plugins/mcp/README.md`: where it names `/agent register|pair|unregister`, one sentence that the host prefixes the command per instance (`/<prefix>agent`), so the examples read `/agent` only on an unprefixed bot.
4. Checks: `bun run check`, `bun run lint`, `bun test`, `bun run generate-index -- --check`, all from the repo root; paste the test count.
5. Gate: you plus two read-only reviewers (A: correctness -- is `commandName` always the prefixed registered name for a chat-input interaction, including in a DM; is any other reply string affected; B: claims-vs-code over this plan and the CHANGELOG text). Fix or decline every evidenced finding in writing. Mutation rows: see the table.
6. PR title `fix(mcp): name the invoked command in the register and pair replies (#129)`, body with the pasted checks, the mutation rows, the gate's round(s), and the note that the orchestrator tags `mcp-v0.3.1` after the merge (`publish.yml:3-5` publishes on the tag; `:30-31` verifies it matches the package version). Do not merge, do not tag.

### Coverage

| Acceptance bullet (#129) | Step | Test | Mutation that must fail it |
|---|---|---|---|
| The register reply names the invoked command | 1 | the new prefixed register test | hardcode `/agent` back at `:25` |
| The not-registered pair refusal names the invoked command | 1 | the new prefixed pair test | hardcode `register` back at `:31` |
| An unprefixed instance reads exactly as before | 1 | `:62` unchanged, plus the pinned unprefixed pair refusal | prefix the helper's output with anything |
| Released as a patch and the index updated | 3 | `generate-index -- --check` in CI; `publish.yml:30-39` on the tag | leave `plugins.json` stale |

Run each mutation in a scratch copy (`git worktree add --detach`), never in the tree under test; name the red test per row in the PR.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: Rackbops/rackbops-bot-plugins (local checkout S:\Repos\rackbops-bot-plugins is stale -- fetch origin and work in a fresh worktree from origin/main, branch fix/129-agent-reply-prefix). Issue: #129; the plan is its `## Plan` comment; copy it verbatim into docs/plans/129-agent-reply-prefix.md in the PR.
Behaviour change: run your own three-reviewer gate (two read-only reviewers, different lenses), lightweight; mutation checks in a scratch worktree. Scratch files: task-unique names (pr-body-129.md, commit-msg-129.txt). Report the PR link, the pasted checks, the gate's round(s) and any deviation. Do not merge, do not tag.
```

