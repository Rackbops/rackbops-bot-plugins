# rackbops-bot-plugins -- verified-facts ledger

The running record of what has actually been confirmed about this repo's toolchain and its one
external dependency (the host<->plugin contract vendored from `rackbops-discord-bot`). See **The
CONTEXT.md Ledger** discipline in `CLAUDE.md`. A fact is paid for once, written down in the same
change that used it, and read from here before going back to the source.

---

## Sources

- **`rackbops-discord-bot`'s `src/plugins/contract.ts` @ `main`** -- the host<->plugin contract.
  This repo vendors it verbatim into `packages/api/contract.d.ts`; `scripts/check-contract.ts`
  re-fetches the upstream file on every CI run and fails on any diff. Last verified identical:
  2026-09-04 (initial scaffold commit).
- **`rackbops-discord-bot`'s `README.md:82`** -- "the daemon fetches the build context itself,
  with no credentials" -- the reason this repo is public (verified 2026-09-04).

Where the vendored copy and the live upstream disagree, upstream wins -- `check-contract` exists
precisely to make that disagreement loud instead of silent.

---

## Environment

No machine-specific paths. `bun@1.3.14` is pinned via `package.json`'s `packageManager` field;
`oven-sh/setup-bun@v2` in CI reads that same field (`bun-version-file: package.json`), so the
pin only needs to change in one place.

---

## Toolchain gotchas

- **`packages/api/contract.d.ts` is type-only, despite containing a real value export.** See
  `CLAUDE.md`'s Key gotchas -- `.d.ts` files never emit JS, so `HOST_API_VERSION`'s value has no
  runtime existence in this repo. Only `import type` from this file; a runtime `import` will
  fail to resolve when actually executed (Bun/Node look for a `.ts`/`.js` twin that doesn't
  exist).
- **`bun run check` means typecheck only, not lint+typecheck.** Matches
  `rackbops-discord-bot`'s own `package.json` convention (`"check": "bunx tsc --noEmit"|
  exactly). This repo has no separate `lint` script.
- **`scripts/check-contract.ts` needs network access.** It fetches
  `raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/src/plugins/contract.ts` live --
  a CI failure here can mean either real drift or a transient network/GitHub outage; check which
  before assuming the contract actually changed.
- **`scripts/generate-index.ts` extracts every `plugins/<name>` into `plugins.json`.** It builds
  each `PluginIndexEntry` from `package.json`'s `botPlugin` block + `CHANGELOG.md` (Keep-a-Changelog
  `## [x.y.z] - YYYY-MM-DD`, newest first, capped at 10), and **fails** on a bad plugin name, a
  missing `hostApiVersion`, a current version with no CHANGELOG section, or a command name declared
  by two plugins. `buildIndex`/`parseChangelogReleases`/`sameIgnoringGeneratedAt` are exported and
  pure over an injected dir, so the extraction is unit-tested without a subprocess
  (`scripts/generate-index.test.ts`); the CLI (`--check` / write) is a thin `import.meta.main`
  wrapper. `generatedAt` is excluded from the `--check` diff.
- **Relative imports need a `.js` extension** (`tsconfig.json`'s `moduleResolution: NodeNext`).
  Import the vendored contract as `../packages/api/contract.js` (type-only) -- it resolves to
  `contract.d.ts`, and Bun resolves the `.js` specifier to the `.ts`/`.d.ts` source at runtime.
  Omitting the extension fails `bun run check` with TS2835.
- **Every plugin's `package.json` MUST declare `repository` (url + monorepo `directory`).** OIDC
  trusted publishing auto-signs an npm provenance statement, and the registry **rejects** the publish
  with `E422 ... "repository.url" is "", expected to match ...` when it's absent. Verified 2026-09-04
  by the throwaway `hello` pipeline test (its `0.0.1` publish was rejected for exactly this; `0.0.2`
  with `repository` succeeded). The authoring guide's template includes it.
- **Publishing is OIDC trusted publishing via `npm publish`, not a token** (verified 2026-09-04
  against npm docs). npm revoked classic tokens (2025-12-09) and retired bypass-2FA CI tokens
  (2026-07-31), so there is no `NPM_TOKEN`; `publish.yml` authenticates with GitHub Actions OIDC
  (`id-token: write` + `actions/setup-node` + npm >= 11.5.1). `bun publish` does **not** support
  OIDC ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)), which is why the publish
  step is `npm publish` while install/test/build stay Bun. A Trusted Publisher must be configured
  per package on npmjs.com, and npm requires the package to exist first -- bootstrap a new package
  with a one-time local placeholder `npm publish` + 2FA OTP, then CI/OIDC owns every real version.
- **CI job names (`checks`, `test`) intentionally split lint/typecheck-shaped work from tests**,
  matching `/audit`'s "at least two jobs" requirement -- `rackbops-discord-bot`'s own `ci.yml`
  uses a single `checks` job and doesn't split this way; don't use that file as a reference for
  job structure, only for its action-version pins (`actions/checkout@v7`, `oven-sh/setup-bun@v2`).
- **`rackbops-discord-bot`'s own `ci.yml` triggers on `pull_request` only, not push to `main`.**
  This repo's `ci.yml` triggers on both, deliberately diverging from that file to match the
  documented `/audit` CI-workflow standard instead. If you're ever tempted to "match the bot
  repo" for a CI/repo-settings question, check the bot repo's *actual* file first -- several of
  its own settings (this trigger shape, its justfile's shape and content, its PURPOSE.md's
  completeness, having no branch protection, having no LICENSE) don't fully satisfy `/audit`
  either, so it isn't a reliable reference for what the standard requires.

---

## Open questions

- **npm scope for published packages (`@rackbops/plugin-<name>`)** -- RESOLVED 2026-09-04: the
  `rackbops` npm org exists (created 2026-09-04, account `rshelton`), so the scope is `@rackbops`.
  Authentication is OIDC trusted publishing (see the publishing gotcha above), not a scope token.
- **When to turn on branch protection** -- probe: has `checks` been green on "a few" real merges
  yet? See the twin of `rackbops-discord-bot#84` filed in this repo's issues.
