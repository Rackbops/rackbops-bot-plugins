import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@rackbops/docket-core";
import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { Plugin } from "../../../../packages/api/contract.js";
import { makeFakeHost } from "../../../../packages/testkit/index.js";
import type { Membership } from "../access.js";
import type { PageFetchOptions } from "../fetch.js";
import { createPlugin } from "../index.js";
import { HOST_CANNOT_MESSAGE } from "../notifier.js";
import { removeDir } from "../test-dirs.js";
import type { Source } from "@rackbops/docket-types";

/**
 * The web tests' harness (rackbops-bot-plugins#80), shared by web.test.ts and editor.test.ts and
 * imported only by them: a plugin on a fake host with a settable clock and a file database, the
 * slash commands with fake interactions, and requests straight to `plugin.http` with a cookie jar.
 */

export const ADMIN = "111111111111111111";
export const LARRY = "222222222222222222";
export const CURLY = "333333333333333333";
export const STRANGER = "444444444444444444";
export const ORIGIN = "https://clerk.example.com";
export const START = "2026-10-01T12:00:00.000Z";
export const dirs: string[] = [];
/** Every plugin `world()` made, disposed by `cleanup()`. */
const plugins: Plugin[] = [];
/** Each world's clock, by its plugin: the jar's `Max-Age` runs on it. */
const clocks = new WeakMap<Plugin, { now(): Date }>();

/**
 * Each test file's `afterEach`: disposes every plugin `world()` made, closing its database, and
 * only then removes the directories its tests made. Windows refuses to delete a file still open
 * (#232), where Linux does not care, so it is this order that keeps the suite green on Windows. A
 * plugin its test already disposed is disposed again, which does nothing (index.ts nulls its handle
 * on the first). It takes only what was made before the call: a world made while it awaits is left
 * for the next one. `remove` is for the harness's own test (web.test.ts), to see the order.
 */
export async function cleanup(remove: (dir: string) => void = removeDir): Promise<void> {
  const disposing = plugins.splice(0);
  const removing = dirs.splice(0);
  for (const p of disposing) await p.dispose?.();
  for (const d of removing) remove(d);
}

export function clockAt(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s: string) => (now = new Date(s)), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

export const GUILD = "999999999999999999";
/** A second server, for a `TRACKER_GUILD_ID` list. */
export const GUILD_B = "888888888888888888";

export type WebLookup = (discordId: string) => Promise<Membership | null>;

