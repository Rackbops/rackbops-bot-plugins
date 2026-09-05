# Plugins

One directory per plugin: `<name>/package.json` (with a `botPlugin` block), `src/`,
`CHANGELOG.md`, tests. See the repo's [`README.md`](../README.md) for the manifest contract and
the plugin-authoring guide.

Empty for now. `scripts/generate-index.ts` extracts each plugin here into `plugins.json`; add a
plugin by following the authoring guide in the root README, then tag `<name>-v<semver>` to publish.
