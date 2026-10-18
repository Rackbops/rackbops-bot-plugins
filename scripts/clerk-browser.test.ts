import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "../packages/api/contract.js";
import { cleanup as cleanupWorlds, LARRY, makeToken, people, signIn, world } from "../plugins/tracker/src/web/harness.js";
import { ACCESS_FILE, apiBase, type Deps, headers, listingsProblems, main, pagesProblems, parseAccessToken, parseBearer, pendingJobs, TOKEN_FILE } from "./clerk-browser.js";

/**
 * The clerk-browser-search skill's helper (#125): its secrets are read from files and sent only as
 * headers; its batches are checked before a request is spent; `pending` picks out what waits on the
 * browser; and, end to end through the tracker plugin's own `http` handler, a listing it sends
 * reaches an eBay inbox watch and pages it sends reach a `sources: browser` research request.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await cleanupWorlds();
});

const CITY_HALL = {
  TRACKER_CITY_HALL_URL: "https://city-hall.example.com",
  TRACKER_CITY_HALL_KEY: "source-key-never-logged",
  TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription",
};

const ACCESS = { clientId: "abc.access", clientSecret: "s3cret-never-printed" };

function secretsDir(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clerk-browser-"));
  dirs.push(dir);
  writeFileSync(join(dir, ACCESS_FILE), JSON.stringify(ACCESS));
  writeFileSync(join(dir, TOKEN_FILE), `${token}\r\n`);
  return dir;
}

/** Deps whose fetch is the given handler, with every line printed kept. */
function deps(dir: string, fetchImpl: typeof fetch, files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: Deps = {
    fetch: fetchImpl,
    readFile: async (p) => {
      if (p in files) return files[p] as string;
      return Bun.file(p).text();
    },
    env: { TOOLING_SECRETS_DIR: dir, CLERK_API_URL: "https://clerk.example.com/tracker/api/v1/" },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { d, out, err };
}

/**
 * A fetch that plays Cloudflare Access (no service token -> its sign-in redirect) and then hands the
 * request to the plugin as the host would, recording what reached it.
 */
function throughAccess(plugin: Plugin, seen: Request[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(String(input), init);
    if (req.headers.get("cf-access-client-id") !== ACCESS.clientId || req.headers.get("cf-access-client-secret") !== ACCESS.clientSecret) {
      return new Response(null, { status: 302, headers: { location: "https://rackbops.cloudflareaccess.com/cdn-cgi/access/login" } });
    }
    seen.push(req.clone());
    const path = new URL(req.url).pathname.replace(/^\/tracker/, "");
    return plugin.http!(req, { path, clientIp: "unknown" });
  }) as typeof fetch;
}

describe("secret files", () => {
  it("reads the service token's two fields and refuses anything else", () => {
    expect(parseAccessToken(JSON.stringify(ACCESS), "f")).toEqual(ACCESS);
    expect(() => parseAccessToken("not json", "f")).toThrow("not JSON");
    expect(() => parseAccessToken(JSON.stringify({ clientId: "x" }), "f")).toThrow("clientSecret");
  });

  it("takes one trk_ token with whitespace around it, and nothing else", () => {
    const t = `trk_${"a".repeat(43)}`;
    expect(parseBearer(`  ${t}\n`, "f")).toBe(t);
    expect(() => parseBearer(`${t}x`, "f")).toThrow("trk_");
    expect(() => parseBearer("Bearer something", "f")).toThrow("trk_");
  });

  it("sends both secrets as headers and no Origin", () => {
    const h = headers({ ...ACCESS, bearer: "trk_x" }, true);
    expect(h["CF-Access-Client-Id"]).toBe(ACCESS.clientId);
    expect(h["CF-Access-Client-Secret"]).toBe(ACCESS.clientSecret);
    expect(h.Authorization).toBe("Bearer trk_x");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("origin");
  });
});

