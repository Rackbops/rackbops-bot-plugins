import { describe, expect, it } from "bun:test";
import { DEFAULT_PREFERRED_HOUR, DEFAULT_TIME_ZONE, PeopleError, admit, localIdentity, parseAdminIds, seedAdmins, setPreferences } from "./people.js";
import pkg from "../package.json" with { type: "json" };
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const A = "111111111111111111";
const B = "222222222222222222";

const fresh = () => new SqliteStore(openDatabase(":memory:"));

describe("parseAdminIds", () => {
  it("reads a comma-separated list, tolerating spaces and repeats; unset or blank is none", () => {
    expect(parseAdminIds(undefined)).toEqual([]);
    expect(parseAdminIds("  ")).toEqual([]);
    expect(parseAdminIds(`${A}, ${B},${A}`)).toEqual([A, B]);
  });

  it("accepts exactly what the manifest's format accepts: spaces around commas, no empty entry", () => {
    const format = new RegExp(pkg.botPlugin.env[0]!.format);
    for (const ok of [A, `${A},${B}`, `${A} , ${B}`, ` ${A}`]) {
      expect(format.test(ok)).toBe(true);
      expect(() => parseAdminIds(ok)).not.toThrow();
    }
    for (const bad of [`${A},`, `,${A}`, `${A},,${B}`, `${A};${B}`]) {
      expect(format.test(bad)).toBe(false);
      expect(() => parseAdminIds(bad)).toThrow(PeopleError);
    }
  });

  it("refuses anything that is not a Discord id, naming it", () => {
    expect(() => parseAdminIds(`${A},roshne`)).toThrow('"roshne" is not a Discord user id');
    expect(() => parseAdminIds(`${A},`)).toThrow(PeopleError);
  });
});

describe("people in the store", () => {
  it("admits a person once, with the tracker's defaults (US Eastern, 9:00), and no usr subject", async () => {
    const store = fresh();
    const u = await admit(store, A, NOW);
    expect(u).toMatchObject({ discordId: A, timeZone: DEFAULT_TIME_ZONE, preferredHour: DEFAULT_PREFERRED_HOUR, admin: false });
    expect((await admit(store, A, NOW)).id).toBe(u.id);
    await expect(admit(store, "nope", NOW)).rejects.toThrow(PeopleError);
  });

  it("seeds admins from the configuration: creates, promotes, never demotes, and says who it granted", async () => {
    const store = fresh();
    const b = await admit(store, B, NOW);
    expect(await seedAdmins(store, [A, B], NOW)).toEqual([A, B]);
    expect((await store.findUserByDiscordId(A))?.admin).toBe(true);
    expect((await store.getUser(b.id))?.admin).toBe(true);
    expect(await seedAdmins(store, [A], NOW)).toEqual([]);
    expect((await store.getUser(b.id))?.admin).toBe(true);
  });

  it("sets a zone and an hour, refusing an unknown zone or an hour outside 0-23", async () => {
    const store = fresh();
    const u = await admit(store, A, NOW);
    expect(await setPreferences(store, u.id, { timeZone: "Europe/London", preferredHour: 7 })).toMatchObject({ timeZone: "Europe/London", preferredHour: 7 });
    await expect(setPreferences(store, u.id, { timeZone: "Mars/Olympus" })).rejects.toThrow("is not a time zone");
    await expect(setPreferences(store, u.id, { preferredHour: 24 })).rejects.toThrow("0 to 23");
    await expect(setPreferences(store, u.id, { preferredHour: 7.5 })).rejects.toThrow(PeopleError);
    expect(await store.getUser(u.id)).toMatchObject({ timeZone: "Europe/London", preferredHour: 7 });
  });

  it("answers docket's Identity port from the store; a usr subject never resolves", async () => {
    const store = fresh();
    await seedAdmins(store, [A], NOW);
    const identity = localIdentity(store);
    const admin = await store.findUserByDiscordId(A);
    expect(await identity.actorForDiscord(A)).toEqual({ userId: admin?.id ?? "", admin: true });
    expect(await identity.actorForDiscord(B)).toBeNull();
  });

  it("two admissions racing for one Discord id leave one row: the loser reads back the winner", async () => {
    const store = fresh();
    const first = await admit(store, A, NOW);
    // The race: the loser looked before the winner wrote, so its own look found nobody.
    const racing = Object.create(store) as SqliteStore;
    let looked = false;
    racing.findUserByDiscordId = async (id: string) => {
      if (!looked) return ((looked = true), null);
      return store.findUserByDiscordId(id);
    };
    expect((await admit(racing, A, NOW)).id).toBe(first.id);
  });

  it("the store rejects a second user with the same Discord id", async () => {
    const store = fresh();
    await admit(store, A, NOW);
    await expect(store.createUser({ discordId: A, at: NOW.toISOString() })).rejects.toThrow();
  });
});
