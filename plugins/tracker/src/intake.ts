import {
  budgetHold,
  budgetPersonMessage,
  charge,
  type Executor,
  ExecutorUnavailableError,
  JobPendingError,
  type JobResult,
  type JobSpec,
  type User,
} from "@rackbops/docket-core";
import { type IntakeAnswer, type IntakeDraft, intakeJob, type IntakeLine, type IntakeType, MAX_LINE_CHARS, readIntake } from "@rackbops/docket-types";
import type { MessageComponentInteraction } from "discord.js";
import type { HostButton, PluginDirectMessage, PluginLog } from "../../../packages/api/contract.js";
import type { Membership } from "./access.js";
import { clip, enter, MAX_ANSWER, oneLine, type TrackerDeps } from "./actions.js";
import { intakeButtonId, parseIntakeId } from "./buttons.js";
import { EPHEMERAL, FAILED, NO_MENTIONS, type Queue, STARTING } from "./discord-common.js";
import { isCapability, type JobIdRecords, requeuedAfter, startedByRunner } from "./executor.js";
import type { Conversation, IntakeConversations } from "./intake-store.js";
import { executeBudget } from "./usage.js";
import { createAnswer, intakeTypes } from "./web/api-tasks.js";
import type { Writer } from "./web/editor.js";

/**
 * The plain-language intake (plan 1.4, E10; Rod's "Go", 2026-10-21): a person DMs Clerk what they
 * want in their own words, Clerk asks one question at a time, and shows a draft with Save, Change and
 * Cancel; only Save makes a task, through the very call the task API's `POST /tasks` makes, as the
 * person who pressed it (the tier rule: the agent proposes, the owner confirms, plain code acts).
 *
 * Each turn is a one-shot `claude -p` Job with no tools (docket-types' `intakeJob`), sent whole with
 * the transcript the tracker keeps (intake-store.ts; Rod, 2026-10-19, "Clerk keeps it"), through
 * city-hall to the runner on Rod's subscription. It does not wait on the execute lane, which ticks
 * once a minute and runs one Job at a time for everyone: a turn is submitted when the DM arrives and
 * asked about every `INTAKE_POLL_MS` until it answers, for at most `INTAKE_WAIT_MS`. A turn's Job
 * names `TRACKER_INTAKE_CAPABILITY` when it is set (a runner of its own, so a turn never queues behind
 * research), else the execute lane's tag.
 *
 * `TRACKER_INTAKE` decides who may: off (the default: DMs are not read), admins (Rod's "I'll test it
 * first", 2026-10-19), or everyone registered, on his word.
 */

export const INTAKE_KEY = "TRACKER_INTAKE";
export const INTAKE_CAPABILITY_KEY = "TRACKER_INTAKE_CAPABILITY";
/** The manifest's `format` (POSIX ERE): off, admins or everyone, any case, spaces around allowed; empty is off. */
export const INTAKE_FORMAT = "^ *([Oo][Ff][Ff]|[Aa][Dd][Mm][Ii][Nn][Ss]|[Ee][Vv][Ee][Rr][Yy][Oo][Nn][Ee])? *$";

export type IntakeMode = "off" | "admins" | "everyone";

/** `TRACKER_INTAKE`: unset or empty is off; throws, naming the variable, on anything but off, admins or everyone. */
export function parseIntakeMode(raw: string | undefined): IntakeMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "admins" || value === "everyone") return value;
  throw new Error(`${INTAKE_KEY} must be off, admins or everyone (or unset)`);
}

/** `TRACKER_INTAKE_CAPABILITY`: unset or empty is none (the execute lane's tag is used); throws on one that is not a tag. */
export function parseIntakeCapability(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (!isCapability(value)) throw new Error(`${INTAKE_CAPABILITY_KEY}: "${value.slice(0, 100)}" is not a capability tag (lowercase words joined by ":" or "-")`);
  return value;
}

/** Model calls (turn Jobs) one conversation may take, retries included; past them it closes. */
export const INTAKE_TURN_LIMIT = 20;
/** How long a turn's answer is waited for, queue included. */
export const INTAKE_WAIT_MS = 5 * 60 * 1000;
/** How often a turn out at city-hall is asked about. */
export const INTAKE_POLL_MS = 2000;
/** Discord shows "typing" for about 10 s; it is sent again this often while a turn is out. */
export const TYPING_EVERY_MS = 8000;

