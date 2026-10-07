import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { MIGRATIONS, migrate } from "./schema.js";
import pkg from "../package.json" with { type: "json" };
import { UsrLinks } from "./usr-links.js";
import { createUsrClient, parseUsrConfig, USR_APP_FORMAT, USR_URL_FORMAT, type UsrConfig, UsrError } from "./usr.js";

/** The link to our usr (usr.ts) and its column, schema migration 9. */

const KEY = "usr_k_secret-value";
const CONFIG: UsrConfig = { url: "https://id.example.com", key: KEY, app: "tracker" };
const PERSON = "100000000000000001";
const ADMIN = "100000000000000002";
const GUILD = "100000000000000003";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseUsrConfig", () => {
  it("checks what the manifest declares", () => {
    const entry = (key: string) => pkg.botPlugin.env.find((e) => e.key === key);
    expect(entry("TRACKER_USR_URL")?.format).toBe(USR_URL_FORMAT);
    expect(entry("TRACKER_USR_APP")?.format).toBe(USR_APP_FORMAT);
    expect(entry("TRACKER_USR_KEY")?.secret).toBe(true);
  });

  it("is off, quietly, with nothing set", () => {
    expect(parseUsrConfig({})).toBeNull();
    expect(parseUsrConfig({ TRACKER_USR_URL: "  " })).toBeNull();
  });

  it("takes the origin, the key and the default app", () => {
    expect(parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com/", TRACKER_USR_KEY: ` ${KEY} ` })).toEqual(CONFIG);
    expect(parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com:8443", TRACKER_USR_KEY: KEY, TRACKER_USR_APP: "clerk-dev" })).toEqual({
      url: "https://id.example.com:8443",
      key: KEY,
      app: "clerk-dev",
    });
  });

  it("refuses a URL without a key, and a key or app without a URL", () => {
    expect(() => parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com" })).toThrow("TRACKER_USR_KEY is not");
    expect(() => parseUsrConfig({ TRACKER_USR_KEY: KEY })).toThrow("need TRACKER_USR_URL");
    expect(() => parseUsrConfig({ TRACKER_USR_APP: "tracker" })).toThrow("need TRACKER_USR_URL");
  });

  it("refuses anything but a bare https origin, and never echoes the URL", () => {
    for (const url of ["http://id.example.com", "https://id.example.com/api", "https://id.example.com?x=1", "id.example.com"]) {
      expect(() => parseUsrConfig({ TRACKER_USR_URL: url, TRACKER_USR_KEY: KEY })).toThrow("is not an https origin");
    }
    let message = "";
    try {
      parseUsrConfig({ TRACKER_USR_URL: "https://user:pa55@id.example.com", TRACKER_USR_KEY: KEY });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("must not contain credentials");
    expect(message).not.toContain("pa55");
  });

  it("refuses a key with whitespace in it without echoing it, and a malformed app", () => {
    let message = "";
    try {
      parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: "two words" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("whitespace");
    expect(message).not.toContain("two words");
    expect(() => parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: KEY, TRACKER_USR_APP: "Tracker" })).toThrow("not a usr app name");
    expect(() => parseUsrConfig({ TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: KEY, TRACKER_USR_APP: "a:b" })).toThrow("not a usr app name");
  });
});

