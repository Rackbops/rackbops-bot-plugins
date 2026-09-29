import {
  decodeReplyRef,
  invite,
  inviteMessage,
  replyForRef,
  ReplyRefusedError,
  visibleTask,
  type OutgoingMessage,
  type User,
} from "@rackbops/docket-core";
import type { Membership } from "./access.js";
import { answeredText, clip, NO_SUCH_TASK, replyLanes, type TrackerDeps } from "./actions.js";
import { MAX_REPLY_TEXT } from "./buttons.js";
import { RecipientUnreachableError } from "./notifier.js";

/**
 * Sharing, the buttons, and the Reply modal (plan 5.5): consent with accept and decline, the
 * opt-out on every recipient's copy, done and snooze for the owner, and text replies through a
 * modal -- so the tracker never reads a typed DM and never needs the Message Content intent.
 * docket decides who may give each answer (`replyForRef`, `Lanes.reply`); this turns its verdict
 * into the words the presser sees.
 */

/** One answer for every reason a person cannot be shared with, so it reveals none of them. */
export const CANNOT_SHARE = "can't be shared with: they have to be on this tracker's list, registered, a member of its server, and reachable by DM.";

/** An invitation recorded and waiting for its DM, which is sent outside the interaction queue. */
export interface PendingShare {
  taskId: string;
  targetId: string;
  targetDiscordId: string;
  message: OutgoingMessage;
}

/**
 * `/task share <task> @user`, first half (in the queue): the owner invites an admitted, registered,
 * reachable member, and the invitation is recorded; the consent DM (docket's `inviteMessage`, with
 * the disclosure, carrying accept and decline) is what `sendShare` sends.
 */
export async function prepareShare(
  d: TrackerDeps,
  owner: User,
  taskId: string,
  target: { discordId: string; membership: Membership },
): Promise<string | PendingShare> {
  const task = await visibleTask(d.store, { userId: owner.id, admin: false }, taskId.trim());
  if (!task || task.ownerId !== owner.id) return NO_SUCH_TASK;
  if (task.status !== "active") return `That task is ${task.status}.`;
  const person = await d.store.findUserByDiscordId(target.discordId);
  const refused =
    !person ||
    !d.admissions.isRegistered(person.id) ||
    target.membership === "not-member" ||
    target.membership === "unknown" ||
    d.health.isPaused(person.id);
  if (refused) return `<@${target.discordId}> ${CANNOT_SHARE}`;
  const now = d.clock.now();
  const result = await invite(d.store, { userId: owner.id, admin: false }, task, person.id, now);
  if (!result.ok) {
    // Every refusal reads the same, except a block the target chose by declining: that one is theirs
    // to have told the sharer, and saying so stops the sharer from retrying.
    if (result.reason === "blocked") {
      const until = result.block?.expiresAt;
      return until
        ? `<@${target.discordId}> declined an earlier invitation from you; you can invite them again after ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC.`
        : `<@${target.discordId}> declined your invitations twice; only an admin can lift that.`;
    }
    return `<@${target.discordId}> ${CANNOT_SHARE}`;
  }
  return { taskId: task.id, targetId: person.id, targetDiscordId: target.discordId, message: inviteMessage(task, owner, person, now) };
}

/** Second half, outside the queue: the consent DM. Resolves to the error when it failed. */
export async function sendShare(d: TrackerDeps, p: PendingShare): Promise<unknown> {
  try {
    await d.notifier.sendDm(p.targetId, p.message);
    return null;
  } catch (err) {
    return err ?? new Error("failed");
  }
}

/**
 * Last, in the queue again: the owner's answer. A DM that could not be delivered withdraws the
 * invitation (on record), so the owner can try again once the person opens their DMs.
 */