export const NOT_OPEN = "I can't take requests by DM yet. The slash commands (`/remind`, `/want`, `/research` and the rest) and the web area (`/web`) still work.";
export const NO_MODEL = "I can't take requests by DM on this tracker: its assistant is not set up.";
export const STILL_WORKING = "I'm still working on your last message; send this again once I've answered.";
export const TEXT_ONLY = "I can only read text: tell me in words what you would like to set up.";
export const TOO_SLOW = "That took too long, so I've dropped it. Send your message again in a few minutes.";
export const MODEL_BUSY = "I can't think right now: the assistant is out of model time or unavailable. Try again later.";
export const NOT_UNDERSTOOD = "Something went wrong working that out, so I've dropped it. Try saying it again, perhaps differently.";
export const CHANGE_ASK = "What should change?";
export const STALE = "That draft is no longer open: the conversation moved on or ended.";
export const NOTHING_SAVED = "Cancelled; nothing was saved.";
export const TOO_BIG_FOR_CARD = "That is too long for me to show you whole before saving. Could you make it shorter?";
export function tooLong(webEditor: boolean): string {
  return `This conversation has gone on too long (${INTAKE_TURN_LIMIT} model calls), so I've closed it. Send a new message to start again${webEditor ? ", or use the web editor (`/web`)" : ""}.`;
}

/**
 * The intake's Job ids, kept in memory only: a turn lives as long as one DM's handling, so a restart
 * drops the turn (the person is never answered, and sends it again), and the record of a finished
 * turn is forgotten at once. Never `executor_jobs`, whose prune drops any row that is not a run's.
 */
export class IntakeJobIds implements JobIdRecords {
  private readonly ids = new Map<string, { remoteId: string; pausedAt: string | null }>();

  get(jobKey: string): string | null {
    return this.ids.get(jobKey)?.remoteId ?? null;
  }

  put(jobKey: string, _occurrenceId: string, remoteId: string, _at: string): void {
    this.ids.set(jobKey, { remoteId, pausedAt: this.ids.get(jobKey)?.pausedAt ?? null });
  }

  pausedAt(jobKey: string): string | null {
    return this.ids.get(jobKey)?.pausedAt ?? null;
  }

  markPaused(jobKey: string, at: string): void {
    const r = this.ids.get(jobKey);
    if (r && r.pausedAt === null) r.pausedAt = at;
  }

  forget(jobKey: string): void {
    this.ids.delete(jobKey);
  }

  get size(): number {
    return this.ids.size;
  }
}

