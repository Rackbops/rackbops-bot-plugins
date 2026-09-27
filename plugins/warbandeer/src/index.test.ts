import { describe, expect, test } from "bun:test";
import { createPlugin } from "./index.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { startWarbandeerServer, warbandeerServerRunning } from "./server.js";

function makeCapturingLog() {
  const calls: { level: "info" | "warn" | "error"; message: string }[] = [];
  return {
    log: {
      info: (m: string) => calls.push({ level: "info", message: m }),
      warn: (m: string) => calls.push({ level: "warn", message: m }),
      error: (m: string) => calls.push({ level: "error", message: m }),
    },
    calls,
  };
}

// #184: dispose() is activate()'s counterpart, called once by the host on the way out (a docker
// stop, a self-update's retire, SIGINT) so this plugin's ingest server doesn't outlive the process
// that opened it.
describe("dispose (#184)", () => {
  test("is a no-op when the connector was never configured (no WARBANDEER_INGEST_PORT)", async () => {
    const { log, calls } = makeCapturingLog();
    const plugin = createPlugin(makeFakeHost({ name: "warbandeer", env: {}, log }));
    await plugin.activate?.();
    await expect(plugin.dispose?.()).resolves.toBeUndefined();
    expect(calls.some((c) => c.message.includes("ingest server stopped"))).toBe(false);
  });

  test("is a no-op when dispose is called without activate ever having run", async () => {
    const { log } = makeCapturingLog();
    const plugin = createPlugin(makeFakeHost({ name: "warbandeer", env: { WARBANDEER_INGEST_PORT: "8787" }, log }));
    await expect(plugin.dispose?.()).resolves.toBeUndefined();
  });

  test("is a no-op when activate() failed to bind the port — nothing was actually opened to close", async () => {
    const { log, calls } = makeCapturingLog();
    // Grab a real free port, then hold it open with an unrelated listener so this plugin's own
    // activate() collides with a real EADDRINUSE — the same failure mode its own try/catch names.
    const blocker = startWarbandeerServer(0);
    try {
      const plugin = createPlugin(makeFakeHost({ name: "warbandeer", env: { WARBANDEER_INGEST_PORT: String(blocker.port) }, log }));
      await plugin.activate?.();
      expect(calls.some((c) => c.level === "error" && c.message.includes("connector failed to start"))).toBe(true);
      await expect(plugin.dispose?.()).resolves.toBeUndefined();
      expect(calls.some((c) => c.message.includes("ingest server stopped"))).toBe(false);
    } finally {
      blocker.stop();
    }
  });

  test("closes the real ingest server activate() started, and logs the stop", async () => {
    const { log, calls } = makeCapturingLog();
    // Grab a real free port up front (port 0 = OS-assigned) — reused as this plugin's own fixed
    // WARBANDEER_INGEST_PORT, since createPlugin validates the env value as a specific port number,
    // not 0. A narrow release-then-rebind-by-number window (found in review): something else could
    // in principle grab this exact ephemeral port between probe.stop() and activate()'s own bind a
    // few lines below. Accepted as test flakiness risk, not a product concern — no other process
    // competes for ports on this box during a test run, and a spurious failure here would just be a
    // rare rerun, never a masked defect in dispose() itself.
    const probe = startWarbandeerServer(0);
    const freePort = probe.port;
    probe.stop();

    const plugin = createPlugin(makeFakeHost({ name: "warbandeer", env: { WARBANDEER_INGEST_PORT: String(freePort) }, log }));
    await plugin.activate?.();
    expect(warbandeerServerRunning()).toBe(true);
    const beforeDispose = await fetch(`http://localhost:${freePort}/nope`);
    expect(beforeDispose.status).toBe(404); // real listener, really answering

    await plugin.dispose?.();

    // warbandeerServerRunning() is flipped synchronously inside stop() (server.ts's own
    // `serverRunning = false` runs before the underlying `server.stop()` call) — a reliable signal
    // that dispose() actually reached the real stop() function. A live fetch immediately after
    // isn't asserted here: Bun's own socket teardown after `.stop()` is asynchronous and not
    // something this plugin's tests should be timing-sensitive to.
    expect(warbandeerServerRunning()).toBe(false);
    // #69: TRUSTED_PROXY_HOST is unset in this test's env, so activate() logs that FIRST (before
    // ever starting the server), then dispose() logs the stop -- both in the same capturing log.
    expect(calls).toEqual([
      {
        level: "info",
        message: "TRUSTED_PROXY_HOST is not set -- CF-Connecting-IP will never be trusted; every caller shares one rate-limit budget",
      },
      { level: "info", message: "ingest server stopped" },
    ]);
  });
});

/**
 * A gate finding (round 2): the per-listener trust-boundary tests in server.test.ts drive
 * `startWarbandeerServer` directly with an explicitly-injected `TrustedProxy`, which pins that
 * FUNCTION's own wiring but never proves `activate()` actually BUILDS a real proxy from
 * `host.env.TRUSTED_PROXY_HOST` and hands it to that same call -- dropping the 3rd argument in
 * `index.ts` left the whole suite green. This test drives the REAL `createPlugin(...).activate()`
 * unmodified, with a REAL `TrustedProxy` (no fake `lookup` injected) resolving a REAL
 * `TRUSTED_PROXY_HOST=localhost`, so it can only pass if activate()'s own env-to-proxy wiring is
 * intact end to end.
 */
describe("client-IP trust boundary via activate() (#69 gate finding)", () => {
  test("activate() wires its TRUSTED_PROXY_HOST-based proxy into the real listener -- a tunnel "
    + "peer is keyed by CF-Connecting-IP, not a shared identity", async () => {
    const probe = startWarbandeerServer(0);
    const port = probe.port;
    probe.stop();

    const plugin = createPlugin(
      makeFakeHost({ name: "warbandeer", env: { WARBANDEER_INGEST_PORT: String(port), TRUSTED_PROXY_HOST: "localhost" } }),
    );
    await plugin.activate?.();
    try {
      // Real fetch, explicitly to 127.0.0.1 (not "localhost") so the peer address Bun's
      // `srv.requestIP` reports is deterministically the IPv4 loopback -- real DNS resolution of
      // "localhost" on this machine includes that address (confirmed: `dns.lookup("localhost",
      // {all:true})` returns BOTH ::1 and 127.0.0.1), so `TRUSTED_PROXY_HOST=localhost` genuinely
      // trusts this test's own peer, through activate()'s own unmodified proxy.
      const postLink = (cfIp: string) =>
        fetch(`http://127.0.0.1:${port}/link`, { method: "POST", headers: { "CF-Connecting-IP": cfIp } });

      // The real, hardcoded 30/min limiter from createProductionDeps() (server.ts): exhaust ONE
      // identity's budget with 30 requests, confirm the 31st (same identity) is rate-limited, then
      // confirm a DIFFERENT identity still has its own, untouched budget. This sequence can only
      // hold if activate() actually wired its proxy into the listener, keying by the header
      // per-identity -- with the proxy dropped (the round-2 mutation), every request here shares
      // ONE real-peer budget and the 31st AND 32nd would both 429.
      for (let i = 0; i < 30; i += 1) {
        const res = await postLink("203.0.113.50");
        expect(res.status).toBe(400); // "code and accountLabel are required" -- budget still open
      }
      const exhausted = await postLink("203.0.113.50");
      expect(exhausted.status).toBe(429);
      const freshIdentity = await postLink("203.0.113.51");
      expect(freshIdentity.status).toBe(400); // a DIFFERENT header value has its OWN, untouched budget
    } finally {
      await plugin.dispose?.();
    }
  });
});
