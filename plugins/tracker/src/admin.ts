import { activeBlock, liftBlock, type User } from "@rackbops/docket-core";
import { NOT_ADMIN } from "./access.js";
import type { TrackerDeps } from "./actions.js";
import type { Done } from "./manage.js";
import type { Erased } from "./roster.js";

/**
 * What a tracker admin does to people, and forget-me (rackbops-bot-plugins#80, slice 3; plan 5.8,
 * 5.10), with no discord.js and no HTTP: the web area's admin view and its forget-me page call
 * these, as the commands call actions.ts. The one admin definition is the `admin` flag on the
 * person's row in the tracker's store (plan 5.8, item 40); every function here takes the acting
 * person as the caller re-read them from the store inside the surface's one queue, and checks the
 * flag again itself, so an admin whose flag was revoked a moment ago can do none of it.
 *
 * Admission (`/allow`) is `allowPerson` in actions.ts and resuming a paused person's delivery is
 * `DeliveryHealth.resume` -- the same functions the command path runs; they are not copied here.
 * Admins see every task (docket's authorized reads) but never edit, pause or delete another
 * person's task: those stay the owner's (slice 2).
 */

export const NO_SUCH_PERSON = "There is no such person on this tracker's list.";
export const NO_SUCH_BLOCK = "There is no such block in force.";
export const LAST_ADMIN = "That is the tracker's only admin: make someone else an admin first.";
export const BUSY = "The tracker is busy sending reminders; nothing was deleted. Try again in a minute.";

/** How long forget-me waits for a running tick to end, before its turn in the queue. */
export const TICK_WAIT_MS = 20_000;

export const CONFIGURED_ADMIN =
  "That admin is named in TRACKER_ADMIN_DISCORD_IDS, which makes them an admin again at every start: remove them from the configuration first.";
export const CONFIGURED_SELF =
  "You are named in TRACKER_ADMIN_DISCORD_IDS: this erases you now, but the next start makes you an admin again, as a new person, unless you are removed from the configuration first.";

/** Whether the configuration (`TRACKER_ADMIN_DISCORD_IDS`) names this person: the start re-seeds them as an admin. */
export function isConfiguredAdmin(d: Pick<TrackerDeps, "configuredAdmins">, u: { discordId: string | null }): boolean {
  return u.discordId !== null && d.configuredAdmins.has(u.discordId);
}

/**
 * Forget-me's wait, before its turn in the queue (the queue never holds anything slow;
 * discord-common.ts): until no notify or poll tick runs, at most `TICK_WAIT_MS`. False when one
 * still runs; the caller answers BUSY and deletes nothing.
 */
export function ticksSettled(d: Pick<TrackerDeps, "lanes">): Promise<boolean> {
  return d.lanes.idle(TICK_WAIT_MS);
}

/** The tracker's own `u<n>` id shape; anything else names no one. */
export function isPersonId(id: string): boolean {
  return /^u[1-9][0-9]{0,15}$/.test(id);
}

async function person(d: Pick<TrackerDeps, "store">, id: string): Promise<User | null> {
  return isPersonId(id) ? d.store.getUser(id) : null;
}

function who(u: User): string {
  return u.displayName ?? u.discordId ?? u.id;
}

/**
 * Grants or revokes the admin flag (plan 5.8: "admins grant and revoke the flag from the web area's
 * admin view"). The last admin cannot be revoked, by themselves or anyone: the tracker would have
 * no one left to `/allow` a person. `TRACKER_ADMIN_DISCORD_IDS` still only ever grants, at start.
 */
export async function setAdminFlag(d: TrackerDeps, admin: User, targetId: string, flag: boolean): Promise<Done> {
  if (!admin.admin) return { ok: false, error: NOT_ADMIN };
  const target = await person(d, targetId);
  if (!target) return { ok: false, error: NO_SUCH_PERSON };
  if (target.admin === flag) return { ok: true, text: `${who(target)} ${flag ? "is already" : "is not"} an admin.` };
  if (!flag && d.roster.admins() <= 1) return { ok: false, error: LAST_ADMIN };
  if (!flag && isConfiguredAdmin(d, target)) return { ok: false, error: CONFIGURED_ADMIN };
  await d.store.updateUser(target.id, { admin: flag });
  d.log.info(`${admin.id} ${flag ? "made" : "revoked"} ${target.id} ${flag ? "an admin" : "as admin"}`);
  return { ok: true, text: flag ? `${who(target)} is now an admin.` : `${who(target)} is no longer an admin.` };
}

