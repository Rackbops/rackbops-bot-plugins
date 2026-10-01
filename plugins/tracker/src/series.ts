import { formatInstant, visibleFindings, visibleOccurrences, visibleSeries, visibleTask, type SeriesPoint, type User } from "@rackbops/docket-core";
import { money } from "@rackbops/docket-types";
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

export async function seriesLines(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<string[]> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (task?.type === "research") return findingLines(d, user, task.id);
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

/** A research request's findings (docket 0.5.0), through `visibleFindings`: its checked claims and their sources. */
async function findingLines(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<string[]> {
  const findings = (await visibleFindings(d.store, { userId: user.id, admin: user.admin }, taskId)) ?? [];
  if (findings.length === 0) return ["Findings: none yet"];
  const lines = [`Findings: ${findings.length}`];
  // The source in <...>, so Discord shows the link without an embed, as the research DM does.
  for (const f of findings.slice(-SERIES_SHOWN)) lines.push(`- ${clip(f.text, 200)}${f.source ? ` <${f.source}>` : ""}`);
  return lines;
}

/** `/task history` with the series after the header and next-run lines, the whole cut to Discord's cap. */
export async function historyWithSeries(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const history = await taskHistory(d, user, taskId);
  const series = await seriesLines(d, user, taskId);
  if (series.length === 0) return history;
  const lines = history.split("\n");
  const block = series.join("\n");
  const rest = lines.slice(2).join("\n");
  const head = lines.slice(0, 2).join("\n");
  return clip(`${head}\n${block}\n${clip(rest, Math.max(3, MAX_ANSWER - head.length - block.length - 2))}`);
}
