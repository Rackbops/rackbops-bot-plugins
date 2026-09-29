import noir from "@rackbops/styles/rackbops-noir/bundle" with { type: "text" };
import { sha256 } from "./secrets.js";

/**
 * The web area's one stylesheet (rackbops-bot-plugins#80): `@rackbops/styles`' rackbops-noir theme
 * (dark, system font stacks, no webfonts), flattened by that package into one `bundle.css` and
 * bundled into `dist/plugin.js` as text by bun's text import, so the bot installs nothing and
 * fetches nothing. The pages set `data-rb-style="rackbops-noir"` on `<html>` and use the `rb-*`
 * classes; the few `tr-*` rules below are page layout only, on the theme's `--rb-*` tokens.
 *
 * Served at a path carrying the CSS's hash, cached for a year: a new theme version is a new path.
 * `style-src 'self'` then covers it, and no page needs an inline style.
 */

// The package's types describe its CSS as a side-effect-only module; a `type: "text"` import is
// the file's contents as a string (bun's loader), which TypeScript cannot see through.
const THEME_CSS = noir as unknown as string;

const LAYOUT_CSS = `
/* tracker web area layout (not part of the theme) */
.tr-top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--rb-space-3); padding: var(--rb-space-3) var(--rb-space-4); border-bottom: 1px solid var(--rb-border); }
.tr-top nav { display: flex; flex-wrap: wrap; align-items: center; gap: var(--rb-space-2); margin-left: auto; }
.tr-top form { margin: 0; }
.tr-main { max-width: 60rem; margin: 0 auto; padding: var(--rb-space-4); }
.tr-main > section { margin-bottom: var(--rb-space-5); }
.tr-stack { display: grid; gap: var(--rb-space-3); max-width: 28rem; }
.tr-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--rb-space-2); }
.tr-row form { margin: 0; }
.tr-foot { margin-top: var(--rb-space-5); }
`;

export const STYLESHEET = `${THEME_CSS}\n${LAYOUT_CSS}`;
export const STYLESHEET_PATH = `/assets/theme.${sha256(STYLESHEET).slice(0, 16)}.css`;
