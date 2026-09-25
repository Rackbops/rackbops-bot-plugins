// Test-only support shared across every plugin: a faithful HostStorage implementation, a fake
// HostApi builder, and a fake component/modal interaction builder. A plugin uses `host.storage` at
// runtime (the bot provides it — rackbops-discord-bot's src/storage.ts), so it ships no storage of
// its own; these are a copy of those primitives living in TEST code, so a plugin's tests exercise
// real atomic writes and real read-modify-write serialization (the concurrency regression the bot's
// server.test.ts/characters.test.ts guard) without importing across repos.
//
// This module is NOT published — it lives under packages/ (like packages/api/), is imported only by
// `*.test.ts`, and never enters a plugin's `dist` bundle (build-plugins bundles src/index.ts only).
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { HostApi, HostDelivery, HostMappedDestination, HostMessage, HostStorage } from "../api/contract.js";

// Tooling#746 round-3 review: this file's own writeJsonAtomic used a FIXED `${path}.tmp` name for
// every write, unlike the host it claims to faithfully copy (rackbops-discord-bot src/storage.ts,
// #154 + #253) -- two writes to the SAME path (e.g. #742's own startDrain redundant write followed
// by drainAndPersist's final write, both real, both awaited, but still landing close enough together
// under real fs I/O) could race on that one shared tmp file, one writer's rename consuming or
// clobbering the file the other is still writing. Mirrors the host's tmpPathFor exactly (a monotonic
// per-process counter alone isn't enough either -- two containers in a handoff can share a pid and
// both start counting from zero, #253's own fix for #154's gap) so this "faithful copy" comment above
// is actually true of the write path, not just the serialization one. Diagnosed by running the full
// plugins/mcp test suite repeatedly with the swallowed error logged: every failure was an ENOENT or
// EPERM on this function's own renameSync, never a wrong VALUE -- confirming a write-path race, not a
// logic bug in the delivery/edit code that calls it.
let tmpCounter = 0;
const TMP_TOKEN = randomBytes(4).toString("hex");

function tmpPathFor(path: string, pid: number, token: string, counter: number): string {
  return `${path}.${pid}.${token}.${counter}.tmp`;
}

/** Windows-only: renaming onto a destination another handle still has open can throw EPERM/EBUSY/
 *  EACCES even though nothing is logically wrong -- a transient OS-level lock, not a real conflict
 *  (POSIX rename() atomically replaces even an open destination, so this can't happen on Linux, which
 *  is what the host actually runs on; this exists only so the Windows dev loop isn't flaky). A unique
 *  tmp name per write (above) already rules out two WRITERS colliding; this covers a concurrent
 *  READER (`Bun.file(path)`) holding a transient lock on `path` itself at the moment of rename, via a
 *  real `setTimeout` (never a busy-wait -- that would block the whole event loop, starving every
 *  OTHER concurrent read/write in the same process for the entire delay).
 *
 *  The numbers below came from isolated reproduction (`Bun.file(path).json()` polled every 1ms
 *  against 3 sequential real writes to the same path, matching #742's own reserve-then-startDrain-
 *  then-drainAndPersist shape), not a guess: with NO concurrent reader, 6/6 runs of that reproduction
 *  never fail; WITH one, a plain `renameSync` fails outright on most runs, and even a 20-attempt/25ms
 *  (500ms) retry budget still exhausted itself and threw on 2/8 runs. Pushed further, the stuck case
 *  always eventually clears, but the clear time is highly variable -- most retries resolve on attempt
 *  1, one observed run needed attempt 35 (~1.75s @ 50ms apart) -- consistent with Bun's own file
 *  handle release being deferred rather than a real deadlock. 90 attempts / 20ms apart (1.8s total,
 *  under the 2s `waitUntil` timeout the plugin's own tests already use) cleared 8/8 reproduction runs
 *  with margin, worst case 16 attempts. If this ever needs to go even higher, that is real
 *  information about this runtime's GC/handle-release latency, not a sign the approach is wrong. */
async function renameWithRetry(tmp: string, path: string): Promise<void> {
  const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
  const MAX_ATTEMPTS = 90;
  const RETRY_DELAY_MS = 20;
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= MAX_ATTEMPTS || code === undefined || !RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpPathFor(path, process.pid, TMP_TOKEN, ++tmpCounter);
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  await renameWithRetry(tmp, path);
}

async function readJsonOrFresh<T>(path: string, fresh: () => T, label: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fresh();
  try {
    return (await file.json()) as T;
  } catch (err) {
    console.error(`[${label}] ${path} is unreadable or corrupt — starting fresh: ${err}`);
    const corrupt = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corrupt);
    } catch {
      // best effort
    }
    return fresh();
  }
}

/** A faithful copy of the host's storage primitives — the serialized writer and per-path keyed
 * mutator are what make the concurrency tests meaningful, so they must behave like the real thing. */
