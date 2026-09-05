# rackbops-bot-plugins -- Claude Instructions

Plugins for [`Rackbops/rackbops-discord-bot`](https://github.com/Rackbops/rackbops-discord-bot),
published as npm bundles plus a Plugin Index (`plugins.json`) any bot instance fetches. This repo
is **not** the bot itself and ships no runtime -- it is CI-published content the bot's image build
fetches at build time.

My personal `~/.claude/CLAUDE.md` governs *how I work* -- the review gate, escalation, git &
shipping, commit mechanics, search-tool routing, and shell choice. It is **not restated here**;
this file covers only what is specific to this repo.

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
| `plugins.json` | `scripts/generate-index.ts`, from `plugins/*/package.json` + `CHANGELOG.md` | Never hand-edit. Regenerate and commit. `publish.yml` also writes it, automatically, after a real publish. |
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
**review gate** in personal.

- **Typecheck** -- `bun run check`.
- **Unit tests** -- `bun test`.
- **Index freshness** -- `bun run generate-index -- --check`; must be re-run (without `--check`)
  and the result committed whenever a plugin's `package.json`/`CHANGELOG.md` changes.
- **Contract drift** -- `bun run check-contract`; needs network access to
  `rackbops-discord-bot`'s live `main` and fails if that repo is unreachable, not just on a real
  mismatch -- distinguish the two before treating a failure as drift.

**A green local check is not proof a plugin behaves correctly inside the bot.** Only running the
real bot against a real Discord instance proves that -- see `rackbops-discord-bot`'s own
verification discipline.

**CI runs both jobs (`checks`, `test`) on every PR and on push to `main`.**

---

## Code style

Follows personal's **Code style** baseline. This repo's individuality:

- **Bun + TypeScript, strict.** `tsconfig.json`'s `strict`, `noUnusedLocals`,
  `noUnusedParameters` are all on. No transpile step for `scripts/` -- bun runs `.ts` directly;
  `tsc --noEmit` is typecheck-only.
- **No linter configured.** `/audit`'s Justfile standard wants a `lint` recipe; this repo
  deliberately has none yet -- see the Tooling issue tracking the runbook/`/audit` reconciliation
  this scaffold surfaced. Don't add an unwired `eslint.config.js` just to satisfy that check.
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
- **Branch protection on `main` is off, on purpose.** Mirrors `rackbops-discord-bot`'s own
  "Phase 2, after CI has been green on a few real merges" plan (`rackbops-discord-bot#84`) -- see
  the twin issue filed in this repo for when/how to turn it on.