describe("UsrClient.allow", () => {
  it("posts usr's allow body with the key as a bearer, and reads the user id", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ user_id: "6f1c2a9e-0000-4000-8000-000000000001", created: true, roles: ["tracker:member"] }));
    const usr = createUsrClient({ config: CONFIG, fetchImpl });
    const result = await usr.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"], displayName: "Larry" });
    expect(result).toEqual({ userId: "6f1c2a9e-0000-4000-8000-000000000001", created: true, roles: ["tracker:member"] });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://id.example.com/api/discord/allow");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call.init.body as string)).toEqual({
      discord_user_id: PERSON,
      guild_id: GUILD,
      invoker_discord_user_id: ADMIN,
      roles: ["member"],
      display_name: "Larry",
    });
  });

  it("names usr's reason on a refusal, and never the key", async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: "invoker lacks tracker:register" }, 403));
    const usr = createUsrClient({ config: CONFIG, fetchImpl });
    const err = await usr.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsrError);
    expect((err as UsrError).status).toBe(403);
    expect((err as UsrError).message).toBe("usr answered HTTP 403: invoker lacks tracker:register");
    expect((err as UsrError).message).not.toContain(KEY);
  });

  it("says to check the key on a 401, and treats a redirect as an edge login", async () => {
    const refused = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ error: "unauthorized" }, 401)).fetchImpl });
    await expect(refused.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"] })).rejects.toThrow("check TRACKER_USR_KEY");
    const edge = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => new Response(null, { status: 302, headers: { Location: "https://login.example.com" } })).fetchImpl });
    await expect(edge.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"] })).rejects.toThrow("redirect (HTTP 302)");
  });

  it("refuses an answer that is not usr's, and an unreachable usr", async () => {
    const odd = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ ok: true })).fetchImpl });
    await expect(odd.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"] })).rejects.toThrow("is TRACKER_USR_URL usr?");
    const down = createUsrClient({
      config: CONFIG,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const err = await down.allow({ discordId: PERSON, guildId: GUILD, invokerDiscordId: ADMIN, roles: ["member"] }).catch((e: unknown) => e);
    expect((err as UsrError).message).toBe("usr could not be reached");
    expect((err as UsrError).status).toBeNull();
  });

  it("never sends a request with an id that is not a Discord id", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({}));
    const usr = createUsrClient({ config: CONFIG, fetchImpl });
    await expect(usr.allow({ discordId: PERSON, guildId: "dm", invokerDiscordId: ADMIN, roles: ["member"] })).rejects.toThrow("the server is not a Discord id");
    expect(calls).toHaveLength(0);
  });
});

describe("UsrClient.registerLink", () => {
  it("asks with the allow policy and hands back usr's https link", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ url: "https://id.example.com/register/discord?t=abc", expires_at: "2026-10-07T00:30:00.000Z" }));
    const usr = createUsrClient({ config: CONFIG, fetchImpl });
    expect(await usr.registerLink({ discordId: PERSON, guildId: GUILD })).toEqual({
      url: "https://id.example.com/register/discord?t=abc",
      expiresAt: "2026-10-07T00:30:00.000Z",
    });
    expect((calls[0] as Call).url).toBe("https://id.example.com/api/discord/register-link");
    expect(JSON.parse((calls[0] as Call).init.body as string)).toEqual({ discord_user_id: PERSON, guild_id: GUILD, policy: "allow" });
  });

  it("is null when the person is already registered there (409)", async () => {
    const usr = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ error: "already registered" }, 409)).fetchImpl });
    expect(await usr.registerLink({ discordId: PERSON, guildId: GUILD })).toBeNull();
  });

  it("refuses a link that is not https, and passes on a rate limit", async () => {
    const plain = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ url: "http://id.example.com/register/discord?t=abc", expires_at: "x" })).fetchImpl });
    await expect(plain.registerLink({ discordId: PERSON, guildId: GUILD })).rejects.toThrow("not https");
    const limited = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ error: "rate limit exceeded" }, 429)).fetchImpl });
    await expect(limited.registerLink({ discordId: PERSON, guildId: GUILD })).rejects.toThrow("HTTP 429: rate limit exceeded");
  });

  it("refuses a link with credentials in it", async () => {
    const usr = createUsrClient({ config: CONFIG, fetchImpl: fakeFetch(() => json({ url: "https://u:p@id.example.com/register/discord?t=abc", expires_at: "x" })).fetchImpl });
    const err = await usr.registerLink({ discordId: PERSON, guildId: GUILD }).catch((e: unknown) => e);
    expect(String(err)).toContain("has credentials in it");
    expect(String(err)).not.toContain("u:p");
  });

  it("asks with the open policy when told to, and keeps usr's reason with its dash as --", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ error: "not allowed yet \u2014 ask an admin to /allow you" }, 403));
    const usr = createUsrClient({ config: CONFIG, fetchImpl });
    const err = (await usr.registerLink({ discordId: PERSON, guildId: GUILD, policy: "open" }).catch((e: unknown) => e)) as UsrError;
    expect(JSON.parse((calls[0] as Call).init.body as string).policy).toBe("open");
    expect(err.status).toBe(403);
    expect(err.reason).toBe("not allowed yet -- ask an admin to /allow you");
    expect(err.message).toBe("usr answered HTTP 403: not allowed yet -- ask an admin to /allow you");
  });
});

