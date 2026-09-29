/**
 * The page the price type is handed, rebuilt in linear time from what a shop sent
 * (rackbops-bot-plugins#81). docket-types' `extractPrice` runs regular expressions of the shape
 * `<meta[^>]*...>` and `<script[^>]*...>` over the whole body; on a page with thousands of `<meta `
 * and no `>` they take quadratic time (a 96 KB page measured 5.7 s), and a regular expression
 * cannot be interrupted, so one hostile or broken page would stop the bot's only thread. What the
 * extractor needs is small, so the body is reduced to it, with no scan that can backtrack:
 *
 * - a JSON body (it parses) is kept as JSON, every `<` escaped as `<` (same value);
 * - otherwise: the page's JSON-LD blocks (at most `MAX_BLOCKS`, each `<` inside escaped the same
 *   way), its `<meta>` tags (at most `MAX_METAS`, each at most `MAX_TAG` long), then the whole
 *   page with every `<` blanked: no tag pattern has anywhere to start in it, and an owner's `near`
 *   words still find a price in the text, an attribute or a script's data.
 */

export const MAX_BLOCKS = 20;
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

/** The body reduced to what price extraction reads; see the file's comment. */
export function pageForExtraction(body: string): string {
  const json = jsonBody(body);
  if (json !== null) return json;
  const lower = body.toLowerCase();
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