/** `guild`: true sets `TRACKER_GUILD_ID` to `GUILD`; a string is the setting itself. */
export async function world(
  opts: {
    webUrl?: string | null;
    guild?: boolean | string;
    webMembership?: WebLookup;
    fetch?: Fetch;
    logs?: string[];
    /** More settings, e.g. `TRACKER_CITY_HALL_*`. */
    env?: Record<string, string>;
    cityHallFetch?: typeof fetch;
    executeStarted?: (work: Promise<void>) => void;
    /** A BGG source, as if `TRACKER_BGG_TOKEN` were set (docket-types' `bggSource`). */
    bgg?: Source;
    /** The token's BGG reads' name lookup and HTTP, with `TRACKER_BGG_TOKEN` in `env` (index.ts `bggNetwork`). */
    bggNetwork?: Pick<PageFetchOptions, "resolve" | "fetchImpl">;
    /** usr's HTTP, with `TRACKER_USR_*` in `env` (usr.ts, usr-identity.ts). */
    usrFetch?: typeof fetch;
    /** Forget-me's wait for a running tick, in ms (admin.ts `TICK_WAIT_MS` by default). */
    tickWaitMs?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "tracker-web-"));
  dirs.push(dir);
  const dbPath = join(dir, "tracker.sqlite");
  const clock = clockAt(START);
  const webUrl = opts.webUrl === undefined ? ORIGIN : opts.webUrl;
  const sent: { userId: string; message: unknown }[] = [];
  /**
   * Set `refuse` to have the host refuse every DM as undeliverable (Discord's "cannot be messaged");
   * put a Discord id in `unreachable` to refuse only theirs; set `hold` to keep every DM waiting on it (`held` counts the DMs that waited).
   */
  const delivery = { refuse: false, unreachable: new Set<string>(), hold: null as Promise<void> | null, held: 0 };
  const plugin = createPlugin(
    makeFakeHost({
      name: "tracker",
      env: {
        TRACKER_ADMIN_DISCORD_IDS: ADMIN,
        ...(webUrl ? { TRACKER_WEB_URL: webUrl } : {}),
        ...(opts.guild ? { TRACKER_GUILD_ID: typeof opts.guild === "string" ? opts.guild : GUILD } : {}),
        ...(opts.env ?? {}),
      },
      log: opts.logs
        ? {
            info: (m: string) => void opts.logs?.push(m),
            warn: (m: string) => void opts.logs?.push(m),
            error: (m: string, e?: unknown) => void opts.logs?.push(`${m} ${String(e ?? "")}`),
          }
        : { info() {}, warn() {}, error() {} },
      dm: async (userId: string, message: unknown) => {
        if (delivery.hold) {
          delivery.held++;
          await delivery.hold;
        }
        if (delivery.refuse || delivery.unreachable.has(userId)) throw new Error(HOST_CANNOT_MESSAGE);
        sent.push({ userId, message });
        return { guildId: null, channelId: "c", messageId: "m" };
      },
    }),
    {
      clock,
      dbPath,
      // These tests count every DM; the daily digest has its own (digest.test.ts).
      digest: false,
      // The command side's gate: everyone is a member when there is one.
      ...(opts.guild ? { membership: async (): Promise<Membership> => "member" } : {}),
      ...(opts.webMembership ? { webMembership: opts.webMembership } : {}),
      ...(opts.fetch ? { fetch: () => opts.fetch as Fetch } : {}),
      ...(opts.cityHallFetch ? { cityHallFetch: opts.cityHallFetch } : {}),
      ...(opts.executeStarted ? { executeStarted: opts.executeStarted } : {}),
      ...(opts.bgg ? { bgg: opts.bgg } : {}),
      ...(opts.bggNetwork ? { bggNetwork: opts.bggNetwork } : {}),
      ...(opts.usrFetch ? { usrFetch: opts.usrFetch } : {}),
      ...(opts.tickWaitMs !== undefined ? { tickWaitMs: opts.tickWaitMs } : {}),
    },
  );
  plugins.push(plugin);
  clocks.set(plugin, clock);
  await plugin.activate!();
  return { plugin, clock, dbPath, sent, delivery };
}

/** One message a command sent after deferring: the edit of its answer, or a follow-up with its flags and whom it may mention. */
export interface Said {
  kind: "edit" | "followUp";
  content: string;
  flags?: unknown;
  allowedMentions?: unknown;
}

/**
 * Runs a slash command as `userId` and answers its answer's text. `said` collects what it sent after
 * deferring, in order (its answer's edit, then any follow-ups); `followUpFails` makes every follow-up
 * fail with it (an expired interaction).
 */
export async function slash(
  plugin: Plugin,
  name: string,
  userId: string,
  o: { strings?: Record<string, string>; users?: Record<string, string>; client?: unknown; sub?: string; ints?: Record<string, number>; numbers?: Record<string, number>; booleans?: Record<string, boolean>; said?: Said[]; followUpFails?: Error } = {},
): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  let deferred: unknown = null;
  const interaction = {
    commandName: name,
    guildId: null,
    ...(o.client ? { client: o.client } : {}),
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: userId === LARRY ? "Larry" : null, bot: false },
    options: {
      getSubcommand: () => o.sub ?? "",
      getString: (k: string) => o.strings?.[k] ?? null,
      getInteger: (k: string) => o.ints?.[k] ?? null,
      getNumber: (k: string) => o.numbers?.[k] ?? null,
      getBoolean: (k: string) => o.booleans?.[k] ?? null,
      getUser: (k: string) => (o.users?.[k] ? { id: o.users[k], bot: false } : null),
    },
    deferReply: async (x: unknown) => void (deferred = x),
    editReply: async (x: { content: string; flags?: unknown }) => {
      edits.push(x);
      o.said?.push({ kind: "edit", content: x.content, ...(x.flags !== undefined ? { flags: x.flags } : {}) });
    },
    followUp: async (x: { content: string; flags?: unknown; allowedMentions?: unknown }) => {
      if (o.followUpFails) throw o.followUpFails;
      o.said?.push({ kind: "followUp", content: x.content, flags: x.flags, allowedMentions: x.allowedMentions });
    },
  };
  await command.handle(interaction as unknown as ChatInputCommandInteraction);
  expect(deferred).toMatchObject({ flags: 64 });
  return edits[0]?.content ?? "";
}

