import { describe, expect, it } from "bun:test";
import { MAX_NEW_PER_RUN } from "@rackbops/docket-types";
import { MAX_ANSWER, type Parts, type TrackerDeps } from "./actions.js";
import { FINDINGS_SHOWN, taskHistory } from "./history.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { historyWithSeries, SERIES_SHOWN } from "./series.js";
import { SqliteStore } from "./store.js";

/**
 * `/task history`'s findings (#166): a want-list watch, judged or not, answers its history with the
 * `Findings: N` line and sends the findings as a second message -- up to a run's worth, the newest
 * `MAX_NEW_PER_RUN`, as many whole lines as fit, the newest kept -- counting the ones not listed and
 * pointing to the web area's task page only while the web area is set up; a research request and a
 * scout still list their newest `SERIES_SHOWN` in the one message.
 */

const OWNER = "111111111111111111";
const NOW = "2026-10-02T12:00:00.000Z";

type Found = { text: string; source: string };

const FILL = "of a long and very particular description ".repeat(5);

/** `count` findings, oldest first; with `pad`, each line is 101 + `pad` characters, so not all 20 fit. */
function found(count: number, pad?: number): Found[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return pad === undefined
      ? { text: `Listing ${n}`, source: `https://shop.example/p/${n}` }
      : { text: `Listing ${n} ${FILL.slice(0, pad)}`, source: `https://shop.example/products/listing-${n}-${"x".repeat(44)}` };
  });
}

const line = (f: Found): string => `- ${f.text} <${f.source}>`;

/** A task of `type` holding `findings`, each a minute after the last, `runs` failed runs with a long error, and `edits` edits. */
async function task(type: string, findings: Found[], webEditor = true, more: { runs?: number; edits?: number } = {}) {
  const store = new SqliteStore(openDatabase(":memory:"));
  const clock = { now: () => new Date(NOW) };
  const owner = await admit(store, OWNER, clock.now());
  const t = await store.createTask({ ownerId: owner.id, type, title: "Wingspan expansions", config: {}, schedule: null, lane: "notify", capabilities: ["notify"], at: NOW });
  for (const [i, f] of findings.entries()) {
    const at = new Date(Date.parse("2026-10-01T12:00:00.000Z") + i * 60_000).toISOString();
    await store.addFinding({ taskId: t.id, ownerId: owner.id, occurrenceId: null, key: `k${i}`, type, text: f.text, source: f.source, at });
  }
  for (let i = 0; i < (more.runs ?? 0); i++) {
    const at = new Date(Date.parse("2026-09-01T12:00:00.000Z") + i * 3600_000).toISOString();
    const o = await store.createOccurrence({ taskId: t.id, lane: "notify", dueAt: at, dedupeKey: `r${i}`, at });
    if (o) await store.updateOccurrence(o.id, { status: "failed", error: `the shop's page did not answer in time, read ${i + 1} ${"of a long and slow afternoon ".repeat(3)}` });
  }
  for (let i = 0; i < (more.edits ?? 0); i++) await store.addTaskEvent({ taskId: t.id, actorId: owner.id, kind: "edited", detail: "", at: NOW });
  const d = { store, clock, webEditor } as unknown as TrackerDeps;
  return { d, owner, id: t.id };
}

/** `/task history`'s answer for a task of `type` holding `findings`. */
async function history(type: string, findings: Found[], webEditor = true, more: { runs?: number; edits?: number } = {}): Promise<string | Parts> {
  const t = await task(type, findings, webEditor, more);
  return historyWithSeries(t.d, t.owner, t.id);
}

/** A want watch's answer: the history, and its findings as the one message after it. */
function twoMessages(answer: string | Parts): { first: string; second: string } {
  if (typeof answer === "string") throw new Error(`one message, not two: ${answer}`);
  expect(answer.more).toHaveLength(1);
  return { first: answer.content, second: answer.more[0] ?? "" };
}

/** A message's finding lines, in order. */
const listed = (message: string): string[] => message.split("\n").filter((l) => l.startsWith("- Listing "));

/** The second message's last line, when `count` findings are not listed. */
const note = (count: number, web = true): string => `...and ${count} more${web ? `; the web area's task page shows the newest ${FINDINGS_SHOWN} (\`/web\`).` : "."}`;

/**
 * A want watch's second message for its findings `all`: the header, whole lines, the newest of a
 * run's worth, oldest to newest, then the note counting the rest exactly (none when none is left),
 * all within one message, and as many as fit. Returns how many it lists.
 */
function expectFitted(second: string, all: Found[], web = true): number {
  expect(second.length).toBeLessThanOrEqual(MAX_ANSWER);
  const shown = listed(second);
  const k = shown.length;
  const n = all.length;
  expect(k).toBeLessThanOrEqual(MAX_NEW_PER_RUN);
  // Whole lines (none cut, so each is one finding's whole line), the newest, oldest to newest.
  expect(shown).toEqual(all.slice(n - k).map(line));
  expect(second.split("\n")).toEqual([`Findings (newest ${k} of ${n}):`, ...shown, ...(k < n ? [note(n - k, web)] : [])]);
  // As many as fit: no more lines, with their header and note, would have.
  for (let more = k + 1; more <= Math.min(n, MAX_NEW_PER_RUN); more++) {
    const fuller = [`Findings (newest ${more} of ${n}):`, ...all.slice(n - more).map(line), ...(more < n ? [note(n - more, web)] : [])];
    expect(fuller.join("\n").length).toBeGreaterThan(MAX_ANSWER);
  }
  return k;
}

