/**
 * The page the price type and the want-list's `page` source are handed, rebuilt in linear time
 * from what a shop sent (rackbops-bot-plugins#81). docket-types' `extractPrice` runs regular
 * expressions of the shape `<meta[^>]*...>` and `<script[^>]*...>` over the whole body; on a page
 * with thousands of `<meta ` and no `>` they take quadratic time (a 96 KB page measured 5.7 s), and
 * a regular expression cannot be interrupted, so one hostile or broken page would stop the bot's
 * only thread. What the extractor needs is small, so the body is reduced to it, with no scan that
 * can backtrack:
 *
 * - a JSON body (it parses) is kept as JSON, every `<` escaped as `\u003c` (same value);
 * - otherwise: the page's first `MAX_BLOCKS` JSON-LD blocks (each `<` inside escaped the same
 *   way), its first `MAX_METAS` `<meta>` tags (each at most `MAX_TAG` long), both in page order,
 *   then the whole page with every `<` blanked: no tag pattern has anywhere to start in it, and an
 *   owner's `near` words still find a price in the text, an attribute or a script's data.
 *
 * `MAX_BLOCKS` bounds the `JSON.parse` calls docket's extractor and the want-list's `page` source
 * make on one page, with room for a shop search page that carries one JSON-LD `Product` per card
 * beside its other blocks (rackbops-bot-plugins#208): docket-types' `page` source keeps at most 100
 * listings a page (`MAX_LISTINGS`), and a look takes at most 20 new ones (`MAX_NEW_PER_RUN`), the
 * rest on the next look. The slow scans #81 guards against are over unclosed tags, not over how
 * many well-formed blocks are kept, and a read is at most 3 MB (fetch.ts).
 */

export const MAX_BLOCKS = 200;
export const MAX_METAS = 300;
export const MAX_TAG = 1000;

const escapeLt = (s: string) => s.replaceAll("<", "\\u003c");

function jsonBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return escapeLt(JSON.stringify(JSON.parse(trimmed)));
  } catch {
    return null;
  }
}

/**
 * `s` with only `A`-`Z` lower-cased, so every offset in the result is the same place in `s`
 * (rackbops-bot-plugins#163). `toLowerCase` is not length-preserving: `"İ"` (U+0130) becomes two
 * code units, and after one each place in the lowered text sits one further on than in the page.
 * A tag found in the page and read in the lowered text then starts one character early (on the
 * character before its `<`), so it is not seen as a `<meta>` or `<script>` and is dropped; and a
 * `</script` found in the lowered text ends the page's block one character late, keeping the `<`
 * of `</script`, so the block's JSON no longer parses. Tag names, attribute names and
 * `application/ld+json` are ASCII, so this fold loses nothing the walk looks for.
 */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** The body reduced to what price extraction reads; see the file's comment. */
export function pageForExtraction(body: string): string {
  const json = jsonBody(body);
  if (json !== null) return json;
  // Same length as `body`: an offset found in either one slices the other at the same place.
  const lower = asciiLower(body);
  const blocks: string[] = [];
  const metas: string[] = [];
  // Where each closing tag next occurs at or after the walk: searched again only once the walk has
  // passed it, so a page of many unclosed `<script>`s does not rescan to its end for each one.
  const closes = new Map<string, number>();
  const nextClose = (closing: string, from: number): number => {
    const known = closes.get(closing);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    const found = lower.indexOf(closing, from);
    closes.set(closing, found);
    return found;
  };
  let at = 0;
  while (at < body.length) {
    let lt = body.indexOf("<", at);
    if (lt < 0) break;
    const gt = body.indexOf(">", lt);
    if (gt < 0) break; // no tag closes after this: nothing more to collect
    // A stray `<` in text ("under <30 EUR") is not a tag: the tag is the last `<` before the `>`.
    // Scanning back stops at `lt`, and `at` moves past `gt`, so the whole walk stays linear.
    lt = body.lastIndexOf("<", gt);
    const tag = body.slice(lt, gt + 1);
    const tagLower = lower.slice(lt, gt + 1);
    at = gt + 1;
    if (tagLower.startsWith("<script") || tagLower.startsWith("<style")) {
      const closing = tagLower.startsWith("<script") ? "</script" : "</style";
      const end = nextClose(closing, at);
      if (end < 0) continue; // unclosed: read on as if it were a plain tag
      if (closing === "</script" && blocks.length < MAX_BLOCKS && /type\s*=\s*["']?application\/ld\+json/.test(tagLower.slice(0, MAX_TAG))) {
        blocks.push(`<script type="application/ld+json">${escapeLt(body.slice(at, end))}</script>`);
      }
      at = end;
    } else if (tagLower.startsWith("<meta") && tag.length <= MAX_TAG && metas.length < MAX_METAS) {
      metas.push(tag);
    }
  }
  // The text keeps everything -- script data, attributes, words -- for an owner's `near`, with every
  // `<` blanked, so no tag pattern has anywhere to start in it.
  return [...blocks, ...metas, body.replaceAll("<", " ")].join("\n");
}
