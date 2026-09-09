// Test-only support: a faithful HostStorage implementation and a fake HostApi builder. The plugin
// uses `host.storage` at runtime (the bot provides it — src/storage.ts), so it ships no storage of
// its own; these are a copy of those primitives living in TEST code, so the plugin's tests exercise
// real atomic writes and real read-modify-write serialization without importing across repos. A copy
// of warbandeer's test-host, with the fake host's default name set to "wow".
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { HostApi, HostStorage } from "../../../packages/api/contract.js";

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

/** A fake HostApi for tests. `dataDir` defaults to a throwaway string (createPlugin never touches
 * the filesystem; only activate() does, and tests that reach activate pass a real temp dataDir). */
export function makeFakeHost(overrides: Partial<HostApi> = {}): HostApi {
  return {
    name: "wow",
    env: {},
    dataDir: "/tmp/wow-fake-datadir",
    log: { info() {}, warn() {}, error() {} },
    storage: makeRealStorage(),
    announce: async () => {},
    ...overrides,
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
