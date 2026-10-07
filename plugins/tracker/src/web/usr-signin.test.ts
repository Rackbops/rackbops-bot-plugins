import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { JWKS_RETRY_MS, JWKS_TTL_MS, UsrVerifier } from "../usr-identity.js";
import { LEFT_SERVER, RECHECK_FAILED, USR_NO_COOKIE, USR_NOT_LINKED, USR_NOT_MEMBER } from "./app.js";
import { call, csrfOf, cleanup, CURLY, type Jar, LARRY, ORIGIN, people, SESSION, signIn, type WebLookup, world } from "./harness.js";

/**
 * The web area's sign-in through usr's `nz_id` cookie (usr-identity.ts, app.ts `usrSignIn`): a fake
 * usr serves a real ES256 JWKS, and the tests sign real tokens with its private key.
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

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "k1" }): Promise<string> {
  const body = `${b64(header)}.${b64(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

const identity = (o: Record<string, unknown> = {}) => ({ iss: "usr", sub: LARRY_SUB, name: "Larry", sid: "s", iat: NOW_S, exp: NOW_S + 1800, roles: ["tracker:member"], ...o });

/** A fake usr serving one JWKS; counts the fetches. */
async function fakeUsr() {
  const k = await keyPair();
  const state = { jwks: { keys: [{ ...k.jwk, kid: "k1" }] } as { keys: unknown[] }, fetches: 0, down: false };
  const usrFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname !== "/.well-known/jwks.json") throw new Error(`unexpected usr call ${url.pathname}`);
    state.fetches++;
    if (state.down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(state.jwks), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { ...k, state, usrFetch };
}

async function usrWorld(opts: { guild?: boolean; webMembership?: WebLookup } = {}) {
  const usr = await fakeUsr();
  const w = await world({ env: { TRACKER_USR_URL: USR, TRACKER_USR_KEY: "k" }, usrFetch: usr.usrFetch, ...opts });
  await people(w.plugin);
  return { ...w, usr };
}

function linkLarry(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE users SET usr_subject = ? WHERE discord_id = ?").run(LARRY_SUB, LARRY);
  } finally {
    db.close();
  }
}

describe("UsrVerifier", () => {
  async function verifier(now = NOW_S * 1000) {
    const usr = await fakeUsr();
    let at = now;
    const v = new UsrVerifier({ url: USR, fetchImpl: usr.usrFetch, now: () => at });
    return { usr, v, advance: (ms: number) => (at += ms) };
  }

  it("accepts usr's identity token and answers its sub and roles", async () => {
    const { usr, v } = await verifier();
    expect(await v.verify(await sign(usr.pair.privateKey, identity()))).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
  });

  it("refuses a delegation token, a wrong issuer, an expired token, another key and a bad signature", async () => {
    const { usr, v } = await verifier();
    const p = usr.pair.privateKey;
    expect(await v.verify(await sign(p, identity(), { alg: "ES256", kid: "k1", typ: "dlg+jwt" }))).toBeNull();
    expect(await v.verify(await sign(p, identity({ act: { sub: "svc" } })))).toBeNull();
    expect(await v.verify(await sign(p, identity({ iss: "someone" })))).toBeNull();
    expect(await v.verify(await sign(p, identity({ exp: NOW_S })))).toBeNull();
    expect(await v.verify(await sign(p, identity(), { alg: "HS256", kid: "k1" }))).toBeNull();
    const other = await keyPair();
    expect(await v.verify(await sign(other.pair.privateKey, identity()))).toBeNull();
    const good = await sign(p, identity());
    const tampered = `${good.split(".")[0]}.${b64(identity({ roles: ["tracker:admin"] }))}.${good.split(".")[2]}`;
    expect(await v.verify(tampered)).toBeNull();
    expect(await v.verify("not.a.token")).toBeNull();
    expect(await v.verify(null)).toBeNull();
  });

  it("caches the keys, fetches again on an unknown kid at most every 30 seconds, and after five minutes", async () => {
    const { usr, v, advance } = await verifier();
    const token = await sign(usr.pair.privateKey, identity());
    await v.verify(token);
    await v.verify(token);
    expect(usr.state.fetches).toBe(1);
    // A rotated key: unknown until usr's JWKS has it, and asked for no more than every 30 s.
    const next = await keyPair();
    const rotated = await sign(next.pair.privateKey, identity(), { alg: "ES256", kid: "k2" });
    expect(await v.verify(rotated)).toBeNull();
    expect(usr.state.fetches).toBe(1);
    usr.state.jwks.keys.push({ ...next.jwk, kid: "k2" });
    advance(JWKS_RETRY_MS);
    expect(await v.verify(rotated)).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
    expect(usr.state.fetches).toBe(2);
    advance(JWKS_TTL_MS);
    await v.verify(token);
    expect(usr.state.fetches).toBe(3);
  });

  it("keeps the keys it has when usr cannot be reached", async () => {
    const { usr, v, advance } = await verifier();
    const token = await sign(usr.pair.privateKey, identity());
    await v.verify(token);
    usr.state.down = true;
    advance(JWKS_TTL_MS);
    expect(await v.verify(token)).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
  });
});

