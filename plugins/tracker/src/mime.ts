/**
 * A small, bounded reader for the mail the alert route takes in (mail.ts; tracker 0.24.0): an
 * RFC 5322 message as bytes, to its sender's address, its subject and its HTML and plain-text
 * bodies. It is not a mail library -- it reads what eBay's saved-search alerts and Gmail's
 * forwarding confirmation are, and leaves anything else unread:
 *
 * - headers unfolded, the first of each name kept, RFC 2047 encoded words (`=?UTF-8?Q?...?=`, B and
 *   Q) decoded in the subject;
 * - a single part, or `multipart/*` at most `MAX_DEPTH` deep, the first `text/html` and the first
 *   `text/plain` taken (attachments, `Content-Disposition: attachment`, skipped);
 * - `quoted-printable`, `base64`, `7bit`, `8bit` and `binary`; any charset `TextDecoder` knows, with
 *   UTF-8 for one it does not.
 *
 * Pure: bytes in, strings out, nothing read or written. Malformed input gives a message with less in
 * it, never a throw.
 */

/** How deep `multipart` may nest before the rest is left unread. */
export const MAX_DEPTH = 5;

export interface MailMessage {
  /** The `From` header's address, lower-cased, or null when there is none to read. */
  from: string | null;
  /** The `Subject` header, decoded and with runs of white space made one space; "" when absent. */
  subject: string;
  html: string | null;
  text: string | null;
}

/** Bytes as a string of one char per byte, so structure can be found without decoding the bodies. */
function binary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset?.trim() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Splits a part into its header block and its body, at the first blank line. */
function split(part: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(part);
  if (!m) return { head: part, body: "" };
  return { head: part.slice(0, m.index), body: part.slice(m.index + m[0].length) };
}

/** Header names (lower-cased) to their first value, unfolded. */
function headers(head: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(colon + 1).trim());
  }
  return out;
}

/** A header's value and its `; key=value` parameters (keys lower-cased, quotes taken off). */
function params(value: string | undefined): { value: string; params: Map<string, string> } {
  const [first = "", ...rest] = (value ?? "").split(";");
  const out = new Map<string, string>();
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    out.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1"));
  }
  return { value: first.trim().toLowerCase(), params: out };
}

function quotedPrintable(body: string): Uint8Array {
  const s = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  return bytesOf(s);
}

function base64(body: string): Uint8Array {
  try {
    return Uint8Array.from(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
  } catch {
    return new Uint8Array();
  }
}

function bodyBytes(body: string, encoding: string | undefined): Uint8Array {
  const e = (encoding ?? "").trim().toLowerCase();
  if (e === "quoted-printable") return quotedPrintable(body);
  if (e === "base64") return base64(body);
  return bytesOf(body);
}

/** RFC 2047 encoded words in a header value; adjacent words separated only by white space join. */
export function decodeWords(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1");
  return joined.replace(word, (_all, charset: string, kind: string, text: string) => {
    const bytes = kind.toUpperCase() === "B" ? base64(text) : quotedPrintable(text.replace(/_/g, " "));
    return decodeCharset(bytes, charset.split("*")[0]);
  });
}

/** The address in a `From` value: the one in angle brackets, else the bare one. */
function address(value: string | undefined): string | null {
  if (!value) return null;
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const bare = angled ? angled[1] : /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(value)?.[1];
  return bare ? bare.toLowerCase() : null;
}

/** The first text/html and text/plain bodies under `part`, depth-first. */
function bodies(part: string, depth: number, found: { html: string | null; text: string | null }): void {
  const { head, body } = split(part);
  const h = headers(head);
  const type = params(h.get("content-type") ?? "text/plain");
  if (params(h.get("content-disposition")).value === "attachment") return;
  if (type.value.startsWith("multipart/")) {
    const boundary = type.params.get("boundary");
    if (!boundary || depth >= MAX_DEPTH) return;
    const marker = `--${boundary}`;
    const pieces = body.split(marker);
    // pieces[0] is the preamble; one starting "--" is the end marker and what follows it.
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      // The line break before a boundary belongs to the boundary, not to the part.
      bodies(piece.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n$/, ""), depth + 1, found);
      if (found.html !== null && found.text !== null) return;
    }
    return;
  }
  if (type.value !== "text/html" && type.value !== "text/plain") return;
  const decoded = decodeCharset(bodyBytes(body, h.get("content-transfer-encoding")), type.params.get("charset"));
  if (type.value === "text/html" && found.html === null) found.html = decoded;
  if (type.value === "text/plain" && found.text === null) found.text = decoded;
}

/** Reads `raw` (the message as it came off the wire). */
export function parseMail(raw: Uint8Array): MailMessage {
  const all = binary(raw);
  const h = headers(split(all).head);
  const found: { html: string | null; text: string | null } = { html: null, text: null };
  bodies(all, 0, found);
  // A subject's bytes past ASCII are taken as UTF-8, as mail sent unencoded nearly always is.
  const subject = decodeWords(decodeCharset(bytesOf(h.get("subject") ?? ""), "utf-8")).replace(/\s+/g, " ").trim();
  return { from: address(h.get("from")), subject, html: found.html, text: found.text };
}
