import { describe, expect, it } from "bun:test";
import { MAX_NEW_PER_RUN } from "@rackbops/docket-types";
import { MAX_ANSWER, type TrackerDeps } from "./actions.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { historyWithSeries, SERIES_SHOWN } from "./series.js";
import { SqliteStore } from "./store.js";

/**
 * `/task history`'s findings (#166): a want-list watch, judged or not, lists a run's worth -- the
 * newest `MAX_NEW_PER_RUN` -- by whole lines within one message, the newest kept, and counts the ones
 * that do not fit, pointing to `/web` only while the web area is set up; a research request and a
 * scout still list their newest `SERIES_SHOWN`.
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

/** The answer to `/task history` for a task of `type` holding `findings`, each a minute after the last. */
async function history(type: string, findings: Found[], webEditor = true): Promise<string> {
  const store = new SqliteStore(openDatabase(":memory:"));
  const clock = { now: () => new Date(NOW) };
  const owner = await admit(store, OWNER, clock.now());
  const task = await store.createTask({ ownerId: owner.id, type, title: "Wingspan expansions", config: {}, schedule: null, lane: "notify", capabilities: ["notify"], at: NOW });
  for (const [i, f] of findings.entries()) {
    const at = new Date(Date.parse("2026-10-01T12:00:00.000Z") + i * 60_000).toISOString();
    await store.addFinding({ taskId: task.id, ownerId: owner.id, occurrenceId: null, key: `k${i}`, type, text: f.text, source: f.source, at });
  }
  return historyWithSeries({ store, clock, webEditor } as unknown as TrackerDeps, owner, task.id);
}

/** The answer's finding lines, in order. */
const listed = (answer: string): string[] => answer.split("\n").filter((l) => l.startsWith("- Listing "));

const webNote = (count: number): string => `...and ${count} more: the web area lists them all (\`/web\`).`;

/**
 * A want watch's answer for its 20 findings `all`: whole lines, the newest, oldest to newest, the
 * rest counted, the header and the rest's first line whole, and as many as fit. Returns how many it shows.
 */
function expectFitted(answer: string, all: Found[], type: string): number {
  expect(answer.length).toBeLessThanOrEqual(MAX_ANSWER);
  const lines = answer.split("\n");
  const shown = listed(answer);
  // Whole lines (none cut, so each is one finding's whole line), the newest, oldest to newest.
  expect(shown.length).toBeGreaterThan(1);
  expect(shown).toEqual(all.slice(20 - shown.length).map(line));
  // The header lines and the Findings line first; after the lines, the note counting the rest exactly (none when none is left), then the rest's first line, whole.
  expect(lines.slice(0, 3)).toEqual([`\`t1\` Wingspan expansions -- ${type}, active, no schedule`, "Next: nothing scheduled", "Findings: 20"]);
  const note = shown.length < 20 ? [webNote(20 - shown.length)] : [];
  const after = lines.indexOf(shown.at(-1) ?? "") + 1;
  expect(lines.slice(after, after + note.length + 1)).toEqual([...note, "Runs: none yet"]);
  // As many as fit: no more lines, with their note, would have, with the rest's first line whole and `...` after it.
  for (let more = shown.length + 1; more <= 20; more++) {
    const fuller = [...lines.slice(0, 3), ...all.slice(20 - more).map(line), ...(more < 20 ? [webNote(20 - more)] : []), "Runs: none yet", "..."];
    expect(fuller.join("\n").length).toBeGreaterThan(MAX_ANSWER);
  }
  return shown.length;
}

describe("/task history's findings", () => {
  it("a want watch's history lists a whole run of 20 short findings", async () => {
    expect(MAX_NEW_PER_RUN).toBe(20);
    for (const type of ["wantlist", "wantjudge"]) {
      const all = found(25);
      const answer = await history(type, all);
      expect(answer).toContain("Findings: 25");
      // The run's worth, oldest to newest, and no note: all of them fit.
      expect(listed(answer)).toEqual(all.slice(-20).map(line));
      expect(answer).not.toContain("more");
      expect(answer).toContain("\nRuns: none yet\nChanges:");
    }
  });

  it("a want watch's history keeps whole lines and counts the rest", async () => {
    for (const type of ["wantlist", "wantjudge"]) {
      const all = found(20, 138);
      expect(all.map(line)[0]?.length).toBe(239);
      expect(expectFitted(await history(type, all), all, type)).toBeLessThan(20);
    }
  });

  it("a want watch's history fits whole lines at and around the limit, whatever their length", async () => {
    // Each step lengthens every line by one, moving the block's end across the room by more than a line's width.
    for (let pad = 130; pad < 178; pad++) {
      const all = found(20, pad);
      expect(expectFitted(await history("wantlist", all), all, "wantlist")).toBeLessThan(20);
    }
    // All 20 can fit where the newest 19 and the note do not: the oldest line (40 characters) is shorter than the note.
    const counts = new Set<number>();
    for (let pad = 120; pad < 170; pad++) {
      const all = found(20).map((f, i) => (i === 0 ? f : { text: `${f.text} ${FILL.slice(0, i === 19 ? pad : 50)}`, source: f.source }));
      counts.add(expectFitted(await history("wantlist", all), all, "wantlist"));
    }
    expect(counts.has(20)).toBe(true);
    expect([...counts].some((n) => n < 20)).toBe(true);
  });

  it("the note points to /web only when the web area is set up", async () => {
    const all = found(20, 138);
    const withWeb = await history("wantlist", all, true);
    const without = await history("wantlist", all, false);
    const shown = listed(without);
    expect(shown.length).toBeLessThan(20);
    expect(withWeb).toMatch(/\n\.\.\.and \d+ more: the web area lists them all \(`\/web`\)\.\n/);
    expect(without).toContain(`\n...and ${20 - shown.length} more not shown here.\n`);
    expect(without).not.toContain("/web");
    expect(without).not.toContain("web area");
  });

  it("research and scout still show the newest 8", async () => {
    for (const type of ["research", "scout"]) {
      const all = found(20);
      const answer = await history(type, all);
      expect(answer).toContain("Findings: 20");
      expect(listed(answer)).toEqual(all.slice(-SERIES_SHOWN).map(line));
      expect(answer).not.toContain("more");
    }
  });
});