export function makeRealStorage(): HostStorage {
  return {
    readJsonOrFresh,
    writeJsonAtomic,
    createJsonWriter<T>(path: string) {
      let chain: Promise<void> = Promise.resolve();
      return {
        save(data: T): Promise<void> {
          const next = chain.then(
            () => writeJsonAtomic(path, data),
            () => writeJsonAtomic(path, data),
          );
          chain = next.catch(() => {});
          return next;
        },
      };
    },
    createKeyedJsonMutator<T>() {
      const chains = new Map<string, Promise<void>>();
      return {
        update(path: string, fresh: () => T, mutate: (current: T) => T, label: string): Promise<void> {
          const prior = chains.get(path) ?? Promise.resolve();
          const run = () => readJsonOrFresh<T>(path, fresh, label).then((current) => writeJsonAtomic(path, mutate(current)));
          const next = prior.then(run, run);
          chains.set(path, next.catch(() => {}));
          return next;
        },
      };
    },
  };
}

/**
 * A fake HostApi for tests. `name` is required (it was the one field that differed between the
 * per-plugin copies this replaced); `dataDir` defaults to a throwaway string derived from it
 * (createPlugin never touches the filesystem; only activate() does, and tests that reach activate
 * pass a real temp dataDir). Any field can be overridden, including `dataDir`.
 */
export function makeFakeHost(overrides: Partial<HostApi> & { name: string }): HostApi {
  const { name } = overrides;
  return {
    env: {},
    dataDir: `/tmp/${name}-fake-datadir`,
    log: { info() {}, warn() {}, error() {} },
    storage: makeRealStorage(),
    announce: async () => {},
    ...overrides,
  };
}

/** Fixed return values `makeFakeDelivery`'s recorders answer with -- deliberately the same every
 *  call, so a test asserting on a delivery result has one well-known value to check against. */
const FAKE_POST_DELIVERY: HostDelivery = { guildId: "100000000000000001", channelId: "200000000000000001", messageId: "300000000000000001" };
const FAKE_DM_DELIVERY: HostDelivery = { guildId: null, channelId: "200000000000000002", messageId: "300000000000000002" };

/**
 * `post`/`dm`/`edit`/`destinations` recorders (#736) -- spread into `makeFakeHost`'s overrides so a
 * plugin's test can exercise a host that has them wired, without a fake HostApi hand-rolling all
 * four. `makeFakeHost` on its own still has none of the four (its defaults are unchanged), so a
 * plugin's tests exercise the degraded, pre-#736 path unless this is explicitly added -- matching
 * how a real host that predates them behaves.
 *
 * Each records its call in `calls`, a property of the object THIS returns, not of the four functions
 * themselves. Spreading that object into `makeFakeHost`'s overrides does copy `calls` onto the host
 * value too (a plain object spread copies every own key) -- but `makeFakeHost`'s `HostApi` return
 * type has no `calls` field, so typed code can never read it back off the host either way. Read
 * `delivery.calls` directly, from the object `makeFakeDelivery()` itself returned, as the example
 * below does. Each answers with a fixed value: `post`/`dm` return the same `HostDelivery` every call (`FAKE_POST_DELIVERY` /
 * `FAKE_DM_DELIVERY`), `edit` resolves with nothing (as the real one does), and `destinations`
 * answers `[]` every call -- a test that needs a specific list overrides `destinations` itself on
 * the object this returns, or on `makeFakeHost`'s overrides directly.
 *
 * ```ts
 * const delivery = makeFakeDelivery();
 * const host = makeFakeHost({ name: "myplugin", ...delivery });
 * await host.post!(guildId, "alerts", { content: "hi" });
 * expect(delivery.calls.post).toEqual([{ guildId, destination: "alerts", message: { content: "hi" } }]);
 * ```
 */
export function makeFakeDelivery(): {
  post: NonNullable<HostApi["post"]>;
  dm: NonNullable<HostApi["dm"]>;
  edit: NonNullable<HostApi["edit"]>;
  destinations: NonNullable<HostApi["destinations"]>;
  calls: {
    post: { guildId: string; destination: string; message: HostMessage }[];
    dm: { userId: string; message: HostMessage }[];
    edit: { delivery: HostDelivery; message: Partial<HostMessage> }[];
    destinations: number;
  };
} {
  const calls = {
    post: [] as { guildId: string; destination: string; message: HostMessage }[],
    dm: [] as { userId: string; message: HostMessage }[],
    edit: [] as { delivery: HostDelivery; message: Partial<HostMessage> }[],
    destinations: 0,
  };
  return {
    calls,
    async post(guildId, destination, message) {
      calls.post.push({ guildId, destination, message });
      return FAKE_POST_DELIVERY;
    },
    async dm(userId, message) {
      calls.dm.push({ userId, message });
      return FAKE_DM_DELIVERY;
    },
    async edit(delivery, message) {
      calls.edit.push({ delivery, message });
    },
    async destinations(): Promise<HostMappedDestination[]> {
      calls.destinations += 1;
      return [];
    },
  };
}

/**
 * #185: a minimal fake component/modal interaction for exercising a plugin's own `interactions`
 * handler in tests -- only the shape the host's real dispatch actually touches (`customId`,
 * `replied`/`deferred`, `reply()`), matching the bot repo's own host.test.ts fake so a plugin's
 * test and the host's own tests exercise the contract the same way.
 */
export function makeFakeInteraction(
  customId: string,
  overrides: Partial<{ replied: boolean; deferred: boolean; reply: (opts: unknown) => Promise<unknown> }> = {},
): MessageComponentInteraction | ModalSubmitInteraction {
  return {
    customId,
    replied: false,
    deferred: false,
    reply: async () => {},
    ...overrides,
  } as unknown as MessageComponentInteraction;
}
