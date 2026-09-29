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
 *   way), its `<meta>` tags (at most `MAX_METAS`, each at most `MAX_TAG` long), then its text with
 *   every tag removed, so no `<` is left in it for a tag pattern to start from, and an owner's
 *   `near` words still meet the price after them.
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
  const text: string[] = [];
  let at = 0;
  while (at < body.length) {
    const lt = body.indexOf("<", at);
    if (lt < 0) {
      text.push(body.slice(at));
      break;
    }
    text.push(body.slice(at, lt));
    const gt = body.indexOf(">", lt);
    if (gt < 0) break; // an unclosed tag: nothing after it can be a tag or text worth reading
    const tag = body.slice(lt, gt + 1);
    const tagLower = lower.slice(lt, gt + 1);
    at = gt + 1;
    if (tagLower.startsWith("<script")) {
      const end = lower.indexOf("</script", at);
      const content = body.slice(at, end < 0 ? body.length : end);
      if (/type\s*=\s*["']?application\/ld\+json/.test(tagLower.slice(0, MAX_TAG)) && blocks.length < MAX_BLOCKS) {
        blocks.push(`<script type="application/ld+json">${escapeLt(content)}</script>`);
      }
      if (end < 0) break;
      const close = body.indexOf(">", end);
      at = close < 0 ? body.length : close + 1;
    } else if (tagLower.startsWith("<style")) {
      const end = lower.indexOf("</style", at);
      if (end < 0) break;
      const close = body.indexOf(">", end);
      at = close < 0 ? body.length : close + 1;
    } else if (tagLower.startsWith("<meta") && tag.length <= MAX_TAG && metas.length < MAX_METAS && !tag.slice(1).includes("<")) {
      metas.push(tag);
    }
    text.push(" ");
  }
  return [...blocks, ...metas, text.join("")].join("\n");
}
