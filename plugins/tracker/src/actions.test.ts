import { describe, expect, it } from "bun:test";
import { fitTaskList, listTasks, MAX_ANSWER, type TrackerDeps } from "./actions.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * `/tasks` in one message (rackbops-bot-plugins#161): whole lines only, the paused tasks kept in
 * preference to the active ones that do not fit, what was left out counted, and `/web` named for the
 * rest while the web area is set up.
 */

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
    const text = fitTaskList(active, [], true);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => active.includes(l));
    // Every line is a whole active line, in order, or one of the two notes: nothing is cut.
    expect(lines).toEqual([...active.slice(0, shown.length), `...and ${40 - shown.length} more active.`, WEB]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length + (leftOut(text, "active") ?? 0)).toBe(40);
    // As many as fit: one more line would not have.
    const oneMore = [...active.slice(0, shown.length + 1), `...and ${40 - shown.length - 1} more active.`, WEB].join("\n");
    expect(oneMore.length).toBeGreaterThan(MAX_ANSWER);
  });

  it("paused tasks are kept when the active list is long", () => {
    const active = activeLines(40);
    const paused = pausedLines(3);
    const text = fitTaskList(active, paused, false);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => active.includes(l)).length;
    // On screen as documented: the active lines, their note, then every paused line.
    expect(lines).toEqual([...active.slice(0, shown), `...and ${40 - shown} more active.`, ...paused]);
    expect(leftOut(text, "paused")).toBeNull();
  });

  it("paused tasks alone over the limit keep as many as fit and count the rest", () => {
    const paused = pausedLines(40);
    const text = fitTaskList([], paused, false);
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER);
    const lines = text.split("\n");
    const shown = lines.filter((l) => paused.includes(l)).length;
    expect(shown).toBeGreaterThan(0);
    expect(lines).toEqual(["You have no active tasks.", ...paused.slice(0, shown), `...and ${40 - shown} more paused.`]);
    expect(shown + (leftOut(text, "paused") ?? 0)).toBe(40);

    // Beside active ones too, the paused lines take the room first: none of the active ones fit.
    const both = fitTaskList(activeLines(5), paused, false);
    expect(both.length).toBeLessThanOrEqual(MAX_ANSWER);
    expect(both.split("\n")).toEqual(["...and 5 more active.", ...paused.slice(0, shown), `...and ${40 - shown} more paused.`]);
  });

  it("the closing line points to /web only when the web area is set up, and is not there without it", () => {
    const active = activeLines(40);
    const paused = pausedLines(1);
    const withWeb = fitTaskList(active, paused, true);
    expect(withWeb.endsWith(`\n${paused[0]}\n${WEB}`)).toBe(true);
    const without = fitTaskList(active, paused, false);
    expect(without.endsWith(`\n${paused[0]}`)).toBe(true);
    expect(without).not.toContain("/web");
    expect(without).not.toContain("/task history");
  });

  it("cuts at the limit exactly, and leaves a line longer than a whole message out whole", () => {
    const active = activeLines(3);
    const whole = active.join("\n");
    expect(fitTaskList(active, [], false, whole.length)).toBe(whole);
    const short = fitTaskList(active, [], false, whole.length - 1);
    expect(short.length).toBeLessThanOrEqual(whole.length - 1);
    expect(short.split("\n")).toEqual([...active.slice(0, 2), "...and 1 more active."]);

    // One active line shorter than its note and the closing line together: fitting the paused lines
    // beside those two alone would drop one, yet the whole list, exactly at the limit, fits as it is.
    const tiny = ["`t1` x -- nothing due", ...pausedLines(3)];
    const tinyWhole = tiny.join("\n");
    expect(fitTaskList(tiny.slice(0, 1), tiny.slice(1), true, tinyWhole.length)).toBe(tinyWhole);

    const huge = `Paused: \`t9\` bins out -- I could not DM ${Array.from({ length: 300 }, (_, i) => `person ${i}`).join(", ")}; \`/task resume t9\` goes on without them.`;
    expect(huge.length).toBeGreaterThan(MAX_ANSWER);
    expect(fitTaskList(active, [huge], false)).toBe([...active, "...and 1 more paused."].join("\n"));
  });
});

describe("listTasks's paused lines", () => {
  const AT = "2026-10-01T12:00:00.000Z";

  /** An owner with three paused tasks, held for 10, 3 and no people; `/tasks` as they see it. */
  async function setup() {
    const store = new SqliteStore(openDatabase(":memory:"));
    const now = new Date(AT);
    const owner = await admit(store, "100000000000000000", now);
    const held: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const person = await admit(store, `2000000000000000${String(i).padStart(2, "0")}`, now);
      await store.updateUser(person.id, { displayName: `Person ${i}` });
      held.push(person.id);
    }
    const pauses: Record<string, string[]> = {};
    for (const [title, who] of [["bins out", held], ["stretch", held.slice(0, 3)], ["water", []]] as const) {
      const task = await store.createTask({
        ownerId: owner.id,
        type: "reminder",
        title,
        config: { text: title },
        schedule: { kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 },
        lane: "notify",
        capabilities: ["notify"],
        at: AT,
      });
      await store.updateTask(task.id, { status: "paused", at: AT });
      pauses[task.id] = [...who];
    }
    const d = { store, health: { pausesFor: (taskId: string) => pauses[taskId] ?? [] }, clock: { now: () => now }, webEditor: false } as unknown as TrackerDeps;
    return listTasks(d, owner);
  }

  it("name at most three people a task could not DM, then how many more; a task paused for no one shows its id and title", async () => {
    expect((await setup()).split("\n")).toEqual([
      "You have no active tasks.",
      "Paused: `t1` bins out -- I could not DM Person 1, Person 2, Person 3 and 7 more; `/task resume t1` goes on without them.",
      "Paused: `t2` stretch -- I could not DM Person 1, Person 2, Person 3; `/task resume t2` goes on without them.",
      "Paused: `t3` water",
    ]);
  });
});
