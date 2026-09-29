import { describe, expect, it } from "bun:test";
import { createPageFetch, FetchRefusedError, isPublicAddress, MAX_REDIRECTS, urlProblem } from "./fetch.js";

/** The price tracker's page reads (rackbops-bot-plugins#81): only the public internet, bounded. */

describe("isPublicAddress", () => {
  it("refuses every private, local and reserved range, IPv4 and IPv6", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.168.1.10",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
      "2002:c0a8:0101::1",
      "not an address",
    ]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    }
  });

  it("allows public unicast", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2606:4700:4700::1111"]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    }
  });
});

describe("urlProblem", () => {
  it("allows a plain public http or https page", () => {
    expect(urlProblem("https://shop.example/widget?id=3")).toBeNull();
    expect(urlProblem("http://shop.example/")).toBeNull();
    expect(urlProblem("https://[2606:4700:4700::1111]/")).toBeNull();
  });

  it("refuses other schemes, ports, credentials, local names and private literals", () => {
    expect(urlProblem("not a url")).toBe("That is not a web address.");
    expect(urlProblem("ftp://shop.example/")).toBe("Only http and https pages can be tracked.");
    expect(urlProblem("https://me:pw@shop.example/")).toContain("user name or password");
    expect(urlProblem("https://shop.example:8080/")).toBe("Only pages on the standard web ports can be tracked.");
    for (const u of ["http://localhost/", "http://api.localhost/", "http://nas.local/", "http://x.internal/", "http://127.0.0.1/", "http://[::1]/", "http://10.0.0.5/"]) {
      expect([u, urlProblem(u)]).toEqual([u, "Only public web pages can be tracked."]);
    }
  });
});

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`no route for ${url}`);
    return route();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PUBLIC = async () => ["93.184.215.14"];

describe("createPageFetch", () => {
  it("reads a page with its own user agent and manual redirects", async () => {
    const f = fakeFetch({ "https://shop.example/": () => new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } }) });
    const response = await createPageFetch({ resolve: PUBLIC, fetchImpl: f.impl }).get("https://shop.example/");
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/html" });
    expect(response.body).toContain("ok");
    expect(response.body).not.toContain("<");
    expect(f.calls[0]?.init?.redirect).toBe("manual");
    expect((f.calls[0]?.init?.headers as Record<string, string>)["user-agent"]).toContain("RackbopsClerk");
  });

  it("refuses a name that resolves to any private address, before sending anything", async () => {
    const f = fakeFetch({});
    const reader = createPageFetch({ resolve: async () => ["93.184.215.14", "10.0.0.1"], fetchImpl: f.impl });
    await expect(reader.get("https://shop.example/")).rejects.toThrow(FetchRefusedError);
    await expect(reader.get("https://shop.example/")).rejects.toThrow("shop.example is not on the public internet");
    const unresolved = createPageFetch({ resolve: async () => Promise.reject(new Error("ENOTFOUND")), fetchImpl: f.impl });
    await expect(unresolved.get("https://nowhere.example/")).rejects.toThrow("did not resolve");
    expect(f.calls).toHaveLength(0);
  });

  it("follows a redirect to a public page, and refuses one to a private address or a loop", async () => {
    const f = fakeFetch({
      "https://shop.example/a": () => new Response(null, { status: 301, headers: { location: "/b" } }),
      "https://shop.example/b": () => new Response("price 5", { status: 200 }),
      "https://shop.example/evil": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
      "https://shop.example/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    });
    const reader = createPageFetch({ resolve: PUBLIC, fetchImpl: f.impl });
    expect((await reader.get("https://shop.example/a")).body).toBe("price 5");
    await expect(reader.get("https://shop.example/evil")).rejects.toThrow("Only public web pages can be tracked.");
    await expect(reader.get("https://shop.example/loop")).rejects.toThrow(`more than ${MAX_REDIRECTS} redirects`);
    expect(f.calls.filter((c) => c.url === "http://127.0.0.1/admin")).toHaveLength(0);
  });

  it("keeps at most maxBytes of the body", async () => {
    const f = fakeFetch({ "https://shop.example/big": () => new Response("x".repeat(10_000), { status: 200 }) });
    const response = await createPageFetch({ resolve: PUBLIC, fetchImpl: f.impl, maxBytes: 1000 }).get("https://shop.example/big");
    expect(response.body.length).toBe(1000);
  });

  it("stops a read when the tick's signal aborts", async () => {
    const controller = new AbortController();
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const pending = createPageFetch({ resolve: PUBLIC, fetchImpl: impl, signal: controller.signal }).get("https://shop.example/");
    await Bun.sleep(5); // the read is in flight
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    // A read that starts after the abort never goes out.
    await expect(createPageFetch({ resolve: PUBLIC, fetchImpl: impl, signal: controller.signal }).get("https://shop.example/")).rejects.toThrow();
  });
});
