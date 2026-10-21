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
import { isCapability, type JobIdRecords } from "./executor.js";
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

/** Model turns one conversation may take, retries included; past them it closes. */
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
export const MODEL_BUSY = "I can't think right now: the assistant's model time is used up. Try again later.";
export const NOT_UNDERSTOOD = "Something went wrong working that out, so I've dropped it. Try saying it again, perhaps differently.";
export const CHANGE_ASK = "What should change?";
export const STALE = "That draft is no longer open: the conversation moved on or ended.";
export const NOTHING_SAVED = "Cancelled; nothing was saved.";
export function tooLong(webEditor: boolean): string {
  return `This conversation has gone on for ${INTAKE_TURN_LIMIT} turns, so I've closed it. Send a new message to start again${webEditor ? ", or use the web editor (`/web`)" : ""}.`;
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
  const fields = Object.entries(draft.fields).map(([name, value]) => `- ${name}: ${value === null ? "(cleared)" : clip(oneLine(String(value)), 300)}`);
  return ["Here is what I would save:", `- type: ${draft.type}`, ...fields].join("\n");
}

export function draftButtons(conversationId: string, draftSeq: number): HostButton[] {
  return [
    { customId: intakeButtonId("save", conversationId, draftSeq), label: "Save", style: "success" },
    { customId: intakeButtonId("change", conversationId, draftSeq), label: "Change", style: "secondary" },
    { customId: intakeButtonId("cancel", conversationId, draftSeq), label: "Cancel", style: "danger" },
  ];
}

/** A turn's run: its result and whether it is charged (docket's rule: not a usage limit, a refused credential or an executor failure). */
type Ran = { result: JobResult; charged: boolean } | null;

type Thought = { kind: "answer"; answer: IntakeAnswer } | { kind: "late" } | { kind: "failed"; usageLimit: boolean };

const uncharged = (detail: string): Ran => ({ result: { kind: "error", detail, durationMs: 0 }, charged: false });

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
          return { result, charged: result.kind !== "usage_limit" && result.kind !== "auth_failed" };
        } catch (err) {
          if (!(err instanceof JobPendingError) && !(err instanceof ExecutorUnavailableError)) {
            return uncharged(`the executor failed: ${err instanceof Error ? err.name : "error"}`);
          }
        }
        if (performance.now() >= until) return null;
        await sleep(pollMs);
      }
    } finally {
      w.ids.forget(key);
    }
  }

  /** The model's answer to the transcript, asking once more when its answer can be fixed (`readIntake`'s `retry`). */
  async function think(d: TrackerDeps, convs: IntakeConversations, executor: Executor, user: User, conv: Conversation, transcript: IntakeLine[], types: IntakeType[], typing: () => Promise<void>): Promise<Thought> {
    let problem: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const spec = intakeJob({ now: localNow(user.timeZone, d.clock.now()), types, transcript, ...(problem !== null ? { problem } : {}) });
      const key = `intake:${conv.id}:${conv.turns + attempt + 1}`;
      convs.countTurn(conv.id, d.clock.now());
      const ran = await run(executor, spec, conv.id, key, typing);
      if (ran === null) return { kind: "late" };
      const { result } = ran;
      if (ran.charged) {
        await charge(d.store, { userId: user.id, taskId: null, source: "run", key, calls: 1, costUsd: result.totalCostUsd ?? null, at: d.clock.now() });
      }
      const read = readIntake(result, types);
      if (read.ok) return { kind: "answer", answer: read.answer };
      if (!read.retry) return { kind: "failed", usageLimit: result.kind === "usage_limit" };
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
    if (thought.kind === "late") return send(TOO_SLOW);
    if (thought.kind === "failed") return send(thought.usageLimit ? MODEL_BUSY : NOT_UNDERSTOOD);
    const { answer } = thought;
    const said: IntakeLine[] = [...transcript, { from: "bot", text: answer.reply }];
    const at = d.clock.now();
    if (answer.state === "ready" && answer.draft) {
      const saved = convs.saveTurn(conv.id, said, answer.draft, at);
      if (!saved) return send(STALE);
      return send(`${answer.reply}\n\n${draftText(answer.draft)}`, draftButtons(saved.id, saved.draftSeq));
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
    const original = interaction.message.content;
    const settle = async (status: string, keep = false) => {
      const suffix = `\n\n-- ${status}`;
      await interaction.editReply({ content: `${clip(original, MAX_ANSWER - suffix.length)}${suffix}`, ...(keep ? {} : { components: [] }), ...NO_MENTIONS });
    };
    const refuse = (content: string) => interaction.followUp({ content, ...EPHEMERAL });
    const d = w.deps();
    const convs = w.conversations();
    if (!d || !convs) {
      await refuse(STARTING);
      return true;
    }
    if (w.mode === "off") {
      await settle(STALE);
      return true;
    }
    const membership = await w.membership(interaction.user.id);
    const entry = await w.queue(() => enter(d, interaction.user.id, membership, "registered"));
    if (!entry.ok) {
      await refuse(entry.content);
      return true;
    }
    const user = entry.user;
    if (w.mode === "admins" && !user.admin) {
      await refuse(NOT_OPEN);
      return true;
    }
    const conv = convs.get(parsed.conversationId);
    if (!conv || conv.userId !== user.id || conv.status !== "open" || conv.draftSeq !== parsed.draftSeq || !conv.draft) {
      await settle(STALE);
      return true;
    }
    const now = d.clock.now();
    if (parsed.action === "cancel") {
      convs.end(conv.id, "cancelled", now);
      await settle(NOTHING_SAVED);
      return true;
    }
    if (parsed.action === "change") {
      convs.saveTurn(conv.id, [...conv.transcript, { from: "bot", text: CHANGE_ASK }], null, now);
      await settle(CHANGE_ASK);
      return true;
    }
    if (busy.has(user.id)) {
      await refuse(STILL_WORKING);
      return true;
    }
    busy.add(user.id);
    try {
      const draft = conv.draft;
      const writer: Writer = { d, queue: w.queue, reading, userId: user.id, arrived: performance.now() };
      const answer = await createAnswer(writer, user, { type: draft.type, ...draft.fields }, "");
      const body = answer.body as { task?: { id?: unknown }; message?: unknown; error?: { message?: unknown } };
      const taskId = typeof body.task?.id === "string" ? body.task.id : null;
      const at = d.clock.now();
      if (answer.status === 201 && taskId !== null) {
        convs.end(conv.id, "saved", at, taskId);
        convs.markCreatedInConversation(taskId);
        await settle(`Saved. ${typeof body.message === "string" ? body.message : ""}`.trim());
        return true;
      }
      // Refused by the editor's own rules: the person hears why, and the model does at the next turn.
      const why = typeof body.error?.message === "string" ? body.error.message : "it could not be saved.";
      convs.saveTurn(conv.id, [...conv.transcript, { from: "bot", text: `I could not save that: ${why}` }], null, at);
      await settle(`Not saved: ${why} Tell me what to change, or say stop.`);
      return true;
    } finally {
      busy.delete(user.id);
    }
  }

  return { directMessage, press };
}
