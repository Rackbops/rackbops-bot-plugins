import { type Actor, createTask, formatInstant, parseWhen, type User } from "@rackbops/docket-core";
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, type ResearchConfig } from "@rackbops/docket-types";
import { clip, liveTaskCap, said, type TaskResult, type TrackerDeps } from "./actions.js";
import { MAX_TITLE, MAX_WHEN } from "./limits.js";

/**
 * The one-off research request (category 5, plan 1.2 row 5; rackbops-bot-plugins#82): `/research`'s
 * rules over docket's `research` type, which runs on the execute lane through city-hall and the
 * runner (executor.ts, execute-lane.ts). Mapped as docket's core README "Adopting 0.5.0" says: the
 * optional `at` becomes the schedule `{ kind: "once", at: at ?? now }`, the optional `deadline` goes
 * into `config.deadline` as an ISO instant. The type declares only `notify` (tier 0), which
 * `createTask` grants; the plugin has no grants of its own to add. The budgets are docket's (5.7):
 * the execute lane checks the owner's and the global daily ceilings before each run and tells the
 * person and the admins once at a ceiling.
 */

export { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS } from "@rackbops/docket-types";

/** Research requests one person may have waiting or running at once: each is up to about 3 USD of model runs. */
export const MAX_LIVE_RESEARCH = 5;

export const RESEARCH_OFF = "Research is not available on this bot yet: it needs the model runner, which is not set up here.";

/** Fewer than this many characters in `question` is refused (a stray "0" once went in that way). */
export const MIN_QUESTION_CHARS = 3;

export const SHORT_QUESTION =
  `Put the whole question in \`question\`: it needs at least ${MIN_QUESTION_CHARS} characters, with a letter in it. \`context\` is only for background.`;

/**
 * A question that is a stray character or two, or has no letter at all ("0"): what lands in
 * `question` when the real question went into `context` by mistake (task t2 on Clerk, 2026-10-04).
 * Refused before anything is made, so no model run is paid for it.
 */
function tooShort(question: string): boolean {
  return question.length < MIN_QUESTION_CHARS || !/\p{L}/u.test(question);
}

export interface ResearchInput {
  question: string;
  context?: string;
  at?: string;
  deadline?: string;
}

/** `/research question [context] [deadline] [at]`: one request, answered once by DM after a reviewer checks it. */
export async function createResearch(d: TrackerDeps, user: User, input: ResearchInput): Promise<TaskResult> {
  const type = d.types.research;
  if (!type || !d.research) return { ok: false, error: RESEARCH_OFF };
  const question = input.question.trim();
  if (question.length === 0) return { ok: false, error: "Say what to look into." };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, error: `That question is longer than ${MAX_QUESTION_CHARS} characters.` };
  if (tooShort(question)) return { ok: false, error: SHORT_QUESTION };
  const context = input.context?.trim() ?? "";
  if (context.length > MAX_CONTEXT_CHARS) return { ok: false, error: `\`context\` is longer than ${MAX_CONTEXT_CHARS} characters.` };
  const now = d.clock.now();
  const when = (raw: string | undefined, name: string): Date | null | string => {
    if (raw === undefined || raw.trim() === "") return null;
    if (raw.trim().length > MAX_WHEN) return `\`${name}\` is longer than ${MAX_WHEN} characters.`;
    const parsed = parseWhen(raw, now, { zone: user.timeZone, defaultHour: user.preferredHour });
    return parsed.ok ? parsed.at : `\`${name}\`: ${parsed.error}`;
  };
  const at = when(input.at, "at");
  if (typeof at === "string") return { ok: false, error: at };
  const deadline = when(input.deadline, "deadline");
  if (typeof deadline === "string") return { ok: false, error: deadline };
  const start = at ?? now;
  if (deadline && deadline.getTime() <= Math.max(start.getTime(), now.getTime())) return { ok: false, error: "The deadline has to be after the research starts." };

  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  const live = [...(await d.store.listTasks({ ownerId: user.id, status: "active", type: "research" })), ...(await d.store.listTasks({ ownerId: user.id, status: "paused", type: "research" }))];
  if (live.length >= MAX_LIVE_RESEARCH) {
    return { ok: false, error: `You already have ${MAX_LIVE_RESEARCH} research requests waiting, the most one person may. Wait for one to be answered first.` };
  }

  const config: ResearchConfig = {
    question,
    ...(context.length > 0 ? { context } : {}),
    ...(deadline ? { deadline: deadline.toISOString() } : {}),
  };
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task } = await createTask(d.store, actor, user, { type, title: clip(question, MAX_TITLE), config, schedule: { kind: "once", at: start.toISOString() } }, now);
  const starts = at ? `Starts ${formatInstant(at, user.timeZone, now)}` : "Starts within a minute or two";
  const by = deadline ? `; past ${formatInstant(deadline, user.timeZone, now)} nothing is run` : "";
  return {
    ok: true,
    task,
    text: clip(
      `Research \`${task.id}\` queued: ${clip(question, 200)}\n${starts}${by}. A second run checks the answer against its sources before I DM it to you, so it can take a while; ` +
        "an answer that does not pass the check is not sent. Requests share a daily budget.",
    ),
  };
}

export async function researchCommand(d: TrackerDeps, user: User, input: ResearchInput): Promise<string> {
  return said(await createResearch(d, user, input));
}
