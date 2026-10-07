/**
 * The link to our usr (Rackbops/usr), Rod's "Wire it" of 2026-10-07: people stay in the
 * tracker's store, and each is linked to a usr account by usr's opaque user id (`users.usr_subject`,
 * schema 9). This file holds the settings and the two bot calls usr offers
 * (usr `docs/discord-registration.md`); the commands and the web sign-in that use them come later.
 * Every usr path is off while `TRACKER_USR_URL` is unset, and the tracker behaves as before.
 *
 * usr has no lookup by Discord id, only by its own `sub` (usr `src/server/routes/roles.ts`), so the
 * tracker learns a person's `sub` from `/api/discord/allow`'s `user_id` and keeps it: the "allow"
 * policy only, never "open", whose registration tells the bot nothing.
 */

export const USR_ENV = {
  url: "TRACKER_USR_URL",
  key: "TRACKER_USR_KEY",
  app: "TRACKER_USR_APP",
} as const;

export const USR_URL_FORMAT = "^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$";
/** usr's app names are free strings; the tracker keeps to the shape its roles are written in (`<app>:<role>`). */
export const USR_APP_FORMAT = "^[a-z0-9]+(-[a-z0-9]+)*$";
const APP = new RegExp(USR_APP_FORMAT);
export const DEFAULT_USR_APP = "tracker";
export const USR_TIMEOUT_MS = 10_000;
const SNOWFLAKE = /^[0-9]{17,20}$/;

export interface UsrConfig {
  /** usr's origin, no path. */
  url: string;
  /** Clerk's usr API key (`usr:discord` and `usr:service`). Never logged. */
  key: string;
  /**
   * The usr app the tracker's roles live under, `tracker` unless set. usr itself takes the app from
   * the key's Discord service row (`PUT /api/discord/services/<keyId>`), so the two must match.
   */
  app: string;
}

