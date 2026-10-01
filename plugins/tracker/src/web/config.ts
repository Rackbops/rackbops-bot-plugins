/**
 * `TRACKER_WEB_URL` (rackbops-bot-plugins#80): the https origin the web area is reached at through
 * the instance's tunnel, e.g. `https://clerk.example.com`. The one place a link or an allowed
 * `Origin` comes from: never the request's `Host` header (the host contract, `http`). Unset means
 * no web area: `/web` says so and every page answers 404.
 */

/** The manifest's `format` (a POSIX ERE, bash's dialect): an https origin, an optional trailing slash. */
export const WEB_URL_FORMAT = "^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$";

/** The origin (`https://host[:port]`), or null when unset; throws, naming the problem, on anything else. */
export function parseWebUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  // The value is never echoed: one with credentials in it would put them in the log.
  if (value.includes("@")) throw new Error("TRACKER_WEB_URL must not contain credentials: give the bare https origin");
  if (!new RegExp(WEB_URL_FORMAT).test(value)) {
    throw new Error("TRACKER_WEB_URL is not an https origin such as https://clerk.example.com (no path, query or credentials)");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TRACKER_WEB_URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("TRACKER_WEB_URL must be a bare https origin");
  }
  return url.origin;
}
