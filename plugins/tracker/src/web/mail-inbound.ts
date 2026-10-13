import type { TrackerDeps } from "../actions.js";
import type { Queue } from "../discord-common.js";
import { deliverMail, type MailConfig } from "../mail.js";
import { parseMail } from "../mime.js";
import { safeEqual } from "./secrets.js";

/**
 * `POST /<plugin>/mail/inbound` (tracker 0.25.0): where the Email Worker (`mail-worker/`) posts each
 * message Cloudflare Email Routing receives for `TRACKER_MAIL_DOMAIN` (mail.ts).
 *
 * - `Authorization: Bearer <TRACKER_MAIL_KEY>`, compared in constant time; anything else is a 401.
 * - `X-Envelope-To`: the address the message was sent to. One that is no one's is a 404, which the
 *   Worker turns into a bounce, so a mistyped forwarding address fails where it was typed.
 * - The body is the message as it came (`message/rfc822`), at most `MAX_MAIL_BYTES`; a bigger one
 *   is a 413 and is never read (eBay's alert was about 140 KB).
 *
 * The answer is JSON, `{"result": ...}`: `stored` (with `watches` and `listings`), `confirmation`,
 * `unmatched` or `ignored`, all 200: the Worker has nothing to retry once a message is here. The
 * route is off (404) while `TRACKER_MAIL_*` is unset. Nothing from the message is ever logged.
 */

export const MAX_MAIL_BYTES = 1024 * 1024;
export const MAIL_PATH = "/mail/inbound";

function answer(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

/** The body's bytes, or null past `max` (read no further than that). */
async function readBytes(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(/^[0-9]{1,12}$/.test(declared) && Number(declared) <= max)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

export interface MailInbound {
  config: MailConfig | null;
  deps(): TrackerDeps | null;
  queue: Queue;
}

export async function handleMailInbound(m: MailInbound, request: Request): Promise<Response> {
  if (m.config === null) return answer(404, { error: "not_found" });
  if (request.method !== "POST") return answer(405, { error: "method_not_allowed" }, { Allow: "POST" });
  const auth = request.headers.get("authorization") ?? "";
  const sent = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeEqual(sent, m.config.key)) return answer(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  const d = m.deps();
  if (!d?.mail) return answer(503, { error: "starting" }, { "Retry-After": "60" });
  const mail = d.mail;
  const raw = await readBytes(request, MAX_MAIL_BYTES);
  if (raw === null) return answer(413, { error: "too_large" });
  const to = request.headers.get("x-envelope-to") ?? "";
  return m.queue(async () => {
    const userId = mail.userOf(to);
    if (userId === null) return answer(404, { error: "no_such_address" });
    const outcome = await deliverMail(d, userId, parseMail(raw));
    if (outcome.kind === "stored") d.log.info(`mail: an eBay alert gave ${outcome.listings} listing(s) to ${outcome.watches} watch(es)`);
    else if (outcome.kind === "ignored") d.log.info(`mail: one message ignored (${outcome.why})`);
    else d.log.info(`mail: one message ${outcome.kind}`);
    if (outcome.kind === "ignored") return answer(200, { result: "ignored" });
    const { kind, ...rest } = outcome;
    return answer(200, { result: kind, ...rest });
  });
}