describe("/task history's findings", () => {
  it("a want watch's history lists a whole run of 20 short findings in a second message", async () => {
    expect(MAX_NEW_PER_RUN).toBe(20);
    for (const type of ["wantlist", "wantjudge"]) {
      const all = found(20);
      const { first, second } = twoMessages(await history(type, all));
      // The first message counts them and lists none; the second lists all 20, oldest to newest, and no note.
      expect(first).toBe(`\`t1\` Wingspan expansions -- ${type}, active, no schedule\nNext: nothing scheduled\nFindings: 20\nRuns: none yet\nChanges:`);
      expect(second).toBe(["Findings (newest 20 of 20):", ...all.map(line)].join("\n"));
    }
  });

  it("a want watch's history keeps whole lines in its second message and counts the rest", async () => {
    for (const type of ["wantlist", "wantjudge"]) {
      const all = found(20, 138);
      expect(all.map(line)[0]?.length).toBe(239);
      const { first, second } = twoMessages(await history(type, all));
      expect(first).toContain("\nFindings: 20\nRuns: none yet\nChanges:");
      expect(listed(first)).toEqual([]);
      expect(expectFitted(second, all)).toBeLessThan(20);
    }
  });

  it("a want watch's second message fits whole lines at and around the limit, whatever their length", async () => {
    // Each step lengthens every line by one, moving the message's end across the cap by more than a line's width.
    for (let pad = 130; pad < 178; pad++) {
      const all = found(20, pad);
      expect(expectFitted(twoMessages(await history("wantlist", all)).second, all)).toBeLessThan(20);
    }
    // All 20 can fit where the newest 19 and the note do not: the oldest line (40 characters) is shorter than the note.
    const counts = new Set<number>();
    for (let pad = 0; pad < 100; pad++) {
      const all = found(20).map((f, i) => (i === 0 ? f : { text: `${f.text} ${FILL.slice(0, i === 19 ? pad : 60)}`, source: f.source }));
      counts.add(expectFitted(twoMessages(await history("wantlist", all)).second, all));
    }
    expect(counts.has(20)).toBe(true);
    expect([...counts].some((n) => n < 20)).toBe(true);
  });

  it("a want watch with 25 short findings lists its newest 20 and says 5 more", async () => {
    const all = found(25);
    const { first, second } = twoMessages(await history("wantlist", all));
    expect(first).toContain("\nFindings: 25\n");
    expect(second).toBe(["Findings (newest 20 of 25):", ...all.slice(-20).map(line), "...and 5 more; the web area's task page shows the newest 50 (`/web`)."].join("\n"));
  });

  it("the note points to /web only when the web area is set up", async () => {
    const all = found(20, 138);
    const withWeb = twoMessages(await history("wantlist", all, true)).second;
    const without = twoMessages(await history("wantlist", all, false)).second;
    const k = expectFitted(without, all, false);
    expect(k).toBeLessThan(20);
    expect(without.endsWith(`\n...and ${20 - k} more.`)).toBe(true);
    expect(without).not.toContain("/web");
    expect(without).not.toContain("web area");
    // With the web area, the same listings (the pointer is on the last line only, so it may take one).
    const kWeb = expectFitted(withWeb, all, true);
    expect(withWeb.endsWith(`\n...and ${20 - kWeb} more; the web area's task page shows the newest 50 (\`/web\`).`)).toBe(true);
  });

  it("a want watch's first message keeps a long history's runs and changes, as before", async () => {
    const all = found(20, 138);
    const t = await task("wantlist", all, true, { runs: 12, edits: 6 });
    const { first, second } = twoMessages(await historyWithSeries(t.d, t.owner, t.id));
    // The history as it was before #166, with the count after its first two lines and no finding.
    const lines = (await taskHistory(t.d, t.owner, t.id)).split("\n");
    expect(first).toBe([...lines.slice(0, 2), "Findings: 20", ...lines.slice(2)].join("\n"));
    expect(first.length).toBeLessThanOrEqual(MAX_ANSWER);
    expect(first).toContain("\nRuns:\n- (2 earlier)\n");
    expect(first.split("\n").filter((l) => l.includes(" -- failed: the shop's page did not answer in time, read "))).toHaveLength(10);
    expect(first).toContain("read 12 of a long");
    expect(first).toContain("\nChanges:\n- (1 earlier)\n");
    expect(first.split("\n").filter((l) => l.endsWith(" edited"))).toHaveLength(5);
    // The listings would not have fit beside it: they are in the second message.
    expect(`${first}\n${listed(second).join("\n")}`.length).toBeGreaterThan(MAX_ANSWER);
    expect(listed(second).length).toBeGreaterThan(0);
  });

  it("a want watch with no findings yet answers in one message", async () => {
    const answer = await history("wantjudge", []);
    expect(typeof answer).toBe("string");
    expect(answer).toContain("\nFindings: none yet\nRuns: none yet");
  });

  it("a want watch's finding whose line alone passes a message is counted, never cut", async () => {
    const all = [...found(2), { text: "Listing 03", source: `https://shop.example/p/${"x".repeat(MAX_ANSWER)}` }];
    const { second } = twoMessages(await history("wantlist", all));
    expect(second).toBe(["Findings (newest 0 of 3):", note(3)].join("\n"));
  });

  it("research and scout still show the newest 8 in one message, long findings too", async () => {
    for (const type of ["research", "scout"]) {
      for (const all of [found(20), found(20, 99)]) {
        const answer = await history(type, all);
        if (typeof answer !== "string") throw new Error(`${type} answered in two messages`);
        expect(answer.length).toBeLessThanOrEqual(MAX_ANSWER);
        expect(answer).toContain("\nFindings: 20\n");
        expect(listed(answer)).toEqual(all.slice(-SERIES_SHOWN).map(line));
        expect(answer).not.toContain("more");
        expect(answer).toContain("\nRuns: none yet\nChanges:");
      }
    }
  });
});
