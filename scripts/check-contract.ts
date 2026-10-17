// Verifies packages/api/contract.d.ts is byte-identical to rackbops-discord-bot's
// src/plugins/contract.ts @ main. The host<->plugin contract lives there; this repo
// vendors it verbatim (per that file's own header) so plugins type-check against it
// without a cross-repo import. A mismatch here means the vendored copy has drifted.
const UPSTREAM_URL =
  "https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/src/plugins/contract.ts";
// A hung connection to raw.githubusercontent.com would otherwise sit until the CI job's own timeout.
const FETCH_TIMEOUT_MS = 30_000;
const VENDORED_PATH = new URL("../packages/api/contract.d.ts", import.meta.url);

const [upstream, vendored] = await Promise.all([
  fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then((res) => {
      if (!res.ok) throw new Error(`fetch ${UPSTREAM_URL}: ${res.status} ${res.statusText}`);
      return res.text();
    })
    .catch((err) => {
      // Name the URL and cause so an unreachable upstream is never mistaken for real drift.
      if (err instanceof Error && err.name === "TimeoutError") throw new Error(`fetch ${UPSTREAM_URL}: timed out after ${FETCH_TIMEOUT_MS} ms`);
      throw err;
    }),
  Bun.file(VENDORED_PATH).text(),
]);

if (upstream !== vendored) {
  console.error(
    "packages/api/contract.d.ts has drifted from rackbops-discord-bot's src/plugins/contract.ts @ main.\n" +
      "Re-vendor: fetch the upstream file and overwrite packages/api/contract.d.ts verbatim.",
  );
  process.exit(1);
}

console.log("packages/api/contract.d.ts matches upstream.");
