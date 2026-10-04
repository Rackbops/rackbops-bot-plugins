import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@rackbops/docket-core";
import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { Plugin } from "../../../../packages/api/contract.js";
import { makeFakeHost } from "../../../../packages/testkit/index.js";
import type { Membership } from "../access.js";
import { createPlugin } from "../index.js";
import { HOST_CANNOT_MESSAGE } from "../notifier.js";
import type { Source } from "../want-sources.js";

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

/** Each test file's `afterEach`: removes the databases its tests made. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
    /** A BGG source, as if `TRACKER_BGG_TOKEN` were set (want-bgg.ts). */
    bgg?: Source;
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
      // The command side's gate: everyone is a member when there is one.
      ...(opts.guild ? { membership: async (): Promise<Membership> => "member" } : {}),
      ...(opts.webMembership ? { webMembership: opts.webMembership } : {}),
      ...(opts.fetch ? { fetch: () => opts.fetch as Fetch } : {}),
      ...(opts.cityHallFetch ? { cityHallFetch: opts.cityHallFetch } : {}),
      ...(opts.executeStarted ? { executeStarted: opts.executeStarted } : {}),
      ...(opts.bgg ? { bgg: opts.bgg } : {}),
    },
  );
  await plugin.activate!();
  return { plugin, clock, dbPath, sent, delivery };
}

export async function slash(
  plugin: Plugin,
  name: string,
  userId: string,
  o: { strings?: Record<string, string>; users?: Record<string, string>; client?: unknown; sub?: string; ints?: Record<string, number>; numbers?: Record<string, number> } = {},
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
      getUser: (k: string) => (o.users?.[k] ? { id: o.users[k], bot: false } : null),
    },
    deferReply: async (x: unknown) => void (deferred = x),
    editReply: async (x: { content: string }) => void edits.push(x),
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

export async function call(plugin: Plugin, method: string, pathAndQuery: string, c: Call = {}): Promise<Response> {
  const [path = "/", query] = pathAndQuery.split("?");
  const headers = new Headers(c.headers ?? {});
  if (c.jar && c.jar.size > 0) headers.set("cookie", [...c.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  if (c.form) headers.set("content-type", "application/x-www-form-urlencoded");
  if (c.origin !== undefined && c.origin !== null) headers.set("origin", c.origin);
  // The Host header is whatever the client says: the handler must never build from it.
  const request = new Request(`https://evil.example.net/tracker${path}${query ? `?${query}` : ""}`, {
    method,
    headers,
    ...(c.form ? { body: new URLSearchParams(c.form).toString() } : {}),
  });
  const res = await plugin.http!(request, { path, clientIp: "unknown" });
  if (c.jar) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ""] = sc.split(";");
      const eq = pair.indexOf("=");
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      if (/Max-Age=0\b/.test(sc)) c.jar.delete(k);
      else c.jar.set(k, v);
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
