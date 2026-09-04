// Verifies packages/api/contract.d.ts is byte-identical to rackbops-discord-bot's
// src/plugins/contract.ts @ main. The host<->plugin contract lives there; this repo
// vendors it verbatim (per that file's own header) so plugins type-check against it
// without a cross-repo import. A mismatch here means the vendored copy has drifted.
const UPSTREAM_URL =
  "https://raw.githubusercontent.com/Rackbops/rackbops-discord-bot/main/src/plugins/contract.ts";
const VENDORED_PATH = new URL("../packages/api/contract.d.ts", import.meta.url);

const [upstream, vendored] = await Promise.all([
  fetch(UPSTREAM_URL).then((res) => {
    if (!res.ok) throw new Error(`fetch ${UPSTREAM_URL}: ${res.status} ${res.statusText}`);
    return res.text();
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
