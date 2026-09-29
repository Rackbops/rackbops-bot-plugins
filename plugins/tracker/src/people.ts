import { isTimeZone, type Actor, type Identity, type Store, type User } from "@rackbops/docket-core";

/**
 * People (plan 5.8, rev17, item 40): each person is a row in the tracker's own store -- Discord id,
 * preferred hour, time zone, admin flag -- never a usr account, and nothing here calls usr or
 * recall (items 37, 40). The admin flag is the tracker's one admin definition (5.10); the first
 * admin comes from the instance's configuration (`TRACKER_ADMIN_DISCORD_IDS`), and later admins are
 * granted from the web area (not built yet).
 */

/** The tracker's default zone until a person sets one (plan 1.1, 5.2: US Eastern). */
export const DEFAULT_TIME_ZONE = "America/New_York";
export const DEFAULT_PREFERRED_HOUR = 9;

const SNOWFLAKE = /^[0-9]{17,20}$/;

export class PeopleError extends Error {
  override name = "PeopleError";
}

/**
 * `TRACKER_ADMIN_DISCORD_IDS`: comma-separated Discord user ids, spaces around a comma allowed --
 * the same shape as the manifest's `format`, so what `ops/bot-ops.sh env-set` accepts, this does.
 * Unset or blank is no admins; anything else that is not a list of ids (an empty entry, as from a
 * trailing comma, included) throws, naming the bad entry, so the host skips the plugin with that
 * reason (createPlugin's rule).
 */
export function parseAdminIds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const ids = raw.split(",").map((s) => s.trim());
  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) throw new PeopleError(`TRACKER_ADMIN_DISCORD_IDS: "${id}" is not a Discord user id`);
  }
  return [...new Set(ids)];
}

/**
 * Admits the person with this Discord id: returns their row, creating it with the tracker's
 * defaults when absent. What `/allow` will call (rackbops-bot-plugins#79). The tracker's store
 * rejects a second user with the same Discord id (store.ts), so two admissions racing each other
 * leave one row: the loser's create throws, and it reads back the winner's.
 */
export async function admit(store: Store, discordId: string, now: Date, options: { admin?: boolean } = {}): Promise<User> {
  if (!SNOWFLAKE.test(discordId)) throw new PeopleError(`"${discordId}" is not a Discord user id`);
  const existing = await store.findUserByDiscordId(discordId);
  if (existing) return existing;
  try {
    return await store.createUser({
      discordId,
      timeZone: DEFAULT_TIME_ZONE,
      preferredHour: DEFAULT_PREFERRED_HOUR,
      admin: options.admin ?? false,
      at: now.toISOString(),
    });
  } catch (err) {
    const winner = await store.findUserByDiscordId(discordId);
    if (winner) return winner;
    throw err;
  }
}

/**
 * Makes each id an admin, admitting whoever is not in the store yet. Only ever grants: an id
 * dropped from the configuration keeps the flag, since revoking belongs to the admin view and a
 * typo in an env value should not silently strip the last admin. Returns the ids newly made admin.
 */
export async function seedAdmins(store: Store, discordIds: readonly string[], now: Date): Promise<string[]> {
  const granted: string[] = [];
  for (const discordId of discordIds) {
    const existing = await store.findUserByDiscordId(discordId);
    if (existing?.admin) continue;
    if (existing) await store.updateUser(existing.id, { admin: true });
    else await admit(store, discordId, now, { admin: true });
    granted.push(discordId);
  }
  return granted;
}

export interface Preferences {
  timeZone?: string;
  preferredHour?: number;
}

/** Sets a person's zone and hour (what `/register` will write), refusing a bad value by name. */
export async function setPreferences(store: Store, userId: string, prefs: Preferences): Promise<User> {
  if (prefs.timeZone !== undefined && !isTimeZone(prefs.timeZone)) {
    throw new PeopleError(`"${prefs.timeZone}" is not a time zone (use an IANA name such as America/New_York)`);
  }
  if (prefs.preferredHour !== undefined && !(Number.isInteger(prefs.preferredHour) && prefs.preferredHour >= 0 && prefs.preferredHour <= 23)) {
    throw new PeopleError(`preferred hour must be a whole hour from 0 to 23, not ${prefs.preferredHour}`);
  }
  return store.updateUser(userId, {
    ...(prefs.timeZone !== undefined ? { timeZone: prefs.timeZone } : {}),
    ...(prefs.preferredHour !== undefined ? { preferredHour: prefs.preferredHour } : {}),
  });
}

/**
 * docket's Identity port from the tracker's own store. The lanes do not use it; the commands
 * (#79) will. `actorForSubject` always answers null: people are not usr accounts (item 40), so no
 * usr subject is ever written -- docket still carries `usrSubject` and this method (docket#18).
 */
export function localIdentity(store: Store): Identity {
  const actor = (u: User | null): Actor | null => (u ? { userId: u.id, admin: u.admin } : null);
  return {
    async actorForDiscord(discordId) {
      return actor(await store.findUserByDiscordId(discordId));
    },
    async actorForSubject() {
      return null;
    },
  };
}