describe("web sign-in through usr", () => {
  it("signs a linked, registered member in from usr's cookie, and takes them to the page they asked for", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    const res = await call(w.plugin, "GET", "/settings", { jar });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/settings");
    expect(jar.has(SESSION)).toBe(true);
    const page = await call(w.plugin, "GET", "/settings", { jar });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Larry");
  });

  it("sends a browser without the cookie to usr once, back to this page, never built from the Host header", async () => {
    const w = await usrWorld();
    const res = await call(w.plugin, "GET", "/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${USR}/api/auth/sso/refresh?return=${encodeURIComponent(`${ORIGIN}/tracker/settings?usr=1`)}`);
    // Back from usr still without a cookie: say why, do not go round again.
    const back = await call(w.plugin, "GET", "/settings?usr=1");
    expect(back.status).toBe(403);
    expect(await back.text()).toContain(USR_NO_COOKIE.slice(0, 40));
  });

  it("refuses usr accounts without the member role, or linked to no one registered here", async () => {
    const w = await usrWorld();
    const noRole = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", await sign(w.usr.pair.privateKey, identity({ roles: ["city-hall:member"] }))]]) });
    expect(noRole.status).toBe(403);
    expect(await noRole.text()).toContain(USR_NOT_MEMBER.slice(0, 40));
    const unlinked = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]) });
    expect(unlinked.status).toBe(403);
    expect(await unlinked.text()).toContain(USR_NOT_LINKED.slice(0, 40));
  });

  it("keeps the address's own query across the trip to usr and back", async () => {
    const w = await usrWorld();
    const away = await call(w.plugin, "GET", "/settings?saved=1");
    expect(away.headers.get("location")).toBe(`${USR}/api/auth/sso/refresh?return=${encodeURIComponent(`${ORIGIN}/tracker/settings?saved=1&usr=1`)}`);
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    const back = await call(w.plugin, "GET", "/settings?saved=1&usr=1", { jar });
    expect(back.headers.get("location")).toBe("/tracker/settings?saved=1");
  });

  it("after Sign out, does not sign back in on its own; the sign-in page's button does", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    await call(w.plugin, "GET", "/", { jar });
    const out = await call(w.plugin, "POST", "/logout", { jar, form: { csrf: await csrfOf(w.plugin, jar) }, origin: ORIGIN });
    expect(out.headers.get("location")).toBe("/tracker/signin?out=1");
    expect(jar.has(SESSION)).toBe(false);
    const again = await call(w.plugin, "GET", "/", { jar });
    expect(again.headers.get("location")).toBe("/tracker/signin?out=1");
    expect(jar.has(SESSION)).toBe(false);
    const button = await call(w.plugin, "GET", "/?usr=go", { jar });
    expect(button.headers.get("location")).toBe("/tracker/");
    expect(jar.has(SESSION)).toBe(true);
    expect(jar.has("__Secure-tracker-out")).toBe(false);
  });

  it("signs out a person whose usr cookie no longer carries the member role", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    await call(w.plugin, "GET", "/", { jar });
    expect((await call(w.plugin, "GET", "/", { jar })).status).toBe(200);
    jar.set("nz_id", await sign(w.usr.pair.privateKey, identity({ roles: [] })));
    const res = await call(w.plugin, "GET", "/", { jar });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(USR_NOT_MEMBER.slice(0, 40));
    expect(jar.has(SESSION)).toBe(false);
  });

  it("checks server membership before opening the session", async () => {
    let answer: "member" | "not-member" | null = "not-member";
    const w = await usrWorld({ guild: true, webMembership: async () => answer });
    linkLarry(w.dbPath);
    const token = await sign(w.usr.pair.privateKey, identity());
    const left = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", token]]) });
    expect(left.status).toBe(403);
    expect(await left.text()).toContain(LEFT_SERVER.slice(0, 30));
    answer = null;
    const unknown = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", token]]) });
    expect(await unknown.text()).toContain(RECHECK_FAILED.slice(0, 30));
    answer = "member";
    w.clock.advance(60 * 1000);
    const jar: Jar = new Map([["nz_id", token]]);
    expect((await call(w.plugin, "GET", "/", { jar })).status).toBe(303);
    expect((await call(w.plugin, "GET", "/", { jar })).status).toBe(200);
  });

  it("says it could not confirm the sign-in when usr's keys cannot be fetched", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    w.usr.state.down = true;
    const res = await call(w.plugin, "GET", "/?usr=1", { jar: new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]) });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(USR_NO_COOKIE.slice(0, 40));
  });

  it("an expired cookie goes back to usr for a fresh one", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const res = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", await sign(w.usr.pair.privateKey, identity({ exp: NOW_S - 1 }))]]) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith(`${USR}/api/auth/sso/refresh?return=`);
  });

  it("keeps the one-time /web link working beside it, and offers usr on the sign-in page", async () => {
    const w = await usrWorld();
    const jar = await signIn(w.plugin, CURLY);
    expect((await call(w.plugin, "GET", "/", { jar })).status).toBe(200);
    const help = await (await call(w.plugin, "GET", "/signin")).text();
    expect(help).toContain('href="/tracker/?usr=go">Sign in with usr</a>');
    expect(help).toContain("Or run <code>/web</code>");
  });

  it("does nothing new with the usr link off: no session means the sign-in page", async () => {
    const w = await world();
    await people(w.plugin);
    const res = await call(w.plugin, "GET", "/settings");
    expect(res.headers.get("location")).toBe("/tracker/signin");
    expect(await (await call(w.plugin, "GET", "/signin")).text()).not.toContain("Sign in with usr");
  });
});
