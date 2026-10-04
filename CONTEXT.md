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
  2026-09-09 (re-vendored for `rackbops-discord-bot#184`'s optional `Plugin.dispose?()`, a
  compatible addition -- `check-contract` confirmed the match against upstream `main` @ `2dd4d10`).
- **`rackbops-discord-bot`'s `README.md:82`** -- "the daemon fetches the build context itself,
  with no credentials" -- the reason this repo is public (verified 2026-09-04).

Where the vendored copy and the live upstream disagree, upstream wins -- `check-contract` exists
precisely to make that disagreement loud instead of silent.

---

## Environment

No machine-specific paths. `bun` is pinned (the exact version) via `package.json`'s `packageManager` field;
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
  exactly). Lint is separate: `just lint` (Biome).
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
- **`packages/api/admin.ts` is the admin-UI contract -- a SEPARATE module from `contract.d.ts`.** It
  is browser/DOM-typed (`/// <reference lib="dom" />`) and carries `AdminApi`, `MountAdmin`, and a
  **runtime** `ADMIN_API_VERSION` const -- so, unlike the type-only `contract.d.ts`, it can be
  runtime-imported. Kept separate precisely so `contract.d.ts` stays single-const + DOM-free (read at
  boot before the Client exists). A plugin opts into an admin tab by declaring
  `botPlugin.adminApiVersion`; `generate-index` then emits that version plus a **derived** `adminUrl`
  (`https://cdn.jsdelivr.net/npm/<pkg>@<version>/dist/admin.js`), and `build-plugins` bundles
  `src/admin/index.ts` -> `dist/admin.js` (`--target browser`, no discord.js). Design + panel side:
  the epic [rackbops-discord-bot#123](https://github.com/Rackbops/rackbops-discord-bot/issues/123).
- **`packages/testkit/index.ts` is the shared test-only module** -- `makeRealStorage` (a faithful copy
  of the host's storage primitives, so the concurrency tests are meaningful), `makeFakeHost({ name })`
  (name required; `dataDir` defaults to `/tmp/<name>-fake-datadir`; on its own it still has none of
  `post`/`dm`/`edit`/`destinations` -- the pre-#736 degraded path), `makeFakeDelivery()` (#736: those
  four as recorders -- `post`/`dm` return a fixed `HostDelivery`, `edit` resolves nothing, `destinations`
  answers `[]` -- spread into `makeFakeHost`'s overrides; its own `calls` property isn't part of
  `HostApi`'s type, so read it straight off the object `makeFakeDelivery()` itself returned, not off
  the host -- the spread DOES copy it onto the host value too, it is just invisible to typed access
  there), and `makeFakeInteraction`. It replaced a per-plugin `src/test-host.ts` copy in each
  plugin (#34). Imported only by `*.test.ts`
  (`../../../packages/testkit/index.js` from a plugin's `src/`); it is never published and never
  bundled -- `build-plugins` bundles `src/index.ts` only, and `files: ["dist"]` keeps `src/` out of
  the tarball -- so it touches no shipped artifact and no plugin version.
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
- **A plugin may use `node:fs` directly for what `HostStorage` doesn't cover.** `HostStorage`
  (`contract.d.ts`) only reads/writes one JSON value per path; it has no directory-listing or delete
  primitive. `plugins/mcp` (#742) lists and prunes its per-request delivery-state files with
  `node:fs/promises`' `readdir`/`unlink` directly, alongside `host.storage` for the actual read/write
  -- a plugin is a declared-dependency boundary, not a sandbox (contract.ts's own `HostApi` doc
  comment), so this is expected, not a workaround.
- **The root is a Bun workspace (`"workspaces": ["plugins/*"]`), on the hoisted linker (`bunfig.toml`).**
  Added for `plugins/tracker` (#78), the first plugin with runtime dependencies of its own
  (`@rackbops/docket-core`/`-types`, as devDependencies): the workspace is what makes one root `bun install
  --frozen-lockfile` (CI, publish) install them, and `bun build` then bundles them into
  `dist/plugin.js`. Bun defaults a workspace to its **isolated** linker, which hides transitive
  packages from the root -- `bun-types`, which `tsconfig.json`'s `"types"` names, disappeared and
  `bun run check` failed with TS2688 -- so `bunfig.toml` pins `linker = "hoisted"`, the layout the
  repo had before. A plugin's libraries are bundle inputs only, so they are `devDependencies`: the bot fetches the
  tarball and loads `dist/plugin.js` without an install, so everything but `discord.js` is bundled
  (verified 2026-09-29: the workspace still installs a plugin's devDependencies, and docket's code
  is inside `plugins/tracker/dist/plugin.js`).
- **`bun:` builtins stay external in a bundle.** `bun build --target bun` leaves
  `import { Database } from "bun:sqlite"` as an import (verified 2026-09-29 on the built
  `plugins/tracker/dist/plugin.js`, then loaded and run under Bun), so a plugin can use
  `bun:sqlite` -- the bot runs on Bun. Not a native dependency: nothing is compiled or shipped.
- **`@rackbops/docket-core` 0.3.0 leaves two things to its host** (read in its `dist/dispatch.js`,
  2026-09-29, for `plugins/tracker` #79): `Lanes.tickNotify` runs every queued due occurrence
  whatever its task's status, so a paused task still fires; and `runOne` fails the whole run when
  one recipient's send throws. The tracker's notify lane therefore hands docket a view of its
  store (`laneStore`, `notify-lane.ts`) that drops a non-active task's due runs, and pauses every
  task that would DM a person whose delivery paused (`delivery-health.ts`), as plan 5.5 asks. docket's `registrationText` still wraps a usr link the tracker no
  longer has (plan item 40), so `/register` builds its own text around `ADMIN_DISCLOSURE`.
- **`@rackbops/docket-core` 0.3.0's Store port has no delete of a person or a task, and no list of
  people or of blocks** (read in its `dist/ports.d.ts`, 2026-09-30, for `plugins/tracker` #80 slice
  3): only `deleteQueuedOccurrences`, `removeRecipient` and per-pair `listBlocks`. So the tracker's
  admin view and forget-me run plain SQL over the plugin's own database (`plugins/tracker/src/roster.ts`),
  as `admissions.ts` and `delivery-health.ts` already do; docket is not changed.
- **`TRACKER_GUILD_ID`'s server-membership gate is an addition beyond the plan.** Plan 5.5's
  "membership gate" is the admission list alone, with a Discord-role check left unknown; checking
  membership of one configured server came with #79's brief, not the plan of record; a list of
  servers (a member of any one passes) came with #106. Not verified live against Discord (below).
- **A plugin checks guild membership through `interaction.client`, not the Host API**, which has no
  member lookup (`plugins/tracker/src/discord.ts` `lookupMembership`): `guilds.fetch(id)` then
  `members.fetch({ user })`, a REST call that needs no privileged intent; Discord's 10007 (unknown
  member) and 10013 (unknown user) mean "not a member". Unit-tested against a fake client only; not
  yet run against real Discord (inferred from discord.js v14's API, not verified live).
- **The host hands a plugin's `http` every method, not only GET and POST** (read in
  rackbops-discord-bot `src/plugins/host.ts`, 2026-09-30, for `plugins/tracker` #80 slice 4): the
  buffered `Request` is rebuilt with `method: request.method`, so `PATCH`, `DELETE` and `OPTIONS`
  reach the plugin, which answers its own `405`s. The tracker's JSON task API relies on it.
- **Every `host.dm` already goes out with no allowed mentions, and the Host API has no per-message
  switch for it** (read in rackbops-discord-bot `src/plugins/hostMessage.ts:43,310` and
  `src/client.ts:10` at `12832f0`, 2026-10-01, for `plugins/tracker` #82): `HostMessage` is
  `content`/`card`/`links`/`buttons` only, and the host builds every `dm`/`post`/`edit` payload with
  `allowedMentions: { parse: [] }`, over a Client whose default is the same. So docket 0.5.0's
  "send research DMs with `allowed_mentions: { parse: [] }`" holds for the tracker with no change to
  the contract. Read in the source only; not verified against live Discord.
- **docket 0.5.0's execute lane runs Jobs one at a time across every task** (read in its
  `dist/dispatch.js` `tickExecute`/`dueExecute`, 2026-10-01, for `plugins/tracker` #82): each tick
  first asks about every run whose Job is out and submits nothing new while one is. So the tracker's
  execute tick is one `tickExecute` over every task with a due execute-lane run, holding all their
  locks (`execute-lane.ts`), not one pass per task like the notify lane -- a per-task view would hide
  another task's Job out. `tickExecute` takes no abort signal. **`Lanes` keeps the usage-limit
  pause in memory (`executeAfter`)**, so the host must keep one `Lanes` for the execute lane
  across ticks: one made per tick forgets the pause and submits a fresh Job under a new key every
  minute through a spent window (review of #110; `execute-lane.ts` `ExecuteLane`).
- **SQLite's AUTOINCREMENT spends a number on an `INSERT ... ON CONFLICT DO NOTHING` that inserts
  nothing** (seen 2026-10-01 in `plugins/tracker`'s store tests under Bun's SQLite): a refused keyed
  finding or a follow-up's refused dedupe leaves a gap, so ids are unique and increasing but not
  contiguous. Never compute an id by counting rows.
- **CI job names (`lint`, `test`, `checks`) follow Project Operations 1.0.0 section 5**: `lint` runs
  `just lint` then `just typecheck`, `test` runs `just test`, and `checks` (build, index freshness,
  contract drift) is extra and not a required check. Jobs call Justfile recipes, never re-implement
  them. `rackbops-discord-bot`'s own `ci.yml` uses a single `checks` job; don't use that file as a
  reference for job structure, only for its action-version pins (`actions/checkout@v7`,
  `oven-sh/setup-bun@v2`).
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
- **Branch protection** -- RESOLVED 2026-10-04: the Project Operations ruleset (requiring `lint`,
  `test`, `pr-title` and a code-owner review) governs `main`, and the classic protection was removed.
