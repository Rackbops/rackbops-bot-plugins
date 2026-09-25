import { describe, expect, test } from "bun:test";
import { checkAuth, createRateLimiter } from "./auth.js";

const TOKEN = "a".repeat(43);
const IP = "10.0.0.1";
const NOW = 1_700_000_000_000;

function makeLog() {
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

function request(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set("authorization", header);
  return new Request("http://bridge.local/deliveries", { headers });
}

describe("checkAuth", () => {
  test("a correct bearer token is accepted", () => {
    const { log } = makeLog();
    const result = checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, createRateLimiter(), () => new Date(NOW), log);
    expect(result).toEqual({ ok: true });
  });

  test("a wrong token is refused with 401, logging the clientIp but never the token", () => {
    const { log, calls } = makeLog();
    const result = checkAuth(request(`Bearer ${"b".repeat(43)}`), IP, TOKEN, createRateLimiter(), () => new Date(NOW), log);
    expect(result).toEqual({ ok: false, status: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain(IP);
    expect(calls[0]!.message).not.toContain(TOKEN);
  });

  test("a missing Authorization header is refused with 401", () => {
    const result = checkAuth(request(), IP, TOKEN, createRateLimiter(), () => new Date(NOW), makeLog().log);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("a header without the Bearer scheme is refused with 401", () => {
    const result = checkAuth(request(`Basic ${TOKEN}`), IP, TOKEN, createRateLimiter(), () => new Date(NOW), makeLog().log);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("an empty bearer token is refused with 401", () => {
    const result = checkAuth(request("Bearer "), IP, TOKEN, createRateLimiter(), () => new Date(NOW), makeLog().log);
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("a token of a different length than expected is refused, not thrown", () => {
    const result = checkAuth(request("Bearer short"), IP, TOKEN, createRateLimiter(), () => new Date(NOW), makeLog().log);
    expect(result).toEqual({ ok: false, status: 401 });
  });
});

describe("checkAuth: rate limit (decision 3)", () => {
  test("10 failures in a minute are each 401; the 11th is still 401; the 12th is 429 even with the right token", () => {
    const limiter = createRateLimiter();
    const log = makeLog().log;
    const now = () => new Date(NOW);
    for (let i = 0; i < 11; i++) {
      const result = checkAuth(request("Bearer wrong"), IP, TOKEN, limiter, now, log);
      expect(result).toEqual({ ok: false, status: 401 });
    }
    const twelfth = checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log);
    expect(twelfth).toEqual({ ok: false, status: 429 });
  });

  test("a locked-out clientIp stays locked for further requests within the same window", () => {
    const limiter = createRateLimiter();
    const log = makeLog().log;
    const now = () => new Date(NOW);
    for (let i = 0; i < 11; i++) checkAuth(request("Bearer wrong"), IP, TOKEN, limiter, now, log);
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log)).toEqual({ ok: false, status: 429 });
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log)).toEqual({ ok: false, status: 429 });
  });

  test("the lockout clears once the window has elapsed", () => {
    const limiter = createRateLimiter();
    const log = makeLog().log;
    for (let i = 0; i < 11; i++) checkAuth(request("Bearer wrong"), IP, TOKEN, limiter, () => new Date(NOW), log);
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, () => new Date(NOW), log)).toEqual({
      ok: false,
      status: 429,
    });
    const afterWindow = () => new Date(NOW + 60_000);
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, afterWindow, log)).toEqual({ ok: true });
  });

  test("two clientIps are tracked independently", () => {
    const limiter = createRateLimiter();
    const log = makeLog().log;
    const now = () => new Date(NOW);
    for (let i = 0; i < 11; i++) checkAuth(request("Bearer wrong"), IP, TOKEN, limiter, now, log);
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log)).toEqual({ ok: false, status: 429 });
    expect(checkAuth(request(`Bearer ${TOKEN}`), "10.0.0.2", TOKEN, limiter, now, log)).toEqual({ ok: true });
  });

  test("a successful auth never counts as a failure", () => {
    const limiter = createRateLimiter();
    const log = makeLog().log;
    const now = () => new Date(NOW);
    for (let i = 0; i < 20; i++) checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log);
    expect(checkAuth(request(`Bearer ${TOKEN}`), IP, TOKEN, limiter, now, log)).toEqual({ ok: true });
  });
});
