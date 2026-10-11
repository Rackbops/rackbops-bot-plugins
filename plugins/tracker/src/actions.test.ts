import { describe, expect, it } from "bun:test";
import { fitTaskList, MAX_ANSWER } from "./actions.js";

/**
 * `/tasks` in one message (rackbops-bot-plugins#161): whole lines only, the paused tasks kept before
 * the active ones, and what was left out counted and pointed to.
 */

const HISTORY = "`/task history <id>` still works for any of them.";
const WEB = "The web area lists them all: `/web`.";

/** `n` docket-shaped active lines, each about 80 characters: 40 of them are well over one message. */
const activeLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `\`t${i + 1}\` water the plants on the back porch, pot ${i + 1} -- next Fri Oct 2, 8:00, daily at 8:00`);
const pausedLines = (n: number, from = 101) =>
  Array.from({ length: n }, (_, i) => `Paused: \`t${from + i}\` bins out, week ${i + 1} -- I could not DM Curly; \`/task resume t${from + i}\` goes on without them.`);

/** The count in a `...and N more <what>.` line, or null when there is none. */
function leftOut(text: string, what: "active" | "paused"): number | null {
  const m = text.match(new RegExp(`^\\.\\.\\.and (\\d+) more ${what}\\.$`, "m"));
  return m ? Number(m[1]) : null;
}

describe("fitTaskList", () => {
  it("a short list is shown whole, with no note", () => {
    const active = activeLines(2);
    const paused = pausedLines(1);
    expect(fitTaskList(active, paused, true)).toBe([...active, ...paused].join("\n"));
    expect(fitTaskList([], [], true)).toBe("You have no active tasks.");
    expect(fitTaskList([], paused, false)).toBe(["You have no active tasks.", ...paused].join("\n"));
  });

  it("40 active tasks fit whole lines and say how many are left out", () => {
    const active = activeLines(40);
    const text = fitTaskList(active, [], false);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => active.includes(l));
    // Every line is a whole active line, in order, or one of the two notes: nothing is cut.
    expect(lines).toEqual([...active.slice(0, shown.length), `...and ${40 - shown.length} more active.`, HISTORY]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length + (leftOut(text, "active") ?? 0)).toBe(40);
    // As many as fit: one more line would not have.
    const oneMore = [...active.slice(0, shown.length + 1), `...and ${40 - shown.length - 1} more active.`, HISTORY].join("\n");
    expect(oneMore.length).toBeGreaterThan(MAX_ANSWER);
  });

  it("paused tasks are kept when the active list is long", () => {
    const active = activeLines(40);
    const paused = pausedLines(3);
    const text = fitTaskList(active, paused, false);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => active.includes(l)).length;
    // On screen as documented: the active lines, their note, then every paused line, then the closing line.
    expect(lines).toEqual([...active.slice(0, shown), `...and ${40 - shown} more active.`, ...paused, HISTORY]);
    expect(leftOut(text, "paused")).toBeNull();
  });

  it("paused tasks alone over the limit keep as many as fit and count the rest", () => {
    const paused = pausedLines(40);
    const text = fitTaskList([], paused, false);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => paused.includes(l)).length;
    expect(shown).toBeGreaterThan(0);
    expect(lines).toEqual(["You have no active tasks.", ...paused.slice(0, shown), `...and ${40 - shown} more paused.`, HISTORY]);
    expect(shown + (leftOut(text, "paused") ?? 0)).toBe(40);

    // Beside active ones too, the paused lines take the room first: none of the active ones fit.
    const both = fitTaskList(activeLines(5), paused, false);
    expect(both.length).toBeLessThanOrEqual(MAX_ANSWER);
    expect(both.split("\n")).toEqual(["...and 5 more active.", ...paused.slice(0, shown), `...and ${40 - shown} more paused.`, HISTORY]);
  });

  it("the closing line points to /web only when the web area is set up", () => {
    const active = activeLines(40);
    const withWeb = fitTaskList(active, pausedLines(1), true);
    expect(withWeb.endsWith(`\n${WEB}`)).toBe(true);
    expect(withWeb).not.toContain(HISTORY);
    const without = fitTaskList(active, pausedLines(1), false);
    expect(without.endsWith(`\n${HISTORY}`)).toBe(true);
    expect(without).not.toContain("/web");
  });

  it("cuts at the limit exactly, and leaves a line longer than a whole message out whole", () => {
    const active = activeLines(3);
    const whole = active.join("\n");
    expect(fitTaskList(active, [], false, whole.length)).toBe(whole);
    const short = fitTaskList(active, [], false, whole.length - 1);
    expect(short.length).toBeLessThanOrEqual(whole.length - 1);
    expect(short.split("\n")).toEqual([...active.slice(0, 2), "...and 1 more active.", HISTORY]);

    // One active line shorter than its note and the closing line together: fitting the paused lines
    // beside those two alone would drop one, yet the whole list, exactly at the limit, fits as it is.
    const tiny = ["`t1` x -- nothing due", ...pausedLines(3)];
    const tinyWhole = tiny.join("\n");
    expect(fitTaskList(tiny.slice(0, 1), tiny.slice(1), false, tinyWhole.length)).toBe(tinyWhole);

    const huge = `Paused: \`t9\` bins out -- I could not DM ${Array.from({ length: 300 }, (_, i) => `person ${i}`).join(", ")}; \`/task resume t9\` goes on without them.`;
    expect(huge.length).toBeGreaterThan(MAX_ANSWER);
    expect(fitTaskList(active, [huge], false)).toBe([...active, "...and 1 more paused.", HISTORY].join("\n"));
  });
});
