// Fails when a package@version that plugins.json advertises is missing on npm. plugins.json is
// committed in the PR that bumps a plugin, but npm only has the version once the `<name>-v<semver>`
// tag is pushed and publish.yml has run, so for that window the index runs ahead of the registry
// (a fresh bot instance that resolves entry.version then skips the plugin, rackbops-bot-plugins#135).
// This runs on a schedule (.github/workflows/published-check.yml), never on a PR: a bump PR is
// supposed to fail it until its tag is pushed. A registry that cannot be reached is reported as
// such and is NOT the same as a missing version.
import { fileURLToPath } from "node:url";
import type { PluginIndex } from "../packages/api/contract.js";

const REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 15_000;

export type PublishState = "published" | "missing" | "unreachable";

export interface PublishCheck {
  name: string;
  package: string;
  version: string;
  state: PublishState;
  detail?: string;
}

/** The registry URL for one version of a package: `@scope/name` -> `@scope%2fname`, then `/<version>`. */
export function registryUrl(pkg: string, version: string, registry: string = REGISTRY): string {
  return `${registry}/${pkg.replace("/", "%2f")}/${encodeURIComponent(version)}`;
}

/** 200 -> published, 404 -> missing (a package never published at all is a 404 too, and the first release's tag fixes that the same way), anything else (5xx, 429, a thrown fetch) -> unreachable. */
export async function checkPublished(
  index: PluginIndex,
  fetchImpl: typeof fetch = fetch,
  registry: string = REGISTRY,
): Promise<PublishCheck[]> {
  return Promise.all(
    index.plugins.map(async (p): Promise<PublishCheck> => {
      const base = { name: p.name, package: p.package, version: p.version };
      try {
        const res = await fetchImpl(registryUrl(p.package, p.version, registry), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status === 200) return { ...base, state: "published" };
        if (res.status === 404) return { ...base, state: "missing" };
        return { ...base, state: "unreachable", detail: `registry answered ${res.status}` };
      } catch (err) {
        return { ...base, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

/** Exit code and the lines to print: 1 if any version is missing, 2 if none is missing but the registry could not be read, else 0. */
export function summarise(results: PublishCheck[]): { code: 0 | 1 | 2; lines: string[] } {
  const lines = results.map((r) => {
    const tag = `${r.package}@${r.version}`;
    if (r.state === "published") return `ok       ${tag}`;
    if (r.state === "missing") return `MISSING  ${tag} -- plugins.json advertises it but npm does not have it; push the tag ${r.name}-v${r.version} (publish.yml publishes it)`;
    return `UNKNOWN  ${tag} -- could not read the registry (${r.detail ?? "no detail"}); this is not a missing version`;
  });
  if (results.some((r) => r.state === "missing")) return { code: 1, lines };
  if (results.some((r) => r.state === "unreachable")) return { code: 2, lines };
  return { code: 0, lines };
}

if (import.meta.main) {
  const indexPath = fileURLToPath(new URL("../plugins.json", import.meta.url));
  const index = JSON.parse(await Bun.file(indexPath).text()) as PluginIndex;
  const { code, lines } = summarise(await checkPublished(index));
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  if (code === 0) console.log("every plugins.json version is on npm.");
  process.exit(code);
}