describe("batches are checked before they are sent", () => {
  it("listings: 1 to 40, each with a title and an absolute http(s) url", () => {
    expect(listingsProblems({ listings: [{ title: "Brass", url: "https://www.ebay.com/itm/1" }] })).toEqual([]);
    expect(listingsProblems({ items: [] })).toEqual(['the file must hold {"listings": [ ... ]}']);
    expect(listingsProblems({ listings: [] })).toContain("no listings");
    const many = Array.from({ length: 41 }, (_, i) => ({ title: `t${i}`, url: `https://www.ebay.com/itm/${i}` }));
    expect(listingsProblems({ listings: many })[0]).toContain("at most 40");
    expect(listingsProblems({ listings: [{ title: "", url: "/itm/1" }] })).toEqual(["listing 1 has no title", "listing 1 has no absolute http(s) url"]);
  });

  it("pages: 1 to 10, each with an absolute http(s) url and text", () => {
    expect(pagesProblems({ pages: [{ url: "https://boardgamegeek.com/boardgame/1", title: "x", text: "words" }] })).toEqual([]);
    expect(pagesProblems({ pages: Array.from({ length: 11 }, () => ({ url: "https://a.example/", text: "x" })) })[0]).toContain("at most 10");
    expect(pagesProblems({ pages: [{ url: "javascript:alert(1)", text: " " }] })).toEqual(["page 1 has no absolute http(s) url", "page 1 has no text"]);
  });

  it("long pages are cut before the 1 MiB check, so ten of them still go", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ url: `https://boardgamegeek.com/boardgame/${i}`, title: "t", text: "x".repeat(150_000) }));
    const { d } = deps("/nowhere", (async () => new Response("{}")) as unknown as typeof fetch, { "p.json": JSON.stringify({ pages }) });
    // Past the batch checks, it stops at the missing secrets: no "over 1 MiB" refusal.
    const errs: string[] = [];
    d.err = (l) => errs.push(l);
    expect(await main(["sources", "t1", "p.json"], d)).toBe(2);
    expect(errs[0]).toStartWith("cannot read ");
  });

  it("a bad batch spends no request and needs no secrets", async () => {
    let calls = 0;
    const { d, err } = deps("/nowhere", (async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch, { "batch.json": JSON.stringify({ listings: [] }) });
    expect(await main(["listings", "t1", "batch.json"], d)).toBe(64);
    expect(calls).toBe(0);
    expect(err).toEqual(["no listings"]);
  });
});

describe("never leaks a secret", () => {
  it("a secret file passed as a batch is refused without echoing what it holds", async () => {
    const token = `trk_${"S".repeat(43)}`;
    const { d, err } = deps("/nowhere", (async () => new Response("{}")) as unknown as typeof fetch, { "token.txt": token });
    expect(await main(["sources", "t1", "token.txt"], d)).toBe(64);
    expect(err).toEqual(["cannot read token.txt as JSON"]);
  });

  it("sends secrets over https only, http for localhost alone", () => {
    expect(apiBase({})).toBe("https://clerk.rackbops.com/tracker/api/v1");
    expect(apiBase({ CLERK_API_URL: "http://clerk.rackbops.com/tracker/api/v1" })).toBeNull();
    expect(apiBase({ CLERK_API_URL: "http://localhost:3000/tracker/api/v1/" })).toBe("http://localhost:3000/tracker/api/v1");
    expect(apiBase({ CLERK_API_URL: "not a url" })).toBeNull();
  });
});

describe("pending", () => {
  it("keeps active inbox watches and research requests waiting for pages, nothing else", () => {
    const jobs = pendingJobs({
      tasks: [
        { id: "t1", type: "wantlist", title: "Brass", status: "active", source: "inbox", site: "ebay", search: "brass birmingham", settings: { max: 60, currency: "USD" } },
        { id: "t2", type: "wantlist", title: "Paused", status: "paused", source: "inbox", site: "ebay", settings: {} },
        { id: "t3", type: "wantlist", title: "A shop", status: "active", source: "page", settings: {} },
        { id: "t4", type: "research", title: "best 2026", status: "active", sources: "browser", pages: 0, waitingForPages: true, blocked: [], settings: { question: "best 2026?", sources: "browser" } },
        { id: "t5", type: "research", title: "ran", status: "active", sources: "browser", pages: 3, waitingForPages: false, blocked: [], settings: { question: "q" } },
        { id: "t6", type: "research", title: "fuller", status: "active", sources: "web", pages: 0, waitingForPages: true, blocked: [{ site: "BoardGameGeek", url: "https://boardgamegeek.com/x", why: "403" }], settings: { question: "q6" } },
        { id: "t7", type: "reminder", title: "plants", status: "active", settings: {} },
      ],
    });
    expect(jobs.map((j) => j.id)).toEqual(["t1", "t4", "t6"]);
    expect(jobs[0]).toEqual({ kind: "listings", id: "t1", title: "Brass", site: "ebay", search: "brass birmingham", max: 60, currency: "USD" });
    expect(jobs[1]).toMatchObject({ kind: "research", question: "best 2026?", fullerPass: false, pages: 0 });
    expect(jobs[2]).toMatchObject({ kind: "research", fullerPass: true, blocked: [{ site: "BoardGameGeek" }] });
  });
});

