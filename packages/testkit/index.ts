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
import type { HostApi, HostStorage } from "../api/contract.js";

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
