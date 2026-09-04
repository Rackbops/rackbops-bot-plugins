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
- **`scripts/generate-index.ts` throws if `plugins/` is non-empty.** It only implements the
  empty-envelope case; see `CLAUDE.md`'s Key gotchas for why, and don't work around the throw
  without first building the real per-plugin extraction it's guarding.
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

- **npm scope for published packages (`@rackbops/plugin-<name>`)** -- probe: check whether the
  `@rackbops` npm org exists yet (`npm view @rackbops/<any-package>`) before the first real
  publish; not yet live as of 2026-09-04 (`rackbops-ui-ux-std-lib`, the other repo expected to
  use this scope, hadn't published under it either as of that date).
- **When to turn on branch protection** -- probe: has `checks` been green on "a few" real merges
  yet? See the twin of `rackbops-discord-bot#84` filed in this repo's issues.
