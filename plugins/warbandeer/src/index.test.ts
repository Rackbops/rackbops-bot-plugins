import { describe, expect, test } from "bun:test";
import { createPlugin } from "./index.js";
import { makeFakeHost } from "./test-host.js";
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
    const plugin = createPlugin(makeFakeHost({ env: {}, log }));
    await plugin.activate?.();
    await expect(plugin.dispose?.()).resolves.toBeUndefined();
    expect(calls.some((c) => c.message.includes("ingest server stopped"))).toBe(false);
  });

  test("is a no-op when dispose is called without activate ever having run", async () => {
    const { log } = makeCapturingLog();
    const plugin = createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: "8787" }, log }));
    await expect(plugin.dispose?.()).resolves.toBeUndefined();
  });

  test("is a no-op when activate() failed to bind the port — nothing was actually opened to close", async () => {
    const { log, calls } = makeCapturingLog();
    // Grab a real free port, then hold it open with an unrelated listener so this plugin's own
    // activate() collides with a real EADDRINUSE — the same failure mode its own try/catch names.
    const blocker = startWarbandeerServer(0);
    try {
      const plugin = createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: String(blocker.port) }, log }));
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

    const plugin = createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: String(freePort) }, log }));
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
    expect(calls).toEqual([{ level: "info", message: "ingest server stopped" }]);
  });
});
