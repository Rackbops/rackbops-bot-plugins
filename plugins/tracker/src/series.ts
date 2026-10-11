import { formatInstant, visibleFindings, visibleOccurrences, visibleSeries, visibleTask, type SeriesPoint, type StoredFinding, type Task, type User } from "@rackbops/docket-core";
import { MAX_NEW_PER_RUN, money } from "@rackbops/docket-types";
import { clip, MAX_ANSWER, type Parts, type TrackerDeps } from "./actions.js";
import { FINDINGS_SHOWN, taskHistory } from "./history.js";

/**
 * The series part of `/task history` (rackbops-bot-plugins#81, plan 5.2 `series`): what a renewal
 * has cost period by period, and a price tracker's readings with the low and the high, through
 * docket's authorized read (`visibleSeries`: the owner, an accepted recipient, or an admin). Kept
 * beside history.ts rather than in it, and put after the history's first two lines.
 */

/** Points listed one by one; the totals count them all. */
export const SERIES_SHOWN = 8;

function pointLine(p: SeriesPoint, viewer: User, now: Date): string {
  const note = p.note && p.note !== "observed" ? ` (${p.note})` : "";
  return `- ${formatInstant(p.at, viewer.timeZone, now)} ${money(p.value, p.unit ?? "")}${note}`;
}

export async function seriesLines(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<string[]> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (task?.type === "research" || task?.type === "scout" || task?.type === "wantlist" || task?.type === "wantjudge") return findingLines(d, user, task);
  if (!task || (task.type !== "renewal" && task.type !== "price")) return [];
  const points = (await visibleSeries(d.store, actor, task.id)) ?? [];
  const now = d.clock.now();
  const lines: string[] = [];
  if (task.type === "renewal") {
    const paid = points.filter((p) => p.note === "keep" || p.note === "renewed");
    if (paid.length === 0) return ["Paid: nothing recorded yet"];
    const unit = paid.at(-1)?.unit ?? "";
    const total = paid.reduce((sum, p) => sum + p.value, 0);
    lines.push(`Paid: ${paid.length} period${paid.length === 1 ? "" : "s"}, ${money(total, unit)} in all`);
    for (const p of paid.slice(-SERIES_SHOWN)) lines.push(pointLine(p, user, now));
    return lines;
  }
  const runs = (await visibleOccurrences(d.store, actor, task.id)) ?? [];
  const checked = runs.filter((o) => o.status !== "queued" && o.summary).at(-1);
  if (checked?.summary) lines.push(`Last check: ${clip(checked.summary, 160)}`);
  if (points.length === 0) {
    lines.push("Prices: none read yet");
    return lines;
  }
  const unit = points.at(-1)?.unit ?? "";
  const values = points.map((p) => p.value);
  lines.push(`Prices: ${points.length} read, low ${money(Math.min(...values), unit)}, high ${money(Math.max(...values), unit)}`);
  for (const p of points.slice(-SERIES_SHOWN)) lines.push(pointLine(p, user, now));
  return lines;
}

/** A want-list watch, judged or not: its findings go in a message of their own (`wantFindings`, #166). */
function isWant(task: Task): boolean {
  return task.type === "wantlist" || task.type === "wantjudge";
}

/** One finding's line; the source in <...>, so Discord shows the link without an embed, as the research DM does. */
function findingLine(f: StoredFinding): string {
  return `- ${clip(f.text, 200)}${f.source ? ` <${f.source}>` : ""}`;
}

/**
 * A research request's, a scout's or a want-list watch's findings (docket 0.5.0), through `visibleFindings`: its checked claims or the items it showed, with their sources.
 * The count, then a research request's or a scout's newest `SERIES_SHOWN`; a want-list watch's are not listed here but in `wantFindings`.
 */
async function findingLines(d: Pick<TrackerDeps, "store">, user: User, task: Task): Promise<string[]> {
  const findings = (await visibleFindings(d.store, { userId: user.id, admin: user.admin }, task.id)) ?? [];
  if (findings.length === 0) return ["Findings: none yet"];
  const lines = [`Findings: ${findings.length}`];
  if (isWant(task)) return lines;
  for (const f of findings.slice(-SERIES_SHOWN)) lines.push(findingLine(f));
  return lines;
}

/**
 * A want-list watch's findings as `/task history`'s second message (#166: its DM shows 5 of a run's
 * up to `MAX_NEW_PER_RUN` and leaves the rest to `/task history`): a header, then the newest of a
 * run's worth, oldest to newest, as many whole lines as fit in one message with the header and the
 * last line; that line says how many are not listed and, while the web area is set up, that the
 * task's page there shows the newest `FINDINGS_SHOWN`. Null for any other task, and for a watch
 * with none yet.
 */
export async function wantFindings(d: Pick<TrackerDeps, "store" | "webEditor">, user: User, taskId: string): Promise<string | null> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (!task || !isWant(task)) return null;
  const findings = (await visibleFindings(d.store, actor, task.id)) ?? [];
  if (findings.length === 0) return null;
  const lines = findings.slice(-MAX_NEW_PER_RUN).map(findingLine);
  const message = (shown: number): string => {
    const left = findings.length - shown;
    const web = d.webEditor ? `; the web area's task page shows the newest ${FINDINGS_SHOWN} (\`/web\`).` : ".";
    return [`Findings (newest ${shown} of ${findings.length}):`, ...lines.slice(lines.length - shown), ...(left > 0 ? [`...and ${left} more${web}`] : [])].join("\n");
  };
  // The most of the newest that fit, tried from all down: the last line can be longer than the one it stands for.
  let shown = lines.length;
  while (shown > 0 && message(shown).length > MAX_ANSWER) shown--;
  return message(shown);
}

/**
 * `/task history` with the series after the header and next-run lines, the whole cut to Discord's
 * cap; for a want-list watch with findings, those follow as a second message (`wantFindings`).
 */
export async function historyWithSeries(d: TrackerDeps, user: User, taskId: string): Promise<string | Parts> {
  const history = await taskHistory(d, user, taskId);
  const series = await seriesLines(d, user, taskId);
  if (series.length === 0) return history;
  const lines = history.split("\n");
  const block = series.join("\n");
  const rest = lines.slice(2).join("\n");
  const head = lines.slice(0, 2).join("\n");
  const content = clip(`${head}\n${block}\n${clip(rest, Math.max(3, MAX_ANSWER - head.length - block.length - 2))}`);
  const findings = await wantFindings(d, user, taskId);
  return findings === null ? content : { content, more: [findings] };
}