/** Admin, Larry and Curly all registered. */
export async function people(plugin: Plugin) {
  await slash(plugin, "register", ADMIN);
  for (const id of [LARRY, CURLY]) {
    await slash(plugin, "allow", ADMIN, { users: { user: id } });
    await slash(plugin, "register", id);
  }
}

export type Jar = Map<string, string>;

export interface Call {
  jar?: Jar;
  form?: Record<string, string>;
  origin?: string | null;
  headers?: Record<string, string>;
}

/**
 * What a jar's cookies were set with, as a browser keeps it: the path they are sent to, and when
 * they lapse (ms on the world's clock; null = never). A cookie put in the jar by hand has none, and
 * goes with every request.
 */
const scopes = new WeakMap<Jar, Map<string, { path: string; expiresAt: number | null }>>();

/** RFC 6265 5.1.4: the cookie path is the request path, or a prefix of it ending at a `/`. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * One request as the browser and the host make it: `pathAndQuery` is under `/tracker` (empty for
 * the bare `/tracker`), `info.path` is what the host passes for it (`"/"` for `/tracker` and
 * `/tracker/`), and the jar sends only the cookies whose `Path` matches and whose `Max-Age` has not
 * run out on the world's clock.
 */
export async function call(plugin: Plugin, method: string, pathAndQuery: string, c: Call = {}): Promise<Response> {
  const [path = "", query] = pathAndQuery.split("?");
  const full = `/tracker${path}`;
  const now = clocks.get(plugin)?.now().getTime() ?? Date.now();
  const headers = new Headers(c.headers ?? {});
  if (c.jar) {
    const scope = scopes.get(c.jar);
    const sent: string[] = [];
    for (const [k, v] of c.jar) {
      const s = scope?.get(k);
      if (s && s.expiresAt !== null && now >= s.expiresAt) {
        c.jar.delete(k);
        scope?.delete(k);
      } else if (!s || pathMatches(full, s.path)) sent.push(`${k}=${v}`);
    }
    if (sent.length > 0) headers.set("cookie", sent.join("; "));
  }
  if (c.form) headers.set("content-type", "application/x-www-form-urlencoded");
  if (c.origin !== undefined && c.origin !== null) headers.set("origin", c.origin);
  // The Host header is whatever the client says: the handler must never build from it.
  const request = new Request(`https://evil.example.net${full}${query ? `?${query}` : ""}`, {
    method,
    headers,
    ...(c.form ? { body: new URLSearchParams(c.form).toString() } : {}),
  });
  // The host's mapping (rackbops-discord-bot `routeHttpRequest`): the path after `/tracker`, or "/".
  const res = await plugin.http!(request, { path: /^\/[^/]+(\/.*)?$/.exec(full)?.[1] ?? "/", clientIp: "unknown" });
  if (c.jar) {
    let scope = scopes.get(c.jar);
    if (!scope) scopes.set(c.jar, (scope = new Map()));
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ""] = sc.split(";");
      const eq = pair.indexOf("=");
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      const maxAge = /;\s*Max-Age=(-?[0-9]+)/i.exec(sc)?.[1];
      if (maxAge !== undefined && Number(maxAge) <= 0) {
        c.jar.delete(k);
        scope.delete(k);
      } else {
        c.jar.set(k, v);
        scope.set(k, { path: /;\s*Path=([^;]*)/i.exec(sc)?.[1]?.trim() ?? "/", expiresAt: maxAge === undefined ? null : now + Number(maxAge) * 1000 });
      }
    }
  }
  return res;
}

export function tokenOf(answer: string): string {
  const m = /<https:\/\/clerk\.example\.com\/tracker\/login\?t=([A-Za-z0-9_-]+)>/.exec(answer);
  if (!m?.[1]) throw new Error(`no link in: ${answer}`);
  return m[1];
}

export function hidden(body: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(body);
  if (!m) throw new Error(`no hidden ${name}`);
  return m[1] ?? "";
}

export const SESSION = "__Secure-tracker-session";
export const LOGIN = "__Secure-tracker-login";

