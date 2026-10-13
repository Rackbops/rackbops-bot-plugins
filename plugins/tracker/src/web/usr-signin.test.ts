import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { NOT_MEMBER } from "../access.js";
import { JWKS_RETRY_MS, JWKS_TTL_MS, UsrVerifier } from "../usr-identity.js";
import { USR_NO_COOKIE, USR_RECHECK_FAILED, USR_NOT_LINKED, USR_NOT_MEMBER } from "./app.js";
import { api, call, csrfOf, cleanup, CURLY, type Jar, LARRY, makeToken, openLink, ORIGIN, people, SESSION, signIn, slash, tokenOf, type WebLookup, world } from "./harness.js";

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
  const state = { jwks: { keys: [{ ...k.jwk, kid: "k1" }] } as { keys: unknown[] }, fetches: 0, down: false, status: 200, hold: null as Promise<void> | null };
  const usrFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname !== "/.well-known/jwks.json") throw new Error(`unexpected usr call ${url.pathname}`);
    state.fetches++;
    if (state.hold) await state.hold;
    if (state.down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(state.jwks), { status: state.status, headers: { "Content-Type": "application/json" } });
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

  it("counts a failed fetch as one, so a down usr is asked again only after 30 seconds", async () => {
    const { usr, v, advance } = await verifier();
    const token = await sign(usr.pair.privateKey, identity());
    usr.state.down = true;
    expect(await v.verify(token)).toBeNull();
    expect(await v.verify(token)).toBeNull();
    expect(usr.state.fetches).toBe(1);
    usr.state.down = false;
    advance(JWKS_RETRY_MS);
    expect(await v.verify(token)).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
    expect(usr.state.fetches).toBe(2);
  });

  it("fetches once for tokens checked at the same moment, and checks each against the keys it fetched", async () => {
    const { usr, v } = await verifier();
    const token = await sign(usr.pair.privateKey, identity());
    expect(await Promise.all([v.verify(token), v.verify(token)])).toEqual([
      { sub: LARRY_SUB, roles: ["tracker:member"] },
      { sub: LARRY_SUB, roles: ["tracker:member"] },
    ]);
    expect(usr.state.fetches).toBe(1);
  });

  it("answers a token with a known key at once, while a fetch for an unknown key hangs", async () => {
    const { usr, v, advance } = await verifier();
    const token = await sign(usr.pair.privateKey, identity());
    await v.verify(token);
    let release = () => {};
    usr.state.hold = new Promise<void>((r) => {
      release = r;
    });
    advance(JWKS_RETRY_MS);
    const next = await keyPair();
    const unknown = v.verify(await sign(next.pair.privateKey, identity(), { alg: "ES256", kid: "k2" }));
    while (usr.state.fetches < 2) await Bun.sleep(1);
    // The refetch for k2 is still out; k1's token must not wait for it.
    const known = await Promise.race([v.verify(token), Bun.sleep(200).then(() => "stalled" as const)]);
    expect(known).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
    release();
    expect(await unknown).toBeNull();
    expect(usr.state.fetches).toBe(2);
  });

  it("refuses a token with no sub, or an empty one", async () => {
    const { usr, v } = await verifier();
    const { sub: _sub, ...noSub } = identity();
    expect(await v.verify(await sign(usr.pair.privateKey, noSub))).toBeNull();
    expect(await v.verify(await sign(usr.pair.privateKey, identity({ sub: "" })))).toBeNull();
  });

  it("refuses a signature that is not 64 bytes", async () => {
    // A pin, not coverage of the length check: WebCrypto already refuses such a signature by itself.
    const { usr, v } = await verifier();
    const [h, p, sig] = (await sign(usr.pair.privateKey, identity())).split(".") as [string, string, string];
    const longer = Buffer.concat([Buffer.from(sig, "base64url"), Buffer.from([0])]).toString("base64url");
    expect(await v.verify(`${h}.${p}.${longer}`)).toBeNull();
  });

  it("uses only P-256 EC keys from the JWKS, past others it cannot use", async () => {
    const { usr, v } = await verifier();
    const p384 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    // A P-256 key listed as another key type: not one usr signs with, so never trusted.
    const mislabelled = await keyPair();
    usr.state.jwks.keys.unshift(
      { ...(await crypto.subtle.exportKey("jwk", p384.publicKey)), kid: "k384" },
      { ...(await crypto.subtle.exportKey("jwk", rsa.publicKey)), kid: "krsa" },
      { ...mislabelled.jwk, kty: "OKP", kid: "k9" },
    );
    expect(await v.verify(await sign(usr.pair.privateKey, identity()))).toEqual({ sub: LARRY_SUB, roles: ["tracker:member"] });
    expect(await v.verify(await sign(mislabelled.pair.privateKey, identity(), { alg: "ES256", kid: "k9" }))).toBeNull();
  });

  it("takes no keys from a JWKS over 64 KiB, a redirect or an error answer", async () => {
    for (const odd of [{ pad: "x".repeat(65 * 1024) }, { status: 302 }, { status: 500 }]) {
      const { usr, v } = await verifier();
      if ("pad" in odd) usr.state.jwks = { ...usr.state.jwks, pad: odd.pad } as { keys: unknown[] };
      else usr.state.status = odd.status;
      expect(await v.verify(await sign(usr.pair.privateKey, identity()))).toBeNull();
    }
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

  it("after Sign out, the button still signs in when usr's cookie had expired (the trip to usr and back)", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    await call(w.plugin, "GET", "/", { jar });
    await call(w.plugin, "POST", "/logout", { jar, form: { csrf: await csrfOf(w.plugin, jar) }, origin: ORIGIN });
    jar.set("nz_id", await sign(w.usr.pair.privateKey, identity({ exp: NOW_S - 1 })));
    const away = await call(w.plugin, "GET", "/?usr=go", { jar });
    expect(away.headers.get("location")).toBe(`${USR}/api/auth/sso/refresh?return=${encodeURIComponent(`${ORIGIN}/tracker/?usr=1`)}`);
    jar.set("nz_id", await sign(w.usr.pair.privateKey, identity()));
    const back = await call(w.plugin, "GET", "/?usr=1", { jar });
    expect(back.headers.get("location")).toBe("/tracker/");
    expect(jar.has(SESSION)).toBe(true);
  });

  it("says a second /allow links the account usr moved someone to at sign-up, and signs them in once it has", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    // Larry finished signing up on usr with an account he already had: usr's cookie names that one.
    const moved = "6f1c2a9e-0000-4000-8000-000000000099";
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity({ sub: moved }))]]);
    const before = await call(w.plugin, "GET", "/settings", { jar });
    expect(before.status).toBe(403);
    expect(await before.text()).toContain("a second /allow links it");
    // What the second /allow keeps (usr-commands.test.ts): the account usr now has for him.
    const db = new Database(w.dbPath);
    try {
      db.query("UPDATE users SET usr_subject = ? WHERE discord_id = ?").run(moved, LARRY);
    } finally {
      db.close();
    }
    expect((await call(w.plugin, "GET", "/settings", { jar })).headers.get("location")).toBe("/tracker/settings");
    expect(jar.has(SESSION)).toBe(true);
  });

  it("a /web sign-in ends the signed-out mark too", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    await call(w.plugin, "GET", "/", { jar });
    await call(w.plugin, "POST", "/logout", { jar, form: { csrf: await csrfOf(w.plugin, jar) }, origin: ORIGIN });
    expect(jar.has("__Secure-tracker-out")).toBe(true);
    const { form } = await openLink(w.plugin, tokenOf(await slash(w.plugin, "web", LARRY)), jar);
    await call(w.plugin, "POST", "/login", { jar, form: form ?? {}, origin: ORIGIN });
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

  it("ends the person's API tokens with their sessions, but only once they next use the web area (#228)", async () => {
    const w = await usrWorld();
    linkLarry(w.dbPath);
    const jar: Jar = new Map([["nz_id", await sign(w.usr.pair.privateKey, identity())]]);
    await call(w.plugin, "GET", "/", { jar });
    const token = await makeToken(w, jar);
    jar.set("nz_id", await sign(w.usr.pair.privateKey, identity({ roles: [] })));
    // The API never reads usr's cookie: the token still works until a web request carries it.
    expect((await api(w.plugin, "GET", "/me", { token })).status).toBe(200);
    expect((await call(w.plugin, "GET", "/", { jar })).status).toBe(403);
    const after = await api(w.plugin, "GET", "/me", { token });
    expect(after.status).toBe(401);
    expect((await after.json()).error.code).toBe("invalid_token");
  });

  it("checks server membership before opening the session", async () => {
    let answer: "member" | "not-member" | null = "not-member";
    const w = await usrWorld({ guild: true, webMembership: async () => answer });
    linkLarry(w.dbPath);
    const token = await sign(w.usr.pair.privateKey, identity());
    const left = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", token]]) });
    expect(left.status).toBe(403);
    const leftText = await left.text();
    expect(leftText).toContain(NOT_MEMBER.slice(0, 30));
    expect(leftText).not.toContain("signed out");
    answer = null;
    const unknown = await call(w.plugin, "GET", "/", { jar: new Map([["nz_id", token]]) });
    expect(await unknown.text()).toContain(USR_RECHECK_FAILED.replace("'", "&#39;"));
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