export async function finishShare(d: TrackerDeps, p: PendingShare, err: unknown): Promise<string> {
  if (err === null) return `Invited <@${p.targetDiscordId}> to \`${p.taskId}\`. They get a DM to accept or decline.`;
  await d.store.removeRecipient(p.taskId, p.targetId);
  await d.store.addTaskEvent({
    taskId: p.taskId,
    actorId: null,
    kind: "recipient_removed",
    detail: `${p.targetId}: the invitation could not be delivered`,
    at: d.clock.now().toISOString(),
  });
  if (err instanceof RecipientUnreachableError) {
    return `I could not DM <@${p.targetDiscordId}> (their DMs are closed, or they blocked the bot), so the invitation is withdrawn.`;
  }
  d.log.error(`invitation DM for ${p.taskId} to ${p.targetId} failed`, err);
  return "The invitation could not be sent; try again in a minute.";
}

export type PressResult =
  | { ok: true; status: string; /** Keep the Reply button on the message for this run. */ keepReplyFor: string | null }
  | { ok: false; error: string };

const CONSENT_TEXT: Record<string, string> = {
  accept: "Accepted: you will get this task's results, and each one has a button to stop them.",
  decline: "Declined. You will not get this task's results.",
  opt_out: "You will not get this task's messages any more.",
};

/** A button with a docket reply reference, pressed by `user`. */
export async function press(d: TrackerDeps, user: User, ref: string): Promise<PressResult> {
  const verdict = await replyForRef(d.store, ref, user.id);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  const { input } = verdict;
  try {
    const outcome = await replyLanes(d).reply(input);
    const consent = CONSENT_TEXT[input.kind];
    if (consent) return { ok: true, status: consent, keepReplyFor: null };
    const status =
      input.kind === "decision"
        ? `Recorded: ${String((input.payload as { choice?: unknown } | null)?.choice ?? "")}.`
        : answeredText(input.kind, outcome?.snoozeUntil ?? null, user, d.clock.now());
    return { ok: true, status, keepReplyFor: input.occurrenceId };
  } catch (err) {
    if (err instanceof ReplyRefusedError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Who may send a text reply to a run (plan 1.3, item 34): the task's owner and its accepted
 * recipients. docket stores text from anyone and leaves the gate to the host. Null when they may.
 */
export async function replyRefusal(d: TrackerDeps, user: User, occurrenceId: string): Promise<string | null> {
  const occurrence = await d.store.getOccurrence(occurrenceId);
  if (!occurrence) return "That run no longer exists.";
  const task = await d.store.getTask(occurrence.taskId);
  if (!task) return "That task no longer exists.";
  if (task.ownerId === user.id) return null;
  const mine = (await d.store.listRecipients(task.id)).find((r) => r.userId === user.id);
  return mine?.state === "accepted" ? null : "That is not yours to reply to.";
}

/** The Reply modal's submit: the text is kept on the task, against the run it answers. */
export async function submitReply(d: TrackerDeps, user: User, occurrenceId: string, text: string): Promise<string> {
  const refusal = await replyRefusal(d, user, occurrenceId);
  if (refusal) return refusal;
  const trimmed = text.trim();
  if (trimmed.length === 0) return "That reply was empty.";
  const occurrence = await d.store.getOccurrence(occurrenceId);
  if (!occurrence) return "That run no longer exists.";
  await replyLanes(d).reply({
    taskId: occurrence.taskId,
    occurrenceId,
    userId: user.id,
    kind: "text",
    payload: { text: clip(trimmed, MAX_REPLY_TEXT) },
  });
  return "Reply kept with the task's history.";
}

/**
 * A press that only reduces contact -- declining an invitation, opting out of a task -- skips the
 * membership and registration gates, so someone who left the server or never registered can always
 * stop the messages. Admission is not checked either: docket's `replyForRef` already requires the
 * presser to be the invited or accepted recipient, and only a person in the store can be one.
 */
export function reducesContact(ref: string): boolean {
  const kind = decodeReplyRef(ref)?.kind;
  return kind === "decline" || kind === "opt_out";
}
