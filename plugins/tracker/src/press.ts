import {
  invite,
  inviteMessage,
  replyForRef,
  ReplyRefusedError,
  visibleTask,
  type User,
} from "@rackbops/docket-core";
import { answeredText, clip, replyLanes, type TrackerDeps } from "./actions.js";
import { MAX_REPLY_TEXT } from "./buttons.js";
import { RecipientUnreachableError } from "./notifier.js";

/**
 * Sharing, the buttons, and the Reply modal (plan 5.5): consent with accept and decline, the
 * opt-out on every recipient's copy, done and snooze for the owner, and text replies through a
 * modal -- so the tracker never reads a typed DM and never needs the Message Content intent.
 * docket decides who may give each answer (`replyForRef`, `Lanes.reply`); this turns its verdict
 * into the words the presser sees.
 */

/**
 * `/task share <task> @user`: the owner invites an admitted, registered person, who gets the one
 * consent DM (docket's `inviteMessage`, with the disclosure) carrying accept and decline. A DM that
 * cannot be delivered withdraws the invitation, so the owner can try again once they open DMs.
 */
export async function shareTask(d: TrackerDeps, owner: User, taskId: string, targetDiscordId: string): Promise<string> {
  const id = taskId.trim();
  const task = await visibleTask(d.store, { userId: owner.id, admin: false }, id);
  if (!task || task.ownerId !== owner.id) return `You have no task \`${id}\`.`;
  if (task.status !== "active") return `That task is ${task.status}.`;
  const target = await d.store.findUserByDiscordId(targetDiscordId);
  if (!target || !d.admissions.isRegistered(target.id)) {
    return `<@${targetDiscordId}> has to be on the tracker's list and registered before you can share with them.`;
  }
  const now = d.clock.now();
  const result = await invite(d.store, { userId: owner.id, admin: false }, task, target.id, now);
  if (!result.ok) {
    if (result.reason === "self") return "You already get your own tasks.";
    if (result.reason === "already_invited") return `<@${targetDiscordId}> is already invited to that task.`;
    if (result.reason === "blocked") {
      const until = result.block?.expiresAt;
      return until
        ? `<@${targetDiscordId}> declined an earlier invitation from you; you can invite them again after ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC.`
        : `<@${targetDiscordId}> declined your invitations twice; only an admin can lift that.`;
    }
    return "Only the task's owner can share it.";
  }
  try {
    await d.notifier.sendDm(target.id, inviteMessage(task, owner, target, now));
  } catch (err) {
    await d.store.removeRecipient(task.id, target.id);
    await d.store.addTaskEvent({
      taskId: task.id,
      actorId: null,
      kind: "recipient_removed",
      detail: `${target.id}: the invitation could not be delivered`,
      at: d.clock.now().toISOString(),
    });
    if (err instanceof RecipientUnreachableError) {
      return `I could not DM <@${targetDiscordId}> (their DMs are closed, or they blocked the bot), so the invitation is withdrawn.`;
    }
    d.log.error(`invitation DM for ${task.id} to ${target.id} failed`, err);
    return "The invitation could not be sent; try again in a minute.";
  }
  return `Invited <@${targetDiscordId}> to \`${task.id}\`. They get a DM to accept or decline.`;
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
