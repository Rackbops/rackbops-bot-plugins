// Verifies scripts/core-commands.ts lists exactly the core command names in rackbops-discord-bot's
// src/commands.ts @ main (Epic #269 decision 3, #136). A mismatch means the bot added, renamed or removed a
// core command: update CORE_COMMAND_NAMES to match. Needs network access, like check-contract.
import { CORE_COMMAND_NAMES, parseCoreCommandNames } from "./core-commands.js";

const UPSTREAM_URL = "https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/src/commands.ts";
const FETCH_TIMEOUT_MS = 30_000;

const upstream = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  .then((res) => {
    if (!res.ok) throw new Error(`fetch ${UPSTREAM_URL}: ${res.status} ${res.statusText}`);
    return res.text();
  })
  .catch((err) => {
    // Name the URL and cause so an unreachable upstream is never mistaken for real drift.
    if (err instanceof Error && err.name === "TimeoutError") throw new Error(`fetch ${UPSTREAM_URL}: timed out after ${FETCH_TIMEOUT_MS} ms`);
    throw err;
  });

const theirs = parseCoreCommandNames(upstream).sort();
const ours = [...CORE_COMMAND_NAMES].sort();
if (theirs.join(",") !== ours.join(",")) {
  console.error(
    `scripts/core-commands.ts has drifted from rackbops-discord-bot's CORE_COMMANDS @ main.\n  bot:  ${theirs.join(", ")}\n  here: ${ours.join(", ")}\nUpdate CORE_COMMAND_NAMES to the bot's list.`,
  );
  process.exit(1);
}

console.log(`scripts/core-commands.ts matches the bot's core commands (${ours.join(", ")}).`);
