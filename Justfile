# rackbops-bot-plugins -- plugins for rackbops-discord-bot, plus the Plugin Index
# Requires: just, bun (the version in package.json's packageManager)
# CI runs these recipes (.github/workflows/ci.yml), so a check fails there exactly when it fails here.

default:
    @just --list

# Install dependencies from the committed lockfile
install:
    bun install --frozen-lockfile

# Everything CI runs, in order
check: lint typecheck test build index-check contract-check

# Lint (Biome, lint only; the formatter is off). Shows errors only; `bunx biome lint .` shows warnings too
lint:
    bun run lint

# Type-check every workspace
typecheck:
    bun run check

# Run every test
test:
    bun test

# Build each plugin's dist/plugin.js
build:
    bun run build

# Fail if plugins.json is out of step with plugins/*/package.json and CHANGELOG.md
index-check:
    bun run generate-index -- --check

# Regenerate plugins.json (commit the result)
index:
    bun run generate-index

# Fail if packages/api/contract.d.ts has drifted from rackbops-discord-bot's contract.ts (needs network)
contract-check:
    bun run check-contract
