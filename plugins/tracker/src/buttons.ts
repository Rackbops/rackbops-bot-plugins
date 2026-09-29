import { replyButtons, type ButtonReplyKind, type OutgoingMessage } from "@rackbops/docket-core";
import type { HostButton } from "../../../packages/api/contract.js";

/**
 * The tracker's component ids (plan 5.5). Every one starts with `tracker:` -- the host routes a press
 * whose customId carries this plugin's manifest name to its `interactions` handler, DMs included --
 * followed by one of:
 *
 * - docket's reply reference (`refs.ts`, `<kind>.<o|t>.<id>`): done, snooze, accept, decline,
 *   opt-out, a decision. A press is turned back into a reply by docket's `replyForRef`.
 * - `r.o.<occurrence>`: the Reply button, which opens the reply modal.
 * - `m.o.<occurrence>`: that modal; its submit carries the typed text.
 *
 * `r` and `m` are not codes docket's encoding uses, so the two never collide. docket keeps a
 * reference within 80 characters; with the 8-character prefix every id stays inside Discord's 100.
 */

export const PREFIX = "tracker:";
export const REPLY_CODE = "r";
export const MODAL_CODE = "m";
/** The modal's one text field. */
export const REPLY_FIELD = "text";
/** Discord's cap on a paragraph input's value, lowered to what the tracker keeps. */
export const MAX_REPLY_TEXT = 1000;
/** Discord's limit: five rows of five buttons. */
export const MAX_BUTTONS = 25;

const STYLE: Record<ButtonReplyKind, HostButton["style"]> = {
  done: "success",
  snooze: "secondary",
  accept: "success",
  decline: "danger",
  opt_out: "secondary",
  decision: "primary",
};

export function replyButtonId(occurrenceId: string): string {
  return `${PREFIX}${REPLY_CODE}.o.${occurrenceId}`;
}

export function modalId(occurrenceId: string): string {
  return `${PREFIX}${MODAL_CODE}.o.${occurrenceId}`;
}

export type ParsedId =
  | { kind: "reply-button"; occurrenceId: string }
  | { kind: "reply-modal"; occurrenceId: string }
  | { kind: "ref"; ref: string }
  | null;

/** What a customId the host routed here stands for; null when it is not the tracker's. */
export function parseCustomId(customId: string): ParsedId {
  if (!customId.startsWith(PREFIX)) return null;
  const rest = customId.slice(PREFIX.length);
  const own = /^([rm])\.o\.([^.]+)$/.exec(rest);
  if (own) return own[1] === REPLY_CODE ? { kind: "reply-button", occurrenceId: own[2] as string } : { kind: "reply-modal", occurrenceId: own[2] as string };
  return rest.length > 0 ? { kind: "ref", ref: rest } : null;
}

/**
 * The buttons a delivered message carries: docket's reply buttons (done and snooze for the owner;
 * accept and decline on an invitation; the opt-out on a recipient's copy), then a Reply button on
 * any message about one run, so a text reply needs no Message Content intent (plan 5.5). Cut to
 * Discord's 25, keeping the Reply button.
 */
export function hostButtons(message: OutgoingMessage): HostButton[] {
  const buttons: HostButton[] = replyButtons(message).map((b) => ({
    customId: `${PREFIX}${b.ref}`,
    label: b.label.slice(0, 80),
    style: STYLE[b.kind],
  }));
  const occurrenceId = message.ref?.occurrenceId ?? null;
  if (occurrenceId === null) return buttons.slice(0, MAX_BUTTONS);
  return [...buttons.slice(0, MAX_BUTTONS - 1), { customId: replyButtonId(occurrenceId), label: "Reply", style: "secondary" }];
}
