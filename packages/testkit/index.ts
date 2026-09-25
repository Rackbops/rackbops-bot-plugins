// Test-only support shared across every plugin: a faithful HostStorage implementation, a fake
// HostApi builder, and a fake component/modal interaction builder. A plugin uses `host.storage` at
// runtime (the bot provides it — rackbops-discord-bot's src/storage.ts), so it ships no storage of
// its own; these are a copy of those primitives living in TEST code, so a plugin's tests exercise
// real atomic writes and real read-modify-write serialization (the concurrency regression the bot's
// server.test.ts/characters.test.ts guard) without importing across repos.
//
// This module is NOT published — it lives under packages/ (like packages/api/), is imported only by
// `*.test.ts`, and never enters a plugin's `dist` bundle (build-plugins bundles src/index.ts only).
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { HostApi, HostDelivery, HostMappedDestination, HostMessage, HostStorage } from "../api/contract.js";

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
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