function value(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The usr link's settings: `null` while `TRACKER_USR_URL` is unset (off). A URL without a key, a
 * key or app without a URL, or a malformed value refuses to load, naming the setting, never its value.
 */
export function parseUsrConfig(env: Readonly<Record<string, string | undefined>>): UsrConfig | null {
  const url = value(env, USR_ENV.url);
  const key = value(env, USR_ENV.key);
  const app = value(env, USR_ENV.app);
  if (url === undefined) {
    if (key !== undefined || app !== undefined) throw new Error(`${USR_ENV.key} and ${USR_ENV.app} need ${USR_ENV.url}: set it, or unset them`);
    return null;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  // Never echoed: a URL with credentials in it would put them in the log.
  if (url.includes("@") || (parsed && (parsed.username !== "" || parsed.password !== ""))) {
    throw new Error(`${USR_ENV.url} must not contain credentials: give the bare origin, and the key in ${USR_ENV.key}`);
  }
  if (!new RegExp(USR_URL_FORMAT).test(url) || !parsed || parsed.protocol !== "https:") {
    throw new Error(`${USR_ENV.url} is not an https origin such as https://id.example.com (no path, query or credentials)`);
  }
  if (key === undefined) throw new Error(`${USR_ENV.url} is set but ${USR_ENV.key} is not: the usr link needs both`);
  if (/\s/.test(key)) throw new Error(`${USR_ENV.key} has whitespace in it`);
  if (app !== undefined && !APP.test(app)) {
    throw new Error(`${USR_ENV.app}: "${app}" is not a usr app name (lowercase words joined by "-", e.g. tracker)`);
  }
  return { url: parsed.origin, key, app: app ?? DEFAULT_USR_APP };
}

/** usr refused or could not be reached; `message` is safe to show an admin (no key, no body). */
export class UsrError extends Error {
  constructor(
    message: string,
    /** The HTTP status usr answered with, or `null` when it was not reached. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UsrError";
  }
}

export interface AllowRequest {
  /** The person being allowed. */
  discordId: string;
  /** The server the command ran in (usr requires one). */
  guildId: string;
  /** The admin running `/allow`: usr checks they are linked and hold `<app>:register` and every role granted. */
  invokerDiscordId: string;
  /** Unprefixed role names under the tracker's app, e.g. `["member"]`. */
  roles: readonly string[];
  displayName?: string;
}

export interface AllowResult {
  /** usr's opaque user id: the person's `usr_subject`. */
  userId: string;
  /** Whether usr made a new (not yet registered) account for them. */
  created: boolean;
  /** The roles they now hold, prefixed (`tracker:member`). */
  roles: string[];
}

export interface RegisterLink {
  url: string;
  expiresAt: string;
}

export interface UsrClient {
  allow(req: AllowRequest): Promise<AllowResult>;
  /** The person's one-time usr registration link, or `null` when they are already registered there (409). */
  registerLink(req: { discordId: string; guildId: string; displayName?: string }): Promise<RegisterLink | null>;
}

export interface UsrClientOptions {
  config: UsrConfig;
  /** Test seam; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The reason usr gave, kept short and printable, for an admin to read; never the request. */
function reason(body: unknown): string {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof e !== "string") return "";
  const text = e.replace(/[^\x20-\x7e]/g, "").slice(0, 200).trim();
  return text ? `: ${text}` : "";
}

export function createUsrClient(o: UsrClientOptions): UsrClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? USR_TIMEOUT_MS;

  async function post(path: string, body: unknown, ok409 = false): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${o.config.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.config.key}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timed out" : "could not be reached";
      throw new UsrError(`usr ${why}`, null);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const status = res.status;
    if (status === 401) throw new UsrError(`usr refused the tracker's key (HTTP 401): check ${USR_ENV.key}`, status);
    if (status >= 300 && status < 400) throw new UsrError(`usr answered with a redirect (HTTP ${status}), as an edge login does`, status);
    if (status === 409 && ok409) return { status, body: parsed };
    if (status < 200 || status >= 300) throw new UsrError(`usr answered HTTP ${status}${reason(parsed)}`, status);
    return { status, body: parsed };
  }

  function snowflake(name: string, id: string): void {
    if (!SNOWFLAKE.test(id)) throw new UsrError(`${name} is not a Discord id`, null);
  }

  return {
    async allow(req) {
      snowflake("the person", req.discordId);
      snowflake("the server", req.guildId);
      snowflake("the admin", req.invokerDiscordId);
      const { body } = await post("/api/discord/allow", {
        discord_user_id: req.discordId,
        guild_id: req.guildId,
        invoker_discord_user_id: req.invokerDiscordId,
        roles: [...req.roles],
        ...(req.displayName ? { display_name: req.displayName } : {}),
      });
      const b = (body ?? {}) as { user_id?: unknown; created?: unknown; roles?: unknown };
      if (typeof b.user_id !== "string" || b.user_id === "" || typeof b.created !== "boolean" || !Array.isArray(b.roles) || !b.roles.every((r) => typeof r === "string")) {
        throw new UsrError(`usr's answer to allow was not one the tracker could read: is ${USR_ENV.url} usr?`, 200);
      }
      return { userId: b.user_id, created: b.created, roles: b.roles as string[] };
    },

    async registerLink(req) {
      snowflake("the person", req.discordId);
      snowflake("the server", req.guildId);
      const { status, body } = await post(
        "/api/discord/register-link",
        { discord_user_id: req.discordId, guild_id: req.guildId, policy: "allow", ...(req.displayName ? { display_name: req.displayName } : {}) },
        true,
      );
      if (status === 409) return null;
      const b = (body ?? {}) as { url?: unknown; expires_at?: unknown };
      if (typeof b.url !== "string" || typeof b.expires_at !== "string") {
        throw new UsrError(`usr's answer to register-link was not one the tracker could read: is ${USR_ENV.url} usr?`, status);
      }
      let link: URL;
      try {
        link = new URL(b.url);
      } catch {
        throw new UsrError("usr's registration link is not a URL", status);
      }
      // Only ever hand a person an https link: usr builds it from its own USR_PUBLIC_URL.
      if (link.protocol !== "https:") throw new UsrError("usr's registration link is not https: check usr's USR_PUBLIC_URL", status);
      return { url: link.href, expiresAt: b.expires_at };
    },
  };
}