export interface IntakeWiring {
  mode: IntakeMode;
  deps(): TrackerDeps | null;
  conversations(): IntakeConversations | null;
  /** The city-hall Executor for turns, built over `ids`; null when the execute lane is not set up. */
  executor(): Executor | null;
  ids: IntakeJobIds;
  /** The surface's one write queue. */
  queue: Queue;
  /** The person's membership of the tracker's server(s), as a command's is checked. */
  membership(discordId: string): Promise<Membership>;
  log: PluginLog;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

export interface Intake {
  /** `Plugin.directMessage`: one DM a person sent the bot. */
  directMessage(message: PluginDirectMessage): Promise<void>;
  /** A press of a draft card's button (`tracker:i...`); false when the customId is not one. */
  press(interaction: MessageComponentInteraction): Promise<boolean>;
}

/** "Tuesday 2026-10-21 09:15, America/New_York": the person's own date and time, for the model. */
export function localNow(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}, ${timeZone}`;
}

/** The draft as the person reads it on the card: its type, then each field and value on a line. */
export function draftText(draft: IntakeDraft): string {
  // Whole values, never clipped: Save stores what the card shows (`turn` refuses a card that does not fit).
  const fields = Object.entries(draft.fields).map(([name, value]) => `- ${name}: ${value === null ? "(cleared)" : oneLine(String(value))}`);
  return ["Here is what I would save:", `- type: ${draft.type}`, ...fields].join("\n");
}

export function draftButtons(conversationId: string, draftSeq: number): HostButton[] {
  return [
    { customId: intakeButtonId("save", conversationId, draftSeq), label: "Save", style: "success" },
    { customId: intakeButtonId("change", conversationId, draftSeq), label: "Change", style: "secondary" },
    { customId: intakeButtonId("cancel", conversationId, draftSeq), label: "Cancel", style: "danger" },
  ];
}

/**
 * A turn's run: its result and whether it is charged (docket's rule: not a usage limit, a refused
 * credential or an executor failure); `late` when `waitMs` passed, `claimed` when a runner had
 * started its Job by then; `paused` when city-hall put the Job back after a usage limit or a refused
 * credential.
 */
type Ran = { kind: "result"; result: JobResult; charged: boolean } | { kind: "late"; claimed: boolean } | { kind: "paused" };

type Thought = { kind: "answer"; answer: IntakeAnswer } | { kind: "late" } | { kind: "failed"; usageLimit: boolean };

const uncharged = (detail: string): Ran => ({ kind: "result", result: { kind: "error", detail, durationMs: 0 }, charged: false });

export function createIntake(w: IntakeWiring): Intake {
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = w.waitMs ?? INTAKE_WAIT_MS;
  const pollMs = w.pollMs ?? INTAKE_POLL_MS;
  // Whose turn is out or whose Save is running (tracker user ids): one at a time per person.
  const busy = new Set<string>();
  // A new price tracker's or page watch's first read, one per person, as the web's (editor.ts).
  const reading = new Set<string>();

  /** One turn's Job at city-hall, until it answers or `waitMs` passes (null). */
  async function run(executor: Executor, spec: JobSpec, conversationId: string, key: string, typing: () => Promise<void>): Promise<Ran> {
    const until = performance.now() + waitMs;
    let lastTyping = Number.NEGATIVE_INFINITY;
    // Whether a runner has started the Job: the city-hall Executor's pending answer names its status (executor.ts, answerFor).
    let claimed = false;
    try {
      for (;;) {
        if (performance.now() - lastTyping >= TYPING_EVERY_MS) {
          lastTyping = performance.now();
          await typing();
        }
        // Submitted once city-hall's id is on record; until then (city-hall unreachable) the spec is sent again, which its key makes idempotent.
        const submitted = w.ids.get(key) !== null;
        try {
          const result = await executor.run(submitted ? null : spec, conversationId, key);
          return { kind: "result", result, charged: result.kind !== "usage_limit" && result.kind !== "auth_failed" };
        } catch (err) {
          if (!(err instanceof JobPendingError) && !(err instanceof ExecutorUnavailableError)) {
            return uncharged(`the executor failed: ${err instanceof Error ? err.name : "error"}`);
          }
          if (startedByRunner(err)) claimed = true;
          // A Job city-hall put back after a usage limit or a refused credential: the runner stops
          // claiming until it is fixed, so the person hears so now rather than in five minutes. The Job
          // stays in city-hall's queue (it has no cancel) and runs once a runner takes it again; its
          // answer is then dropped, and it is not charged, as docket charges no usage limit. A lost
          // lease (a runner restarting) is waited out: another claim usually follows within seconds.
          const after = requeuedAfter(err);
          if (after === "usage_limit" || after === "auth_failed") return { kind: "paused" };
        }
        if (performance.now() >= until) return { kind: "late", claimed };
        await sleep(pollMs);
      }
    } finally {
      w.ids.forget(key);
    }
  }

  /** Charges one call to the person, unless forget-me erased them while the turn was out. */
  async function chargeIfKnown(d: TrackerDeps, user: User, key: string, costUsd: number | null): Promise<void> {
    if (!(await d.store.getUser(user.id))) return;
    await charge(d.store, { userId: user.id, taskId: null, source: "run", key, calls: 1, costUsd, at: d.clock.now() });
  }

  /** The model's answer to the transcript, asking once more when its answer can be fixed (`readIntake`'s `retry`). */
  async function think(d: TrackerDeps, convs: IntakeConversations, executor: Executor, user: User, conv: Conversation, transcript: IntakeLine[], types: IntakeType[], typing: () => Promise<void>): Promise<Thought> {
    let problem: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const spec = intakeJob({ now: localNow(user.timeZone, d.clock.now()), types, transcript, ...(problem !== null ? { problem } : {}) });
      const key = `intake:${conv.id}:${conv.turns + attempt + 1}`;
      convs.countTurn(conv.id, d.clock.now());
      const ran = await run(executor, spec, conv.id, key, typing);
      if (ran.kind === "paused") return { kind: "failed", usageLimit: true };
      if (ran.kind === "late") {
        // A Job a runner started still runs after the turn gives up on it: one call, as docket charges a
        // late result. One still queued (a runner busy, or paused until its usage window resets, which
        // city-hall cannot show) is not charged; it may still run later, unseen.
        if (ran.claimed) await chargeIfKnown(d, user, key, null);
        return { kind: "late" };
      }
      const { result } = ran;
      if (ran.charged) await chargeIfKnown(d, user, key, result.totalCostUsd ?? null);
      const read = readIntake(result, types);
      if (read.ok) return { kind: "answer", answer: read.answer };
      if (!read.retry) return { kind: "failed", usageLimit: result.kind === "usage_limit" };
      // A retry is one more model call: never past the conversation's limit.
      if (conv.turns + attempt + 2 > INTAKE_TURN_LIMIT) break;
      problem = read.problem;
    }
    return { kind: "failed", usageLimit: false };
  }

  async function turn(d: TrackerDeps, convs: IntakeConversations, executor: Executor, user: User, m: PluginDirectMessage, send: (content: string, buttons?: HostButton[]) => Promise<void>) {
    const text = m.content.trim();
    if (text === "") return send(TEXT_ONLY);
    const now = d.clock.now();
    const conv = convs.open(user.id, now);
    if (conv.turns >= INTAKE_TURN_LIMIT) {
      convs.end(conv.id, "closed", now);
      return send(tooLong(d.webEditor));
    }
    const hold = await budgetHold(d.store, executeBudget(d.ceilings, d.budgetUnlimited === true), user, now);
    if (hold) return send(budgetPersonMessage(hold).text);
    // The person's line is kept only with an answer: a turn that fails leaves the transcript as it was.
    const transcript: IntakeLine[] = [...conv.transcript, { from: "person", text: text.slice(0, MAX_LINE_CHARS) }];
    const thought = await think(d, convs, executor, user, conv, transcript, intakeTypes(d), m.typing);
    // Forget-me erased the person while the turn was out: nothing is kept and nothing said.
    if (!(await d.store.getUser(user.id))) return;
    if (thought.kind === "late") return send(TOO_SLOW);
    if (thought.kind === "failed") return send(thought.usageLimit ? MODEL_BUSY : NOT_UNDERSTOOD);
    const { answer } = thought;
    const said: IntakeLine[] = [...transcript, { from: "bot", text: answer.reply }];
    const at = d.clock.now();
    if (answer.state === "ready" && answer.draft) {
      const card = `${answer.reply}\n\n${draftText(answer.draft)}`;
      // The person confirms exactly what Save stores, so a draft too long to show whole is not offered.
      if (card.length > MAX_ANSWER) {
        convs.saveTurn(conv.id, [...transcript, { from: "bot", text: TOO_BIG_FOR_CARD }], null, at);
        return send(TOO_BIG_FOR_CARD);
      }
      const saved = convs.saveTurn(conv.id, said, answer.draft, at);
      if (!saved) return send(STALE);
      return send(card, draftButtons(saved.id, saved.draftSeq));
    }
    convs.saveTurn(conv.id, said, null, at);
    if (answer.state === "cancelled") convs.end(conv.id, "cancelled", at);
    return send(answer.reply);
  }

  async function directMessage(m: PluginDirectMessage): Promise<void> {
    if (w.mode === "off") return;
    const d = w.deps();
    const convs = w.conversations();
    if (!d || !convs) return;
    const dm = d.dm;
    const send = async (content: string, buttons?: HostButton[]) => {
      if (!dm) return;
      try {
        await dm(m.userId, { content: clip(content), ...(buttons ? { buttons } : {}) });
      } catch (err) {
        // The error's name only: a refusal can echo what was sent.
        w.log.warn(`intake: a DM back could not be sent (${err instanceof Error ? err.name : "error"})`);
      }
    };
    const membership = await w.membership(m.userId);
    const entry = await w.queue(() => enter(d, m.userId, membership, "registered"));
    if (!entry.ok) return send(entry.content);
    const user = entry.user;
    if (entry.notice) await send(entry.notice);
    if (w.mode === "admins" && !user.admin) return send(NOT_OPEN);
    const executor = w.executor();
    if (!executor) return send(NO_MODEL);
    if (busy.has(user.id)) return send(STILL_WORKING);
    busy.add(user.id);
    try {
      await turn(d, convs, executor, user, m, send);
    } catch (err) {
      // Never the message text: the error's name only.
      w.log.error(`intake: a turn for ${user.id} failed (${err instanceof Error ? err.name : "error"})`);
      await send(FAILED);
    } finally {
      busy.delete(user.id);
    }
  }

  async function press(interaction: MessageComponentInteraction): Promise<boolean> {
    const parsed = parseIntakeId(interaction.customId);
    if (!parsed) return false;
    await interaction.deferUpdate();
    try {
      await pressed(interaction, parsed);
    } catch (err) {
      // The error's name only, as a turn's.
      w.log.error(`intake: a ${parsed.action} press failed (${err instanceof Error ? err.name : "error"})`);
      try {
        // The card's buttons go: its draft may already be taken, so a press would only say it is gone.
        await interaction.editReply({ components: [], ...NO_MENTIONS });
        await interaction.followUp({ content: FAILED, ...EPHEMERAL });
      } catch {
        // The interaction is gone; the log has it.
      }
    }
    return true;
  }

  async function pressed(interaction: MessageComponentInteraction, parsed: NonNullable<ReturnType<typeof parseIntakeId>>): Promise<void> {
    const original = interaction.message.content;
    const settle = async (status: string) => {
      const suffix = `\n\n-- ${status}`;
      await interaction.editReply({ content: `${clip(original, MAX_ANSWER - suffix.length)}${suffix}`, components: [], ...NO_MENTIONS });
    };
    const refuse = async (content: string) => void (await interaction.followUp({ content, ...EPHEMERAL }));
    const d = w.deps();
    const convs = w.conversations();
    if (!d || !convs) return refuse(STARTING);
    if (w.mode === "off") return settle(STALE);
    const membership = await w.membership(interaction.user.id);
    const entry = await w.queue(() => enter(d, interaction.user.id, membership, "registered"));
    if (!entry.ok) return refuse(entry.content);
    const user = entry.user;
    if (w.mode === "admins" && !user.admin) return refuse(NOT_OPEN);
    // One thing at a time per person: a press waits for a turn or a Save that is out, so neither
    // writes over what the other did.
    if (busy.has(user.id)) return refuse(STILL_WORKING);
    busy.add(user.id);
    try {
      const now = d.clock.now();
      const owned = convs.get(parsed.conversationId);
      // Taken off the conversation in one write, so only one press ever acts on a card's draft.
      const conv = owned?.userId === user.id ? convs.takeDraft(parsed.conversationId, parsed.draftSeq, now) : null;
      if (!conv?.draft) return settle(STALE);
      const draft = conv.draft;
      if (parsed.action === "cancel") {
        convs.end(conv.id, "cancelled", now);
        return settle(NOTHING_SAVED);
      }
      if (parsed.action === "change") {
        convs.saveTurn(conv.id, [...conv.transcript, { from: "bot", text: CHANGE_ASK }], null, now);
        return settle(CHANGE_ASK);
      }
      // Only a new task is made by conversation so far; an edit draft is never offered (no tasks are shown to the model).
      if (draft.action !== "create") return settle(STALE);
      const writer: Writer = { d, queue: w.queue, reading, userId: user.id, arrived: performance.now() };
      const answer = await createAnswer(writer, user, { type: draft.type, ...draft.fields }, "");
      const body = answer.body as { task?: { id?: unknown }; message?: unknown; error?: { message?: unknown } };
      const taskId = typeof body.task?.id === "string" ? body.task.id : null;
      const at = d.clock.now();
      if (answer.status === 201 && taskId !== null) {
        const saved = `Saved. ${typeof body.message === "string" ? body.message : ""}`.trim();
        // The task exists now: a later step that fails must not tell the person it did not, or they make it again.
        try {
          convs.end(conv.id, "saved", at, taskId);
          convs.markCreatedInConversation(taskId);
          await settle(saved);
        } catch (err) {
          w.log.error(`intake: ${taskId} was saved, but its conversation could not be closed (${err instanceof Error ? err.name : "error"})`);
          await refuse(saved);
        }
        return;
      }
      // Refused by the editor's own rules: the person hears why, and the model does at the next turn.
      const why = typeof body.error?.message === "string" ? body.error.message : "it could not be saved.";
      convs.saveTurn(conv.id, [...conv.transcript, { from: "bot", text: `I could not save that: ${why}` }], null, at);
      return settle(`Not saved: ${why} Tell me what to change, or say stop.`);
    } finally {
      busy.delete(user.id);
    }
  }

  return { directMessage, press };
}
