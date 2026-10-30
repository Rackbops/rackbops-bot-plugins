import { describeSchedule, formatInstant, nextDue, type Schedule, scheduleProblems, type User } from "@rackbops/docket-core";
import { liveTaskCap, type TrackerDeps } from "../actions.js";
import { reminderPlan } from "../reminders.js";
import { liveNews, MAX_LIVE_NEWS, NEWS_CAP, NEWS_OFF, newsPlan, newsSchedule } from "../news.js";
import { RESEARCH_OFF } from "../research.js";
import { liveScouts, MAX_LIVE_SCOUTS, SCOUT_CAP, SCOUT_OFF, scoutPlan, scoutSchedule } from "../scout.js";
import { renewalPlan } from "../tracked.js";
import { type ApiAnswer, asFields, offeredTypes, problem, refusal } from "./api-tasks.js";
import { NEW_TYPES, type NewType } from "./editor-pages.js";
import { newsInput, reminderInput, renewalInput, scoutInput } from "./form-input.js";

/**
 * `POST /tasks/validate` (rackbops-bot-plugins#369): a create's body, checked as `POST /tasks` would
 * check it, and nothing written. For a reminder, a renewal and a scout every rule their create runs
 * before it writes is run here too -- the type's own plan (reminders.ts, tracked.ts, scout.ts), the
 * live-task cap and the scout cap -- and the answer says when it would first run and the run after,
 * in the owner's zone, from the schedule the create would store. A price, a want-list watch and a
 * research request get their fields (names and JSON types) and the live-task cap checked, and none of
 * their type's own checks: their create reads a page or a source, or asks the model runner, so the
 * rest is known only when it is made.
 *
 * Nothing here takes the write queue or writes: a validate run in parallel with a create can pass
 * and the create still meet a cap, which is why the answer is advice, never a reservation.
 */

/** Where docket-core's `materialize` starts looking for a new task's first run (its private
 *  `firstDueAfter`, for a task with no runs yet): a one-off from the start of time, a poll from its
 *  own start, any other schedule from now. */
function firstDueAfter(schedule: Schedule, now: Date): Date {
  if (schedule.kind === "once") return new Date(0);
  if (schedule.kind === "poll") return new Date(Date.parse(schedule.start) - 1);
  return now;
}

/**
 * The first two runs the schedule gives, as the scheduler would place them for this owner. A renewal
 * whose first ask is already due (tracked.ts's `firstAskIfDue`: due within its lead) is stored at that
 * ask's own, past, instant, so it is asked at once; `first` is that instant, as the task's `nextAt`.
 */
function runs(schedule: Schedule, user: User, now: Date, renewal: boolean): { first: Date | null; second: Date | null } {
  const ctx = { zone: user.timeZone, preferredHour: user.preferredHour };
  if (renewal) {
    const ask = nextDue(schedule, new Date(0), ctx);
    if (ask && ask.getTime() <= now.getTime()) return { first: ask, second: nextDue(schedule, now, ctx) };
  }
  const first = nextDue(schedule, firstDueAfter(schedule, now), ctx);
  return { first, second: first && schedule.kind !== "once" ? nextDue(schedule, first, ctx) : null };
}

export async function validateAnswer(d: TrackerDeps, user: User, body: Record<string, unknown>): Promise<ApiAnswer> {
  const type = body.type;
  if (typeof type !== "string" || !(NEW_TYPES as readonly string[]).includes(type)) {
    return problem(400, "invalid", `\`type\` is one of ${offeredTypes(d).join(", ")}.`);
  }
  if (type === "research" && !d.research) return refusal(RESEARCH_OFF);
  if (type === "scout" && (!d.types.scout || !d.research)) return refusal(SCOUT_OFF);
  if (type === "news" && (!d.types.news || !d.research)) return refusal(NEWS_OFF);
  // The create's own "not available" refusals for the types it checks in full (reminders.ts, tracked.ts).
  if (type === "reminder" && !d.types.reminder) return refusal("Reminders are not available on this bot.");
  if (type === "renewal" && !d.types.renewal) return refusal("Renewals are not available on this bot.");
  const form = asFields(body, type as NewType, "new");
  if (!(form instanceof URLSearchParams)) return form;
  const now = d.clock.now();

  let schedule: Schedule | null = null;
  if (type === "reminder") {
    const plan = reminderPlan(d, user, reminderInput(form));
    if (!plan.ok) return refusal(plan.error);
    schedule = plan.schedule;
  } else if (type === "renewal") {
    const plan = renewalPlan(d, user, renewalInput(form));
    if (!plan.ok) return refusal(plan.error);
    schedule = plan.schedule;
  } else if (type === "scout") {
    const plan = scoutPlan(scoutInput(form));
    if (!plan.ok) return refusal(plan.error);
    schedule = scoutSchedule(plan.every, user.timeZone, now);
  } else if (type === "news") {
    const plan = newsPlan(newsInput(form));
    if (!plan.ok) return refusal(plan.error);
    schedule = newsSchedule(plan.every, user.timeZone, now);
  }
  // The caps the create checks, in its order: every live task, then scouts or news watches.
  const capped = await liveTaskCap(d, user);
  if (capped) return refusal(capped);
  if (type === "scout" && (await liveScouts(d, user)) >= MAX_LIVE_SCOUTS) {
    return refusal(SCOUT_CAP);
  }
  if (type === "news" && (await liveNews(d, user)) >= MAX_LIVE_NEWS) return refusal(NEWS_CAP);

  if (schedule === null) {
    return {
      status: 200,
      body: {
        valid: true,
        type,
        checked: "fields",
        message: `The fields of that ${type} are right, and you are under the live-task cap. The rest is checked when it is made: ${type === "research" ? "the model runner takes it then" : "its page or source is read then"}. Nothing was made.`,
      },
    };
  }
  const problems = scheduleProblems(schedule);
  if (problems.length > 0) return refusal(`That schedule does not work: ${problems.join("; ")}.`);
  const { first, second: then } = runs(schedule, user, now, type === "renewal");
  const cadence = describeSchedule(schedule, user, user.timeZone, now);
  return {
    status: 200,
    body: {
      valid: true,
      type,
      checked: "full",
      timeZone: user.timeZone,
      cadence,
      firstAt: first?.toISOString() ?? null,
      thenAt: then?.toISOString() ?? null,
      message: first
        ? `That ${type} would first run ${first.getTime() <= now.getTime() ? "at once" : formatInstant(first.toISOString(), user.timeZone, now)}${then ? `, then ${formatInstant(then.toISOString(), user.timeZone, now)}` : ""} (${cadence}). Nothing was made.`
        : `That ${type} would never run: its time has no next run. Nothing was made.`,
    },
  };
}
