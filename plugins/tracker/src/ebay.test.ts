import { describe, expect, it } from "bun:test";
import { ebayRequest } from "@rackbops/docket-types";
import { createEbayBrowse, EBAY_API, EBAY_SCOPE, EBAY_TOKEN_PATH, parseEbayKeys } from "./ebay.js";

const ID = "RodApp-PRD-0123456789-abcdef01";
const SECRET = "PRD-0123456789ab-cdef-0123-4567";
const keys = { clientId: ID, clientSecret: SECRET };
const request = ebayRequest({ query: "Wingspan Oceania expansion", maxPrice: 35 });
const tokenAnswer = (token: string, seconds = 7200) => new Response(JSON.stringify({ access_token: token, expires_in: seconds, token_type: "Application Access Token" }), { status: 200 });
const searchAnswer = () => new Response(JSON.stringify({ total: 0 }), { status: 200 });

type Call = { url: string; init: RequestInit };
function ebay(respond: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call, calls);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const isToken = (c: Call) => c.url === `${EBAY_API}${EBAY_TOKEN_PATH}`;
const auth = (c: Call | undefined) => (c?.init.headers as Record<string, string> | undefined)?.authorization;

describe("parseEbayKeys", () => {
  it("is null with neither set, the pair trimmed with both", () => {
    expect(parseEbayKeys({})).toBeNull();
    expect(parseEbayKeys({ TRACKER_EBAY_CLIENT_ID: " ", TRACKER_EBAY_CLIENT_SECRET: "" })).toBeNull();
    expect(parseEbayKeys({ TRACKER_EBAY_CLIENT_ID: ` ${ID}\n`, TRACKER_EBAY_CLIENT_SECRET: SECRET })).toEqual(keys);
  });

  it("refuses one without the other, and a value outside visible ASCII, naming the setting and never the value", () => {
    const problems = [
      { TRACKER_EBAY_CLIENT_ID: ID },
      { TRACKER_EBAY_CLIENT_SECRET: SECRET },
      { TRACKER_EBAY_CLIENT_ID: `${ID} x`, TRACKER_EBAY_CLIENT_SECRET: SECRET },
      { TRACKER_EBAY_CLIENT_ID: ID, TRACKER_EBAY_CLIENT_SECRET: `${SECRET}“` },
    ];
    for (const env of problems) {
      let message = "";
      try {
        parseEbayKeys(env);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("TRACKER_EBAY_CLIENT_");
      expect(message).not.toContain("PRD-");
    }
  });
});

describe("createEbayBrowse", () => {
  it("mints an app token with the keys, then searches with it on eBay US, following no redirect", async () => {
    const { calls, fetchImpl } = ebay((c) => (isToken(c) ? tokenAnswer("tok-1") : searchAnswer()));
    const browse = createEbayBrowse({ keys, fetchImpl });
    expect(await browse(request)).toEqual({ status: 200, body: { total: 0 } });
    expect(calls).toHaveLength(2);
    const [mint, search] = calls;
    expect(mint?.init.method).toBe("POST");
    expect(auth(mint)).toBe(`Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
    expect(new URLSearchParams(String(mint?.init.body)).get("scope")).toBe(EBAY_SCOPE);
    expect(new URLSearchParams(String(mint?.init.body)).get("grant_type")).toBe("client_credentials");
    const url = new URL(String(search?.url));
    expect(url.origin + url.pathname).toBe("https://api.ebay.com/buy/browse/v1/item_summary/search");
    expect(url.searchParams.get("q")).toBe("Wingspan Oceania expansion");
    expect(url.searchParams.get("filter")).toBe("price:[..35.00],priceCurrency:USD");
    expect(auth(search)).toBe("Bearer tok-1");
    expect((search?.init.headers as Record<string, string>)["x-ebay-c-marketplace-id"]).toBe("EBAY_US");
    for (const c of calls) expect(c.init.redirect).toBe("manual");
  });

  it("keeps the token until a minute before it ends, and shares one minting between looks that start together", async () => {
    let t = 0;
    const { calls, fetchImpl } = ebay((c, all) => (isToken(c) ? tokenAnswer(`tok-${all.filter(isToken).length}`, 3600) : searchAnswer()));
    const browse = createEbayBrowse({ keys, fetchImpl, now: () => t });
    await Promise.all([browse(request), browse(request)]);
    expect(calls.filter(isToken)).toHaveLength(1);
    t = 3600_000 - 61_000;
    await browse(request);
    expect(calls.filter(isToken)).toHaveLength(1);
    t = 3600_000 - 59_000;
    await browse(request);
    expect(calls.filter(isToken)).toHaveLength(2);
    expect(auth(calls.at(-1))).toBe("Bearer tok-2");
  });

  it("mints once more when a search answers 401, and that answer stands", async () => {
    const { calls, fetchImpl } = ebay((c, all) => {
      if (isToken(c)) return tokenAnswer(`tok-${all.filter(isToken).length}`);
      return auth(c) === "Bearer tok-1" ? new Response("{}", { status: 401 }) : searchAnswer();
    });
    const browse = createEbayBrowse({ keys, fetchImpl });
    expect((await browse(request)).status).toBe(200);
    expect(calls.map((c) => (isToken(c) ? "mint" : auth(c)))).toEqual(["mint", "Bearer tok-1", "mint", "Bearer tok-2"]);
    const still = ebay((c) => (isToken(c) ? tokenAnswer("tok") : new Response("{}", { status: 401 })));
    expect((await createEbayBrowse({ keys, fetchImpl: still.fetchImpl })(request)).status).toBe(401);
    expect(still.calls).toHaveLength(4);
  });

  it("answers 401 when eBay refuses the keys, so the owner hears at once", async () => {
    const { calls, fetchImpl } = ebay(() => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    expect(await createEbayBrowse({ keys, fetchImpl })(request)).toEqual({ status: 401, body: null });
    expect(calls).toHaveLength(1);
  });

  it("says only what went wrong, in fixed words: never the runtime's, which can quote a key or the token", async () => {
    const failing = ebay(() => {
      throw new TypeError(`Header 'authorization' has invalid value: 'Basic ${SECRET}'`);
    });
    const err = await createEbayBrowse({ keys, fetchImpl: failing.fetchImpl })(request).catch((e: Error) => e);
    expect((err as Error).message).toBe("eBay could not be reached");
    const busy = ebay(() => new Response("<html>down</html>", { status: 503 }));
    const down = await createEbayBrowse({ keys, fetchImpl: busy.fetchImpl })(request).catch((e: Error) => e);
    expect((down as Error).message).toBe("eBay's token service answered HTTP 503");
    const odd = ebay(() => new Response(JSON.stringify({ access_token: "has space", expires_in: 7200 }), { status: 200 }));
    const none = await createEbayBrowse({ keys, fetchImpl: odd.fetchImpl })(request).catch((e: Error) => e);
    expect((none as Error).message).toBe("eBay's token service gave no token");
  });

  it("gives up on a search that does not answer in time", async () => {
    const { fetchImpl } = ebay((c) =>
      isToken(c)
        ? tokenAnswer("tok")
        : new Promise<Response>((_, reject) => {
            (c.init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
    );
    const err = await createEbayBrowse({ keys, fetchImpl, timeoutMs: 20 })(request).catch((e: Error) => e);
    expect((err as Error).message).toBe("eBay did not answer in time");
  });
});