describe("migration 9", () => {
  it("is purely additive: a database at 8 keeps every row and index, and gains a null usr_subject", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 8; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    db.exec("INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('1', 'Larry', 'UTC', 9, 1, '2026-10-07T00:00:00.000Z')");
    db.exec("INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('2', 'Moe', 'UTC', 8, 0, '2026-10-07T00:00:00.000Z')");
    // `db.query` caches a statement by its text, columns and all; read afresh after the ALTER.
    const all = (sql: string) => db.prepare(sql).all();
    const indexes = () => db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as { name: string }[];
    const tables = () => (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    const before = { indexes: indexes(), tables: tables(), users: all("SELECT * FROM users ORDER BY seq") as Record<string, unknown>[] };

    expect(migrate(db)).toBe(8);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
    expect(tables()).toEqual(before.tables);
    expect(indexes().filter((i) => i.name !== "users_usr_subject")).toEqual(before.indexes);
    expect(all("SELECT * FROM users ORDER BY seq")).toEqual(before.users.map((u) => ({ ...u, usr_subject: null })));
  });

  it("holds one person per usr account, and any number unlinked", () => {
    const db = new Database(":memory:");
    migrate(db);
    const add = (id: string, subject: string | null) =>
      db.query("INSERT INTO users (discord_id, usr_subject, display_name, time_zone, preferred_hour, admin, created_at) VALUES (?, ?, 'x', 'UTC', 9, 0, 'now')").run(id, subject);
    add("1", null);
    add("2", null);
    add("3", "6f1c2a9e-0000-4000-8000-000000000001");
    expect(() => add("4", "6f1c2a9e-0000-4000-8000-000000000001")).toThrow();
  });
});

describe("UsrLinks", () => {
  function people() {
    const db = new Database(":memory:");
    migrate(db);
    const add = db.prepare("INSERT INTO users (discord_id, time_zone, preferred_hour, admin, created_at) VALUES (?, 'UTC', 9, 0, 'x')");
    add.run("1");
    add.run("2");
    return { db, links: new UsrLinks(db) };
  }

  it("keeps nothing for someone who left while usr was being asked (forget-me)", () => {
    const { db, links } = people();
    db.prepare("DELETE FROM users WHERE seq = 1").run();
    expect(links.link("u1", "s")).toBe("gone");
    expect(links.link("u2", "s")).toBe("linked"); // the account was never held by the one who left
  });

  it("unlinks, so a later link is new, and forgets that they signed up", () => {
    const { links } = people();
    expect(links.link("u1", "s")).toBe("linked");
    links.markSignedUp("u1");
    links.unlink("u1");
    expect(links.subjectOf("u1")).toBeNull();
    expect(links.isSignedUp("u1")).toBe(false);
    expect(links.link("u2", "s")).toBe("linked");
  });

  it("forgets that they signed up when relinked to another account", () => {
    const { links } = people();
    links.link("u1", "s");
    links.markSignedUp("u1");
    expect(links.link("u1", "t")).toBe("relinked");
    expect(links.isSignedUp("u1")).toBe(false);
  });
});
