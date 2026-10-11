import { formatInstant, visibleFindings, visibleOccurrences, visibleSeries, visibleTask, type SeriesPoint, type Task, type User } from "@rackbops/docket-core";
import { MAX_NEW_PER_RUN, money } from "@rackbops/docket-types";
import { clip, MAX_ANSWER, type TrackerDeps } from "./actions.js";
import { taskHistory } from "./history.js";

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

/** `room`: the characters a want-list watch's findings may take (`findingLines`); the other series ignore it. */
export async function seriesLines(d: Pick<TrackerDeps, "store" | "clock" | "webEditor">, user: User, taskId: string, room = MAX_ANSWER): Promise<string[]> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (task?.type === "research" || task?.type === "scout" || task?.type === "wantlist" || task?.type === "wantjudge") return findingLines(d, user, task, room);
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

/**
 * A research request's, a scout's or a want-list watch's findings (docket 0.5.0), through `visibleFindings`: its checked claims or the items it showed, with their sources.
 * A research request or a scout lists its newest `SERIES_SHOWN`. A want-list watch, judged or not,
 * lists a run's worth, its newest `MAX_NEW_PER_RUN` (#166: its DM shows 5 and says `/task history`
 * lists them all), by whole lines within `room`: the newest that fit, then a line counting the rest.
 */
async function findingLines(d: Pick<TrackerDeps, "store" | "clock" | "webEditor">, user: User, task: Task, room: number): Promise<string[]> {
  const findings = (await visibleFindings(d.store, { userId: user.id, admin: user.admin }, task.id)) ?? [];
  if (findings.length === 0) return ["Findings: none yet"];
  const header = `Findings: ${findings.length}`;
  const want = task.type === "wantlist" || task.type === "wantjudge";
  // The source in <...>, so Discord shows the link without an embed, as the research DM does.
  const lines = findings.slice(want ? -MAX_NEW_PER_RUN : -SERIES_SHOWN).map((f) => `- ${clip(f.text, 200)}${f.source ? ` <${f.source}>` : ""}`);
  if (!want) return [header, ...lines];
  // The most of the newest that fit with the line counting the rest, tried from all down: that line can be longer than the one it stands for.
  for (let shown = lines.length; shown > 0; shown--) {
    const block = [header, ...lines.slice(lines.length - shown), ...leftOut(d, lines.length - shown)];
    if (block.join("\n").length <= room) return block;
  }
  return [header, ...leftOut(d, lines.length)];
}

/** The last line of a want-list watch's findings, when `count` of its run's worth did not fit; none when all did. */
function leftOut(d: Pick<TrackerDeps, "webEditor">, count: number): string[] {
  if (count === 0) return [];
  return [d.webEditor ? `...and ${count} more: the web area lists them all (\`/web\`).` : `...and ${count} more not shown here.`];
}

/** `/task history` with the series after the header and next-run lines, the whole cut to Discord's cap. */
export async function historyWithSeries(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const history = await taskHistory(d, user, taskId);
  const lines = history.split("\n");
  const rest = lines.slice(2).join("\n");
  const head = lines.slice(0, 2).join("\n");
  // A want watch's findings get what the head leaves with the rest's first line whole (`clip` puts its `...` on the next line).
  const room = MAX_ANSWER - head.length - 2 - Math.min(rest.length, (lines[2] ?? "").length + 4);
  const series = await seriesLines(d, user, taskId, room);
  if (series.length === 0) return history;
  const block = series.join("\n");
  return clip(`${head}\n${block}\n${clip(rest, Math.max(3, MAX_ANSWER - head.length - block.length - 2))}`);
}
