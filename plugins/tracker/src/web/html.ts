import { STYLESHEET_PATH } from "./theme.js";

/**
 * The web area's HTML primitives (rackbops-bot-plugins#80): escaping, the page frame, and the
 * headers every answer carries. Server-rendered, forms only, no script: the Content-Security-Policy
 * allows the one stylesheet and forms posting back to this origin, and nothing else.
 */

/** Escapes text for an element's content or a double-quoted attribute. Every value goes through it. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Markup already escaped: what `html` interpolates as-is. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | null | undefined | false | readonly Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return "";
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  return esc(part);
}

/** A template tag that escapes every interpolated value unless it is already `Html`. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

export const CSP = "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Headers on every page: personal content, so never cached or referred; never framed or sniffed. */
export function pageHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

export interface Frame {
  /** The plugin's path prefix, `/tracker`. */
  base: string;
  title: string;
  /** Present when signed in: the nav and the sign-out form. */
  signedIn?: { name: string; csrf: string };
  body: Html;
}

export function page(f: Frame): string {
  const nav = f.signedIn
    ? html`<nav aria-label="Tracker">
<span class="rb-muted">${f.signedIn.name}</span>
<a class="rb-link" href="${f.base}/">My tasks</a>
<a class="rb-link" href="${f.base}/settings">Settings</a>
<form method="post" action="${f.base}/logout"><input type="hidden" name="csrf" value="${f.signedIn.csrf}"><button class="rb-btn rb-btn--ghost rb-btn--sm" type="submit">Sign out</button></form>
</nav>`
    : null;
  return html`<!doctype html>
<html lang="en" data-rb-style="rackbops-noir">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${f.title} -- Tracker</title>
<link rel="stylesheet" href="${f.base}${STYLESHEET_PATH}">
</head>
<body>
<header class="tr-top"><span class="rb-wordmark">Tracker<span class="rb-wordmark__spark">.</span></span>${nav}</header>
<main class="tr-main">
${f.body}
</main>
</body>
</html>
`.value;
}

export function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: pageHeaders(extra) });
}

/** A 303 to a path on this origin (never absolute: the Host header is the client's to choose). */
export function redirect(location: string, cookies: readonly string[] = []): Response {
  const h = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers: h });
}

/** The value of cookie `name` in the request, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** A cookie scoped to the plugin's path (every plugin shares one origin), never readable by script. */
export function cookie(name: string, value: string, o: { base: string; maxAgeSeconds: number; sameSite: "Lax" | "Strict" }): string {
  return `${name}=${value}; Path=${o.base}/; Max-Age=${o.maxAgeSeconds}; HttpOnly; Secure; SameSite=${o.sameSite}`;
}
