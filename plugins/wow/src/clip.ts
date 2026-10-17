/** Longest user-typed or upstream string echoed back into a reply (#200 wow-7). */
export const ECHO_LIMIT = 200;

/** Longest item name or slot type echoed in a /transmog reply: a reply lists up to 13 of them, so the
 *  limit is tighter than ECHO_LIMIT to keep the whole reply under Discord's 2000 characters. */
export const ITEM_NAME_LIMIT = 60;

/** `s` cut to at most `max` characters, ending in an ellipsis when something was cut. */
export function clip(s: string, max: number = ECHO_LIMIT): string {
  if (s.length <= max) return s;
  let end = max - 1;
  // Do not leave half of a surrogate pair (an emoji) before the ellipsis.
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}