/** Opens the link's page into `jar` and returns its form fields. */
export async function openLink(plugin: Plugin, token: string, jar: Jar) {
  const res = await call(plugin, "GET", `/login?t=${token}`, { jar });
  const body = await res.text();
  return { res, body, form: body.includes('name="t"') ? { t: hidden(body, "t"), csrf: hidden(body, "csrf") } : null };
}

/** `/web`, open the link, press Sign in: a jar holding a session. */
export async function signIn(plugin: Plugin, discordId: string): Promise<Jar> {
  const jar: Jar = new Map();
  const { form } = await openLink(plugin, tokenOf(await slash(plugin, "web", discordId)), jar);
  const res = await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: ORIGIN });
  expect(res.status).toBe(303);
  expect(jar.has(SESSION)).toBe(true);
  return jar;
}

export async function csrfOf(plugin: Plugin, jar: Jar): Promise<string> {
  return hidden(await (await call(plugin, "GET", "/settings", { jar })).text(), "csrf");
}

/** Presses the button `customId` on a DM as `userId`; answers what the press said (edits, follow-ups, replies). */
export async function press(plugin: Plugin, customId: string, userId: string): Promise<string[]> {
  const said: string[] = [];
  const interaction = {
    customId,
    guildId: null,
    user: { id: userId },
    message: { content: "the message" },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    isMessageComponent: () => true,
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (x: { content: string }) => void said.push(x.content),
    followUp: async (x: { content: string }) => void said.push(x.content),
    reply: async (x: { content: string }) => {
      interaction.replied = true;
      said.push(x.content);
    },
    showModal: async () => {},
  };
  await plugin.interactions!(interaction as unknown as MessageComponentInteraction);
  return said;
}

/** Submits the Reply modal of run `occurrenceId` as `userId` with `text`. */
export async function replyText(plugin: Plugin, occurrenceId: string, userId: string, text: string): Promise<string> {
  const edits: { content: string }[] = [];
  const interaction = {
    customId: `tracker:m.o.${occurrenceId}`,
    guildId: null,
    user: { id: userId },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    isMessageComponent: () => false,
    fields: { getTextInputValue: () => text },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (x: { content: string }) => void edits.push(x),
    followUp: async () => {},
    reply: async () => {},
  };
  await plugin.interactions!(interaction as unknown as ModalSubmitInteraction);
  return edits[0]?.content ?? "";
}

/**
 * Makes an API token on the web as the person signed in to `jar`; answers the token, read off the
 * DM that carries it (the page never shows it).
 */
export async function makeToken(w: { plugin: Plugin; sent: { userId: string; message: unknown }[] }, jar: Jar, name = "agent", expiry = "90"): Promise<string> {
  const csrf = await csrfOf(w.plugin, jar);
  const before = w.sent.length;
  const res = await call(w.plugin, "POST", "/tokens", { jar, form: { csrf, name, expiry }, origin: ORIGIN });
  const page = await res.text();
  const dm = w.sent.slice(before).map((s) => String((s.message as { content?: unknown }).content ?? "")).find((c) => c.includes("API token"));
  const m = dm ? /`(trk_[A-Za-z0-9_-]{43})`/.exec(dm) : null;
  if (res.status !== 200 || !m?.[1]) throw new Error(`no token made (${res.status})`);
  if (page.includes(m[1])) throw new Error("the page showed the token");
  return m[1];
}

export interface ApiCall {
  token?: string;
  /** A JSON body, sent as `application/json` unless `headers` says otherwise. */
  body?: unknown;
  /** A raw body, as is. */
  raw?: string;
  headers?: Record<string, string>;
  jar?: Jar;
}

/** One request to the task API, `path` under `/api/v1`. */
export async function api(plugin: Plugin, method: string, path: string, c: ApiCall = {}): Promise<Response> {
  const headers = new Headers();
  if (c.token !== undefined) headers.set("authorization", `Bearer ${c.token}`);
  if (c.body !== undefined) headers.set("content-type", "application/json");
  if (c.jar && c.jar.size > 0) headers.set("cookie", [...c.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  for (const [k, v] of Object.entries(c.headers ?? {})) headers.set(k, v);
  const body = c.raw ?? (c.body !== undefined ? JSON.stringify(c.body) : undefined);
  const full = `/api/v1${path}`;
  const request = new Request(`https://evil.example.net/tracker${full}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  return plugin.http!(request, { path: full.split("?")[0] ?? full, clientIp: "unknown" });
}
