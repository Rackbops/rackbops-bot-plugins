import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { DELEGATION_SKEW_MS, MAX_DELEGATION_MS } from "../usr-identity.js";
import { OPERATIONS, operationOf, parseDelegates, type RouteKind } from "./api-delegation.js";
import { api, cleanup, CURLY, LARRY, makeToken, people, signIn, slash, world } from "./harness.js";

/**
 * The task API's usr delegation tokens (rackbops-bot-plugins#370): a fake usr serves a real ES256
 * JWKS, and the tests sign real delegation tokens with its private key, as usr does for a service
 * like tracker-mcp acting for one person.
 */

afterEach(cleanup);

const USR = "https://id.example.com";
const LARRY_SUB = "6f1c2a9e-0000-4000-8000-000000000002";
const NOW_S = Math.floor(Date.parse("2026-10-01T12:00:00.000Z") / 1000);

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pair, jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const DLG = { alg: "ES256", kid: "k1", typ: "dlg+jwt" };

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = DLG): Promise<string> {
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

const claims = (o: Record<string, unknown> = {}) => ({
  iss: "usr",
  sub: LARRY_SUB,
  aud: "tracker",
  act: { sub: "key:7", name: "tracker-mcp" },
  scope: "tracker:list_tasks",
  iat: NOW_S,
  exp: NOW_S + 300,
  jti: "j1",
  ...o,
});

async function setup(opts: { delegates?: string } = {}) {
  const k = await keyPair();
  const state = { down: false };
  const usrFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname !== "/.well-known/jwks.json") throw new Error(`unexpected usr call ${url.pathname}`);
    if (state.down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ keys: [{ ...k.jwk, kid: "k1" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const logs: string[] = [];
  const env: Record<string, string> = { TRACKER_USR_URL: USR, TRACKER_USR_KEY: "k" };
  if (opts.delegates !== "") env.TRACKER_API_DELEGATES = opts.delegates ?? "7";
  const w = await world({ env, usrFetch, logs });
  await people(w.plugin);
  const db = new Database(w.dbPath);
  try {
    db.query("UPDATE users SET usr_subject = ? WHERE discord_id = ?").run(LARRY_SUB, LARRY);
  } finally {
    db.close();
  }
  const token = (o: Record<string, unknown> = {}, header?: Record<string, unknown>) => sign(k.pair.privateKey, claims(o), header);
  return { ...w, k, state, logs, token };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

function taskCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("a usr delegation token on the task API", () => {
  it("lists only the linked person's own tasks", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "tomorrow 9am" } });
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly's own", when: "tomorrow 9am" } });
    const res = await api(w.plugin, "GET", "/tasks", { token: await w.token() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { title: string }[] };
    expect(body.tasks.map((t) => t.title)).toEqual(["water the plants"]);
  });

  it("is refused for a wrong audience, expired, an identity token, an unknown key, an unlinked person, an unlisted service, or past usr's cap", async () => {
    const w = await setup();
    const refusedWith = async (t: string) => {
      const res = await api(w.plugin, "GET", "/tasks", { token: t });
      return [res.status, await code(res)];
    };
    expect(await refusedWith(await w.token({ aud: "meals" }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ exp: NOW_S }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({}, { alg: "ES256", kid: "k1", typ: "JWT" }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({}, { ...DLG, kid: "k9" }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ sub: "6f1c2a9e-0000-4000-8000-0000000000ff" }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ act: { sub: "key:8", name: "someone else" } }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ exp: NOW_S + (MAX_DELEGATION_MS + DELEGATION_SKEW_MS) / 1000 + 1 }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ aud: ["tracker"] }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ jti: undefined }))).toEqual([401, "invalid_token"]);
    expect(await refusedWith(await w.token({ jti: "j1\nforged log line" }))).toEqual([401, "invalid_token"]);
    const other = await keyPair();
    expect(await refusedWith(await sign(other.pair.privateKey, claims()))).toEqual([401, "invalid_token"]);
  });

  it("takes a token at usr's full 30 minutes from a usr whose clock runs ahead of this one", async () => {
    const w = await setup();
    const res = await api(w.plugin, "GET", "/tasks", { token: await w.token({ exp: NOW_S + MAX_DELEGATION_MS / 1000 + 30 }) });
    expect(res.status).toBe(200);
  });

  it("still takes trk_ tokens with delegation on", async () => {
    const w = await setup();
    const larry = await signIn(w.plugin, LARRY);
    const trk = await makeToken(w, larry);
    expect((await api(w.plugin, "GET", "/tasks", { token: trk })).status).toBe(200);
  });

  it("needs its operation in scope: a token to list tasks makes none", async () => {
    const w = await setup();
    const body = { type: "reminder", text: "x", when: "tomorrow 9am" };
    const res = await api(w.plugin, "POST", "/tasks", { token: await w.token(), body });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("insufficient_scope");
    expect(res.headers.get("www-authenticate")).toContain('scope="tracker:create_task"');
    expect(taskCount(w.dbPath)).toBe(0);
    const ok = await api(w.plugin, "POST", "/tasks", { token: await w.token({ scope: "tracker:create_task tracker:list_tasks" }), body });
    expect(ok.status).toBe(201);
    expect(taskCount(w.dbPath)).toBe(1);
    // The write names the acting service in the log.
    expect(w.logs.some((l) => l.includes("create_task") && l.includes("key:7"))).toBe(true);
  });

  it("answers 503 when usr's keys cannot be fetched, and writes nothing", async () => {
    const w = await setup();
    w.state.down = true;
    const res = await api(w.plugin, "POST", "/tasks", {
      token: await w.token({ scope: "tracker:create_task" }),
      body: { type: "reminder", text: "x", when: "tomorrow 9am" },
    });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("usr_unavailable");
    expect(taskCount(w.dbPath)).toBe(0);
  });

  it("is not taken at all without TRACKER_API_DELEGATES, while trk_ tokens work as before", async () => {
    const w = await setup({ delegates: "" });
    const res = await api(w.plugin, "GET", "/tasks", { token: await w.token() });
    expect(res.status).toBe(401);
    const larry = await signIn(w.plugin, LARRY);
    const trk = await makeToken(w, larry);
    expect((await api(w.plugin, "GET", "/tasks", { token: trk })).status).toBe(200);
  });

  it("shows the acting service on /me instead of a token", async () => {
    const w = await setup();
    const res = await api(w.plugin, "GET", "/me", { token: await w.token({ scope: "tracker:whoami" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.delegation).toEqual({ actor: "key:7", scopes: ["tracker:whoami"], expiresAt: new Date((NOW_S + 300) * 1000).toISOString() });
    expect(body.token).toBeUndefined();
  });
});

describe("TRACKER_API_DELEGATES", () => {
  it("is off unset, ids as key:<id>, and refused without usr or malformed", () => {
    expect(parseDelegates({}, true).size).toBe(0);
    expect([...parseDelegates({ TRACKER_API_DELEGATES: "7,031" }, true)]).toEqual(["key:7", "key:31"]);
    expect(() => parseDelegates({ TRACKER_API_DELEGATES: "7" }, false)).toThrow("needs TRACKER_USR_URL");
    expect(() => parseDelegates({ TRACKER_API_DELEGATES: "key:7" }, true)).toThrow("key ids");
  });
});

describe("the route-to-operation table", () => {
  it("names one distinct operation for every route and method the API takes, and none for the rest", () => {
    const routes: [RouteKind, string[]][] = [
      [{ kind: "me" }, ["GET"]],
      [{ kind: "types" }, ["GET"]],
      [{ kind: "capabilities" }, ["GET"]],
      [{ kind: "tasks" }, ["GET", "POST"]],
      [{ kind: "task", id: "t1" }, ["GET", "PATCH", "DELETE"]],
      [{ kind: "act", id: "t1", action: "pause" }, ["POST"]],
      [{ kind: "act", id: "t1", action: "resume" }, ["POST"]],
      [{ kind: "listings", id: "t1" }, ["POST"]],
      [{ kind: "sources", id: "t1" }, ["POST"]],
      [{ kind: "ready", id: "t1" }, ["POST"]],
    ];
    const seen: string[] = [];
    for (const [r, methods] of routes) {
      for (const m of ["GET", "POST", "PATCH", "DELETE"]) {
        const op = operationOf(r, m);
        if (methods.includes(m)) seen.push(op as string);
        else expect(op).toBeNull();
      }
    }
    expect(seen.sort()).toEqual([...OPERATIONS].sort());
  });
});
