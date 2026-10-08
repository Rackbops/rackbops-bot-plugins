# rackbops-bot-plugins -- Agent Instructions

Plugins for [`Rackbops/rackbops-discord-bot`](https://github.com/Rackbops/rackbops-discord-bot),
published as npm bundles plus a Plugin Index (`plugins.json`) any bot instance fetches. This repo
is **not** the bot itself and ships no runtime -- it is CI-published content the bot's image build
fetches at build time.

My personal global instructions govern *how I work* -- the review gate, escalation, git &
shipping, commit mechanics, search-tool routing, and shell choice. Claude Code loads them from
`~/.claude/CLAUDE.md`; Codex from `~/.codex/AGENTS.md`. They are **not restated here**; this file
covers only what is specific to this repo.

**Commit convention (intended -- no history yet to confirm scopes against):** Conventional
Commits `type(scope): subject`, matching every other Rackbops repo. Revisit this line once real
commits accumulate; match `git log`, not this guess, if they disagree.

---

## Ground truth: where facts come from

The shipped `plugins/*/package.json` + `CHANGELOG.md` files are the source for `plugins.json` --
cite by file and line. `packages/api/contract.d.ts` is a vendored **snapshot** of
`rackbops-discord-bot`'s `src/plugins/contract.ts` @ `main`, verified verbatim-identical by
`scripts/check-contract.ts` (network-dependent, runs in CI on every PR/push). Treat it as current
unless `check-contract` fails; when it does, re-vendor rather than hand-edit the drifted copy.

---

## Generated vs authored

| File / dir | Produced by | Rule |
|---|---|---|
| `plugins.json` | `scripts/generate-index.ts`, from `plugins/*/package.json` + `CHANGELOG.md` | Never hand-edit. Regenerate and commit it in the PR that changes a plugin; CI's `generate-index -- --check` gate enforces sync. `publish.yml` only verifies it (via `--check`), never writes it. |
| `packages/api/contract.d.ts` | Vendored from `rackbops-discord-bot`'s `src/plugins/contract.ts` | Never hand-edit. Re-fetch upstream and overwrite verbatim; `scripts/check-contract.ts` verifies the match. |
| `plugins/*/dist/plugin.js` | `scripts/build-plugins.ts` (`bun build`) | Never hand-edit. Gitignored -- not committed, rebuilt by CI/publish. |

Both generated top-level files (`plugins.json`, `contract.d.ts`) are **committed**, for consumers
that read them without running this repo's tooling (the bot's image build reads `plugins.json`
directly; a plugin's own build imports types from `contract.d.ts`).

---

## Irreversible: what downstream consumers resolve by

- **A plugin's `name`** (in its `botPlugin` block) is the `PLUGINS=` token bot operators set, the
  log-line prefix, and the `data/plugins/<name>` directory on the bot's host. Renaming one after
  it ships silently orphans a deployed bot's existing config and stored data.
- **A plugin's npm package name** (`@rackbops/plugin-<name>`) and its **command names** are
  resolved by the bot from `plugins.json` at install time. Renaming or removing either breaks any
  bot instance still pinned to a version that used the old name.
- **`plugins.json`'s `schemaVersion` and `PluginIndexEntry` shape** are read by every bot instance
  that fetches this index. A breaking shape change needs a version bump the bot's parser
  understands -- not a silent field rename.
- If a task appears to require changing any of these, **stop and raise it** -- see personal's
  **Escalation**.

---

## Testing & checks

Run these **before staging** (and again after a rebase). They do not substitute for the
**review gate** in personal. `just check` runs all of them, one after another (CI runs them as
parallel jobs); each line below is
also its own recipe (`just --list`).

- **Lint** -- `just lint` (Biome, lint only; the formatter stays off -- hand-formatted).
- **Typecheck** -- `bun run check` (`just typecheck`).
- **Unit tests** -- `bun test`.
- **Index freshness** -- `bun run generate-index -- --check`; must be re-run (without `--check`)
  and the result committed whenever a plugin's `package.json`/`CHANGELOG.md` changes.
- **Contract drift** -- `bun run check-contract`; needs network access to
  `rackbops-discord-bot`'s live `main` and fails if that repo is unreachable, not just on a real
  mismatch -- distinguish the two before treating a failure as drift.

**A green local check is not proof a plugin behaves correctly inside the bot.** Only running the
real bot against a real Discord instance proves that -- see `rackbops-discord-bot`'s own
verification discipline.

**CI (`ci.yml`) runs three jobs -- `lint` (lint + typecheck), `test`, and `checks` (build, index,
contract) -- on every PR and on push to `main`, each through the Justfile recipes above;
`pr-guidelines.yml`'s `pr-title` job checks every PR title is a Conventional Commit.** This
follows [Project Operations 1.0.0](https://lepid-labs.github.io/spec/project-operations/v1.0.0/)
(Lepid Labs, CC BY 4.0) sections 3, 5 and 6, with one known gap: section 5.12 wants a monorepo's
tests as a `test-package` matrix per plugin, and `test` still runs one root `bun test`. `lint`,
`test` and `pr-title` are the check names its ruleset requires.

---

## Code style

Follows personal's **Code style** baseline. This repo's individuality:

- **Bun + TypeScript, strict.** `tsconfig.json`'s `strict`, `noUnusedLocals`,
  `noUnusedParameters` are all on. No transpile step for `scripts/` -- bun runs `.ts` directly;
  `tsc --noEmit` is typecheck-only.
- **Biome lints; nothing formats.** `biome.jsonc` runs Biome's recommended preset with the
  formatter off; only errors fail (`just lint` prints only those). Four rules that existing plugin
  code breaks as errors are lowered to `warn`, so the gate arrived without touching any plugin;
  each plugin's owner may clean its own up and raise them back. Most of the ~360 warnings are
  rules that are warnings by default anyway (`noNonNullAssertion` alone is 320). `noControlCharactersInRegex` is off: the sanitizers that trip
  it strip control characters on purpose.
- **No runtime dependencies at the root.** `discord.js` and `typescript`/`@types/bun` are
  `devDependencies` only (types, not runtime behavior) -- keep it that way; a plugin's own
  `package.json` carries its real runtime deps.

---

## Key gotchas

- **`packages/api/contract.d.ts` is type-only.** It is a straight copy of upstream's
  `contract.ts`, including its one real value export (`HOST_API_VERSION`) -- but `.d.ts` files
  never emit JavaScript, so that export has no runtime existence here. Only ever consume this
  file via `import type`. Code that needs the actual `HOST_API_VERSION` *value* at runtime needs
  a different source (a local literal, or `plugins.json`'s own `hostApiVersion` field) -- not an
  `import` from this file.
- **`scripts/generate-index.ts` extracts every `plugins/<name>` into `plugins.json`** (from each
  `package.json` `botPlugin` block + `CHANGELOG.md`) and fails on a bad name, a missing
  `hostApiVersion`, a current version with no CHANGELOG section, or a duplicate command name across
  plugins. See `CONTEXT.md` for the extractor's shape and the OIDC publishing path.
- **`main` is governed by a repository ruleset** (Project Operations section 4, set 2026-10-04):
  no deletion or force push; a PR with one approving code-owner review (`.github/CODEOWNERS`),
  stale approvals dismissed, conversations resolved; squash only; `lint`, `test` and `pr-title`
  required, branch up to date. Classic branch protection was removed, so the ruleset is the one
  source of truth; `checks` is not required. Every Claude PR is opened as roshne's account, which
  cannot approve its own PR, so merges go through the repository-admin bypass. The ruleset is a
  GitHub setting, roshne's to change.