/**
 * Lifts a person's delivery pause (plan 5.5, 5.10's "pause"): what their own next command does
 * (`enter`), by the same `DeliveryHealth.resume` -- the count clears and the tasks nothing else
 * holds go back on. If their DMs are still closed, three more failures pause them again.
 */
export async function resumeDelivery(d: TrackerDeps, admin: User, targetId: string): Promise<Done> {
  if (!admin.admin) return { ok: false, error: NOT_ADMIN };
  const target = await person(d, targetId);
  if (!target) return { ok: false, error: NO_SUCH_PERSON };
  const resumed = await d.health.resume(target.id, d.clock.now());
  if (!resumed) return { ok: false, error: `Delivery to ${who(target)} is not paused.` };
  return { ok: true, text: `Delivery to ${who(target)} resumed; ${resumed.tasks.length} task(s) back on.` };
}

/** Lifts a decline block in force (plan 5.5: "a second one until an admin lifts it"), by docket's `liftBlock`. */
export async function liftDeclineBlock(d: TrackerDeps, admin: User, blockId: string): Promise<Done> {
  if (!admin.admin) return { ok: false, error: NOT_ADMIN };
  const block = /^b[1-9][0-9]{0,15}$/.test(blockId) ? await d.store.getBlock(blockId) : null;
  const now = d.clock.now();
  // Only the block in force between that pair: a lifted or expired one has nothing to lift.
  if (!block || (await activeBlock(d.store, block.ownerId, block.recipientId, now))?.id !== block.id) return { ok: false, error: NO_SUCH_BLOCK };
  await liftBlock(d.store, { userId: admin.id, admin: true }, block.id, now);
  const owner = await d.store.getUser(block.ownerId);
  const recipient = await d.store.getUser(block.recipientId);
  return {
    ok: true,
    text: `Lifted: ${owner ? who(owner) : block.ownerId} may invite ${recipient ? who(recipient) : block.recipientId} again.`,
  };
}

/**
 * Forget-me (plan 5.8: "Deleting a person deletes their tasks, recipients, replies, findings and
 * history rows in the tracker's store"): the person themselves, or an admin removing someone from
 * the tracker (plan 5.10, "a friend who leaves needs a deletion path"). Everything is deleted, not
 * archived, in one transaction (`Roster.erase` says what), on the delivery lock so no pause or
 * resume interleaves; other owners' tasks that were paused only for them go back on. Their web
 * sessions are among the rows, so they are signed out everywhere at once. They can come back only
 * as a new person: an admin `/allow`s them again, and the tracker never reuses an id.
 *
 * The last admin cannot be forgotten, by themselves or by anyone, for `setAdminFlag`'s reason, and
 * an admin named in `TRACKER_ADMIN_DISCORD_IDS` cannot be removed by someone else (the next start
 * would make them again); forgetting themselves is allowed, and the page says what the next start
 * does. The caller runs `ticksSettled` first, outside the queue.
 */
export async function forgetPerson(d: TrackerDeps, actor: User, targetId: string): Promise<Done> {
  if (actor.id !== targetId && !actor.admin) return { ok: false, error: NOT_ADMIN };
  const target = await person(d, targetId);
  if (!target) return { ok: false, error: NO_SUCH_PERSON };
  if (target.admin && d.roster.admins() <= 1) return { ok: false, error: LAST_ADMIN };
  if (actor.id !== target.id && isConfiguredAdmin(d, target)) return { ok: false, error: CONFIGURED_ADMIN };
  const now = d.clock.now();
  // No tick may be running: one with a DM to them in flight would record it after they were gone.
  // The caller waits for that before its turn in the queue (`ticksSettled`), so nothing slow runs in
  // the queue; here, inside the queue and the delivery lock, a tick that started since is only
  // detected, and the answer is BUSY. The erasure itself is synchronous, so no tick can start
  // between this check and its end.
  const erased: Erased | null = await d.health.exclusive(async () => {
    if (d.lanes.busy()) return null;
    const e = d.roster.erase(target.id);
    for (const taskId of e.freed) await d.health.release(taskId, null, "resumed: a recipient left the tracker", now);
    return e;
  });
  if (erased === null) return { ok: false, error: BUSY };
  if (!d.roster.checkpoint()) d.log.warn(`after forgetting ${target.id}: the write-ahead log is busy, so SQLite's next checkpoint copies it back`);
  const total = Object.values(erased.rows).reduce((a, b) => a + b, 0);
  d.log.info(`forgot ${target.id} (${actor.id === target.id ? "at their own request" : `removed by ${actor.id}`}): ${total} row(s) deleted`);
  return { ok: true, text: actor.id === target.id ? "Everything the tracker held about you is deleted." : `${who(target)} is removed from the tracker.` };
}
