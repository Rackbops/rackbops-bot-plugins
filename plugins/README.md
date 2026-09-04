# Plugins

One directory per plugin: `<name>/package.json` (with a `botPlugin` block), `src/`,
`CHANGELOG.md`, tests. See the repo's [`README.md`](../README.md) for the manifest contract.

Empty for now. `scripts/generate-index.ts` deliberately refuses to run against a non-empty
`plugins/` until the real per-plugin extraction logic (CHANGELOG parsing, validation) exists
-- see this repo's open issues for that work.
