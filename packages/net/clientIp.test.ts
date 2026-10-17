// Direct unit tests for the shared client-IP trust boundary (#69). Each listener's own
// server.test.ts covers the REAL Bun.serve wiring end to end; these pin the pure decision logic
// itself, one case at a time, with a fake DNS lookup and a fake clock so nothing here touches a
// real resolver or a real timer.
import { describe, expect, test } from "bun:test";
import { clientIpFrom, createTrustedProxy } from "./clientIp.js";

function fakeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://test.invalid/", { headers });
}

describe("createTrustedProxy / isTrusted", () => {
  test("header trusted only when the peer is a resolved proxy address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
    expect(proxy.isTrusted("10.0.0.6")).toBe(false);
  });

  test("header ignored from an untrusted peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, "10.0.0.99", proxy)).toBe("10.0.0.99");
  });

  // Round-2 gate finding: `Bun.serve` with no explicit `hostname` (every call site in this repo)
  // binds dual-stack, and reports a REAL IPv4 peer's address in IPv4-mapped-IPv6 notation
  // (`::ffff:x.x.x.x`) -- confirmed directly against a live listener, not assumed. `dns.lookup`
  // never returns that notation, so both directions of the mismatch need their own case.
  test("an IPv4-mapped-IPv6 peer address (Bun's dual-stack notation) still matches a plain IPv4 "
    + "resolved address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("::ffff:10.0.0.5")).toBe(true);
    expect(proxy.isTrusted("::ffff:10.0.0.6")).toBe(false);
  });

  test("a resolved address that itself comes back mapped still matches a plain IPv4 peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["::ffff:10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("invalid header value falls back to the peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "not-an-ip" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });

  test("unset host: never trusted, no throw", async () => {
    const proxy = createTrustedProxy({ host: undefined });
    await proxy.refresh(); // must not throw even though there's nothing to resolve
    expect(proxy.isTrusted("10.0.0.5")).toBe(false);
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });

  test("a miss triggers at most one refresh per 60 s", async () => {
    let calls = 0;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh(); // the explicit startup refresh -- 1 call
    expect(calls).toBe(1);

    // A miss (a peer that never resolves) at t=0: still within the throttle window of the startup
    // refresh (which just ran at t=0), so it must NOT trigger a second call.
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve(); // let the fire-and-forget microtask (if any) settle
    expect(calls).toBe(1);

    // Advance past the 60s throttle window; the next miss must trigger exactly one more call.
    now = 60_000;
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve();
    expect(calls).toBe(2);

    // Immediately after, still within THIS new window: no third call yet.
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("a resolution failure leaves the previous address set in place, not thrown", async () => {
    let shouldFail = false;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        if (shouldFail) throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);

    shouldFail = true;
    now = 60_000;
    await proxy.refresh(); // an explicit refresh call still surfaces no throw
    expect(proxy.isTrusted("10.0.0.5")).toBe(true); // old set kept, not cleared
  });
});

describe("createTrustedProxy / refresh behaviour", () => {
  test("a successful refresh replaces the address set rather than adding to it", async () => {
    let answer = ["10.0.0.5"];
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => answer });
    await proxy.refresh();
    answer = ["10.0.0.7"];
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.7")).toBe(true);
    expect(proxy.isTrusted("10.0.0.5")).toBe(false);
  });

  test("concurrent refreshes share one in-flight lookup", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        await gate;
        return ["10.0.0.5"];
      },
    });
    const a = proxy.refresh();
    const b = proxy.refresh();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("a failed first refresh is retried by the next miss after the short backoff, not the full 60 s", async () => {
    let calls = 0;
    let now = 1_000;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh(); // startup refresh fails; set stays empty
    expect(calls).toBe(1);
    expect(proxy.isTrusted("10.0.0.5")).toBe(false);

    // Inside the backoff window: no retry yet.
    now += 4_999;
    expect(proxy.isTrusted("10.0.0.5")).toBe(false);
    await Promise.resolve();
    expect(calls).toBe(1);

    // At the backoff: the miss triggers the retry, which succeeds; a later request is trusted.
    now += 1;
    expect(proxy.isTrusted("10.0.0.5")).toBe(false); // this very request still answers from the old set
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("repeated failures with an empty set are retried at most once per backoff window", async () => {
    let calls = 0;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        throw new Error("ENOTFOUND");
      },
      now: () => now,
    });
    await proxy.refresh();
    expect(calls).toBe(1);
    now = 5_000;
    proxy.isTrusted("10.0.0.99");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    proxy.isTrusted("10.0.0.99"); // same instant: throttled again
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  test("a failure with a non-empty set keeps the full 60 s throttle", async () => {
    let calls = 0;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        if (calls === 2) throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh();
    now = 60_000;
    await proxy.refresh(); // fails, old set kept
    expect(calls).toBe(2);
    now = 65_000;
    proxy.isTrusted("10.0.0.99");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });
});

describe("clientIpFrom", () => {
  test("a trusted peer with a single valid header value is keyed by it", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    expect(clientIpFrom(fakeRequest({ "CF-Connecting-IP": "203.0.113.9" }), "10.0.0.5", proxy)).toBe("203.0.113.9");
    expect(clientIpFrom(fakeRequest({ "CF-Connecting-IP": "  203.0.113.9 " }), "10.0.0.5", proxy)).toBe("203.0.113.9");
    expect(clientIpFrom(fakeRequest({ "CF-Connecting-IP": "2001:db8::1" }), "10.0.0.5", proxy)).toBe("2001:db8::1");
  });

  // Cloudflare sets the header to one value, so a multi-valued one is untrusted whole -- even when
  // every element is a valid IP (the old behaviour returned the first).
  test("a multi-valued header is untrusted and falls back to the peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    for (const value of ["203.0.113.9, 10.0.0.5", "203.0.113.9,10.0.0.5", "not-an-ip, 203.0.113.9", "203.0.113.9,"]) {
      expect(clientIpFrom(fakeRequest({ "CF-Connecting-IP": value }), "10.0.0.5", proxy)).toBe("10.0.0.5");
    }
  });

  test("header forms that are not a bare IP literal fall back to the peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    for (const value of ["[2001:db8::1]", "203.0.113.9:8080", "", "999.1.1.1"]) {
      expect(clientIpFrom(fakeRequest({ "CF-Connecting-IP": value }), "10.0.0.5", proxy)).toBe("10.0.0.5");
    }
  });

  test("an IPv6 trusted peer and an uppercase mapped-IPv4 peer are matched", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5", "2001:db8::5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("2001:db8::5")).toBe(true);
    expect(proxy.isTrusted("::FFFF:10.0.0.5")).toBe(true);
    expect(proxy.isTrusted("2001:db8::6")).toBe(false);
    const req = fakeRequest({ "CF-Connecting-IP": "2001:db8::1" });
    expect(clientIpFrom(req, "2001:db8::5", proxy)).toBe("2001:db8::1");
  });

  test("no peer address at all falls back to \"unknown\"", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, undefined, proxy)).toBe("unknown");
  });

  test("a trusted peer with no header at all falls back to the peer address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest();
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });
});