describe("end to end through the tracker's task API", () => {
  async function setup(env: Record<string, string> = {}) {
    const cityHallFetch = (async () => Response.json({ error: "not expected" }, { status: 500 })) as unknown as typeof fetch;
    const w = await world({ env, cityHallFetch });
    await people(w.plugin);
    const larry = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, larry);
    return { ...w, token, dir: secretsDir(token) };
  }

  it("check proves both secrets; a wrong service token is named as Access's refusal", async () => {
    const w = await setup();
    const ok = deps(w.dir, throughAccess(w.plugin));
    expect(await main(["check"], ok.d)).toBe(0);
    expect(ok.out[0]).toStartWith("ok: the task API answers as ");

    writeFileSync(join(w.dir, ACCESS_FILE), JSON.stringify({ clientId: "abc.access", clientSecret: "Zq9-not-the-secret" }));
    const bad = deps(w.dir, throughAccess(w.plugin));
    expect(await main(["check"], bad.d)).toBe(2);
    expect(bad.err[0]).toContain("Cloudflare Access sent the request to its sign-in page");
    expect(bad.err.join("\n")).not.toContain("Zq9-not-the-secret");
  });

  it("finds an eBay inbox watch and sends it a listing the watch keeps", async () => {
    const w = await setup();
    const seen: Request[] = [];
    const fetchImpl = throughAccess(w.plugin, seen);
    const made = await fetchImpl("https://clerk.example.com/tracker/api/v1/tasks", {
      method: "POST",
      headers: headers({ ...ACCESS, bearer: w.token }, true),
      body: JSON.stringify({ type: "wantlist", name: "Brass", source: "ebay", target: "brass birmingham", max: 60, judge: "no" }),
    });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { task: { id: string } }).task.id;

    const p = deps(w.dir, fetchImpl);
    expect(await main(["pending"], p.d)).toBe(0);
    const jobs = JSON.parse(p.out[0] as string);
    expect(jobs).toEqual([expect.objectContaining({ kind: "listings", id, site: "ebay", search: "brass birmingham", max: 60 })]);

    const file = join(w.dir, "listings.json");
    writeFileSync(file, JSON.stringify({ listings: [{ title: "Brass: Birmingham, new", url: "https://www.ebay.com/itm/123456789?hash=x", price: "$45.00", currency: "USD" }] }));
    const s = deps(w.dir, fetchImpl);
    expect(await main(["listings", id, file], s.d)).toBe(0);
    expect(JSON.parse(s.out[0] as string)).toMatchObject({ accepted: 1, rejected: 0 });
    // The secrets travel only as headers: no URL or body the helper sent carries them.
    for (const r of seen) {
      expect(r.url).not.toContain(ACCESS.clientSecret);
      expect(r.headers.get("origin")).toBeNull();
      expect(await r.text()).not.toContain(w.token);
    }
  });

  it("a listing posted to an id that is not an inbox watch is the API's refusal, exit 1", async () => {
    const w = await setup();
    const file = join(w.dir, "listings.json");
    writeFileSync(file, JSON.stringify({ listings: [{ title: "x", url: "https://www.ebay.com/itm/1" }] }));
    const s = deps(w.dir, throughAccess(w.plugin));
    expect(await main(["listings", "t999", file], s.d)).toBe(1);
    expect(s.err[0]).toStartWith("404 ");
  });

  it("finds a sources: browser research request, sends it pages and starts it", async () => {
    const w = await setup(CITY_HALL);
    const seen: Request[] = [];
    const fetchImpl = throughAccess(w.plugin, seen);
    const made = await fetchImpl("https://clerk.example.com/tracker/api/v1/tasks", {
      method: "POST",
      headers: headers({ ...ACCESS, bearer: w.token }, true),
      body: JSON.stringify({ type: "research", question: "what is the best boardgame released in 2026, in each of the major categories.", sources: "browser" }),
    });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { task: { id: string } }).task.id;

    const p = deps(w.dir, fetchImpl);
    expect(await main(["pending"], p.d)).toBe(0);
    expect(JSON.parse(p.out[0] as string)).toEqual([expect.objectContaining({ kind: "research", id, fullerPass: false, pages: 0, blocked: [] })]);

    // A page longer than the API keeps is cut to 12,000 characters before it is sent.
    const file = join(w.dir, "pages.json");
    writeFileSync(file, JSON.stringify({ pages: [{ url: "https://boardgamegeek.com/browse/boardgame", title: "BGG ranks", text: "Strategy: ... ".repeat(2000) }] }));
    const s = deps(w.dir, fetchImpl);
    expect(await main(["sources", id, file], s.d)).toBe(0);
    expect(JSON.parse(s.out[0] as string)).toMatchObject({ accepted: 1, pages: 1 });
    const sent = (await seen.at(-1)?.json()) as { pages: { text: string }[] };
    expect(sent.pages[0]?.text.length).toBe(12_000);

    const r = deps(w.dir, fetchImpl);
    expect(await main(["ready", id], r.d)).toBe(0);
    const after = deps(w.dir, fetchImpl);
    expect(await main(["pending"], after.d)).toBe(0);
    expect(JSON.parse(after.out[0] as string)).toEqual([]);
  });
});
