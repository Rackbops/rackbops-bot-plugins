/** Longest user-typed or upstream string echoed back into a reply (#200 wow-7). */
export const ECHO_LIMIT = 200;

/** `s` cut to at most `max` characters, ending in an ellipsis when something was cut. */
export function clip(s: string, max: number = ECHO_LIMIT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
