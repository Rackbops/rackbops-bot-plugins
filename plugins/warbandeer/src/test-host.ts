// Test-only support: a faithful HostStorage implementation and a fake HostApi builder. The plugin
// uses `host.storage` at runtime (the bot provides it — src/storage.ts), so it ships no storage of
// its own; these are a copy of those primitives living in TEST code, so the plugin's tests exercise
// real atomic writes and real read-modify-write serialization (the concurrency regression the bot's
// server.test.ts/characters.test.ts guard) without importing across repos.
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
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
    name: "warbandeer",
    env: {},
    dataDir: "/tmp/warbandeer-fake-datadir",
    log: { info() {}, warn() {}, error() {} },
    storage: makeRealStorage(),
    announce: async () => {},
    ...overrides,
  };
}
