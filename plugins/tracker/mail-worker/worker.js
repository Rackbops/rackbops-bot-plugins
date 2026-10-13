// Clerk's Email Worker (tracker 0.25.0, plugins/tracker/src/mail.ts): Cloudflare Email Routing
// hands it every message sent to the alert domain, and it posts each one, as it came, to the
// tracker's `POST /tracker/mail/inbound`. It reads nothing in the message and keeps nothing.
//
// Deploy it by pasting this file into the Cloudflare dashboard's editor for a Worker (it is not in
// the plugin's npm bundle). Its only export is the default handler: the Workers runtime takes every
// named export of the main module for an entrypoint and refuses to start on one that is not.
//
// Settings on the Worker (Settings -> Variables and Secrets):
//   CLERK_URL             variable: the tracker's https origin, e.g. https://clerk.example.com
//   CLERK_MAIL_KEY        secret: the same value as the tracker's TRACKER_MAIL_KEY
//   ACCESS_CLIENT_ID      secret: the Cloudflare Access service token's client id
//   ACCESS_CLIENT_SECRET  secret: and its client secret
//
// A message the tracker does not take is refused back to the sender with a permanent error: for
// forwarded mail, the person's own mailbox gets the bounce, so nothing is lost without anyone
// hearing of it. The sender does not retry; eBay sends its next alert as usual.

/** The biggest message posted: the tracker's own limit (web/mail-inbound.ts). */
const MAX_MAIL_BYTES = 1024 * 1024;

/** Why a message was refused, by the tracker's status. */
function refusal(status) {
  if (status === 404) return "No such address";
  if (status === 413) return "Message too large";
  return `Clerk could not take this message (status ${status})`;
}

export default {
  // On the handler object, never as named exports, so the tests can read them (see above).
  MAX_MAIL_BYTES,
  refusal,

  async email(message, env) {
    if (message.rawSize > MAX_MAIL_BYTES) {
      message.setReject("Message too large");
      return;
    }
    const body = await new Response(message.raw).arrayBuffer();
    const origin = String(env.CLERK_URL ?? "").replace(/\/+$/, "");
    let res;
    try {
      res = await fetch(`${origin}/tracker/mail/inbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLERK_MAIL_KEY}`,
          "CF-Access-Client-Id": String(env.ACCESS_CLIENT_ID ?? ""),
          "CF-Access-Client-Secret": String(env.ACCESS_CLIENT_SECRET ?? ""),
          "Content-Type": "message/rfc822",
          "X-Envelope-To": message.to,
        },
        body,
        redirect: "manual",
      });
    } catch {
      message.setReject("Clerk could not be reached");
      return;
    }
    if (res.status !== 200) message.setReject(refusal(res.status));
  },
};
