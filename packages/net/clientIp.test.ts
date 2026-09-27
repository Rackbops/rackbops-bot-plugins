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

describe("clientIpFrom", () => {
  test("a trusted peer with a valid header is keyed by the header's first value", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9, 10.0.0.5" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("203.0.113.9");
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
