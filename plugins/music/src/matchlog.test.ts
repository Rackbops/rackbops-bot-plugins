import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildResult, SongTrace } from "./build.js";
import {
  appendRun,
  initMatchLog,
  MAX_RUNS,
  recordRun,
  resetMatchLogForTest,
  summarize,
  toMatchRun,
  type MatchLogFile,
  type MatchRun,
} from "./matchlog.js";
import type { Setlist } from "./setlistfm.js";
import type { PluginLog } from "../../../packages/api/contract.js";
import { makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";

const AT = "2026-09-20T12:00:00.000Z";

function setlist(overrides: Partial<Setlist> = {}): Setlist {
  return {
    id: "abc123",
    artistName: "Band",
    eventDate: "08-09-2026",
    venueName: "The Venue",
    cityName: "Leeds",
    countryName: "United Kingdom",
    tourName: "The Tour",
    url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    songs: [
      { name: "One", searchArtist: "Band", isCover: false },
      { name: "Two", searchArtist: "Band", isCover: false },
    ],
    tapeCount: 0,
    ...overrides,
  };
}

function trace(name: string, outcome: SongTrace["outcome"]): SongTrace {
  return { name, searchArtist: "Band", outcome };
}

function run(overrides: Partial<MatchRun> = {}): MatchRun {
  return {
    at: AT,
    setlistId: "abc123",
    setlistUrl: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    artist: "Band",
    eventDate: "08-09-2026",
    ok: true,
    attempted: 2,
    added: 2,
    songs: [trace("One", "high"), trace("Two", "high")],
    ...overrides,
  };
}

function fileOf(runs: MatchRun[]): MatchLogFile {
  return { v: 1, runs };
}

function capturingLog(): { log: PluginLog; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { log: { info: (m) => infos.push(m), warn: (m) => warns.push(m), error() {} }, infos, warns };
}

async function inTmpDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "music-matchlog-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Every test that touches the singleton starts from a known state and leaves none behind.
afterEach(() => resetMatchLogForTest(fileOf([])));

describe("appendRun", () => {
  test("appendRun keeps the newest 50 and drops the oldest", () => {
    // The issue promises the most recent 50; the constant is asserted by value so that changing it
    // is a decision a test notices rather than a number the loop below quietly follows.
    expect(MAX_RUNS).toBe(50);
    let file = fileOf([]);
    for (let i = 0; i < 55; i += 1) file = appendRun(file, run({ setlistId: `id-${i}` }));
    expect(file.runs).toHaveLength(50);
    // Oldest gone, newest last.
    expect(file.runs[0]!.setlistId).toBe("id-5");
    expect(file.runs[49]!.setlistId).toBe("id-54");
  });

  test("appendRun does not modify the file it was given", () => {
    const before = fileOf([run({ setlistId: "first" })]);
    const after = appendRun(before, run({ setlistId: "second" }));
    expect(before.runs.map((r) => r.setlistId)).toEqual(["first"]);
    expect(after.runs.map((r) => r.setlistId)).toEqual(["first", "second"]);
  });
});

describe("toMatchRun", () => {
  test("toMatchRun carries the setlist identity and counts, and nothing about the user", () => {
    const songs = [trace("One", "high"), trace("Two", "missing")];
    const result: BuildResult = {
      ok: true,
      outcome: {
        playlistUrl: "https://open.spotify.com/playlist/PL1",
        playlistName: "Band at The Venue, Leeds (2026-09-08)",
        added: 1,
        attempted: 2,
        uncertain: [],
        missing: ["Two"],
      },
      songs,
    };
    const made = toMatchRun(setlist(), result, AT);
    expect(made).toEqual({
      at: AT,
      setlistId: "abc123",
      setlistUrl: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
      artist: "Band",
      eventDate: "08-09-2026",
      venue: "The Venue",
      city: "Leeds",
      tour: "The Tour",
      ok: true,
      attempted: 2,
      added: 1,
      songs,
    });
    // The exact key set: a new field -- above all a Discord user id -- has to be added here on purpose.
    expect(Object.keys(made).sort()).toEqual(
      ["added", "artist", "at", "attempted", "city", "eventDate", "ok", "setlistId", "setlistUrl", "songs", "tour", "venue"],
    );
    expect(JSON.stringify(made)).not.toMatch(/discord|token/i);
  });

  test("toMatchRun leaves out the venue, city and tour a setlist doesn't have", () => {
    const made = toMatchRun(
      setlist({ venueName: undefined, cityName: "", tourName: undefined }),
      { ok: false, error: "x", songs: [] },
      AT,
    );
    expect("venue" in made).toBe(false);
    expect("city" in made).toBe(false);
    expect("tour" in made).toBe(false);
  });

  test("toMatchRun records a failed build with ok false and the error", () => {
    const songs = [trace("One", "high"), trace("Two", "error")];
    const made = toMatchRun(setlist(), { ok: false, error: "Spotify returned HTTP 429", songs }, AT);
    expect(made.ok).toBe(false);
    expect(made.error).toBe("Spotify returned HTTP 429");
    expect(made.added).toBe(0);
    expect(made.attempted).toBe(2);
    expect(made.songs).toEqual(songs);
  });

  test("toMatchRun counts attempted from the setlist, not from how many songs were traced", () => {
    // A build that died on its first song traced one of the setlist's four.
    const four = setlist({
      songs: ["A", "B", "C", "D"].map((name) => ({ name, searchArtist: "Band", isCover: false })),
    });
    const made = toMatchRun(four, { ok: false, error: "x", songs: [trace("A", "error")] }, AT);
    expect(made.attempted).toBe(4);
    expect(made.songs).toHaveLength(1);
  });
});

describe("summarize", () => {
  test("summarize reports added, missing and loose counts", () => {
    const line = summarize(
      run({
        attempted: 6,
        added: 4,
        songs: [
          trace("a", "high"),
          trace("b", "medium"),
          trace("c", "low"),
          trace("d", "missing"),
          trace("e", "missing"),
          trace("f", "high"),
        ],
      }),
    );
    expect(line).toBe('setlist abc123 "Band 08-09-2026": added 4/6, missing 2, loose 2');
  });

  test("summarize names the failure", () => {
    const line = summarize(
      run({ ok: false, error: "Spotify returned HTTP 429", added: 0, songs: [trace("One", "high"), trace("Two", "error")] }),
    );
    expect(line).toBe(
      'setlist abc123 "Band 08-09-2026": added 0/2, missing 0, loose 0 -- failed: Spotify returned HTTP 429',
    );
  });
});

describe("recordRun", () => {
  test("recordRun persists through host storage", async () => {
    await inTmpDir(async (dir) => {
      const host = makeFakeHost({ name: "music", dataDir: dir, storage: makeRealStorage() });
      await initMatchLog(host);
      await recordRun(run({ setlistId: "first" }));
      await recordRun(run({ setlistId: "second" }));
      const onDisk = (await Bun.file(join(dir, "match-log.json")).json()) as MatchLogFile;
      expect(onDisk.v).toBe(1);
      expect(onDisk.runs.map((r) => r.setlistId)).toEqual(["first", "second"]);

      // A restarted bot reads the same runs back and keeps appending after them.
      resetMatchLogForTest(fileOf([]));
      await initMatchLog(host);
      await recordRun(run({ setlistId: "third" }));
      const reread = (await Bun.file(join(dir, "match-log.json")).json()) as MatchLogFile;
      expect(reread.runs.map((r) => r.setlistId)).toEqual(["first", "second", "third"]);
    });
  });

  test("recordRun logs a summary line", async () => {
    await inTmpDir(async (dir) => {
      const { log, infos } = capturingLog();
      await initMatchLog(makeFakeHost({ name: "music", dataDir: dir, storage: makeRealStorage(), log }));
      const made = run();
      await recordRun(made);
      expect(infos).toEqual([summarize(made)]);
    });
  });

  test("a failing writer is logged and never throws", async () => {
    const { log, warns, infos } = capturingLog();
    const failing = makeRealStorage();
    failing.createJsonWriter = () => ({
      save: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    resetMatchLogForTest(fileOf([]), failing, "/unused/match-log.json", log);
    await expect(recordRun(run({ setlistId: "doomed" }))).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("doomed");
    expect(warns[0]).toContain("ENOSPC");
    // The build still shows up in the bot log even though its record could not be written.
    expect(infos).toHaveLength(1);
  });

  test("a writer that throws synchronously is contained too", async () => {
    const { log, warns } = capturingLog();
    const failing = makeRealStorage();
    failing.createJsonWriter = () => ({
      save: () => {
        throw new Error("EACCES");
      },
    });
    resetMatchLogForTest(fileOf([]), failing, "/unused/match-log.json", log);
    await expect(recordRun(run())).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  test("recordRun before initMatchLog warns once and returns", async () => {
    resetMatchLogForTest(fileOf([]));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recordRun(run());
      await recordRun(run());
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("initMatchLog", () => {
  test("a malformed existing file is replaced, not thrown on", async () => {
    for (const malformed of [{ v: 1, runs: "nope" }, [], null, { v: 2, runs: [] }, { runs: [] }]) {
      await inTmpDir(async (dir) => {
        await Bun.write(join(dir, "match-log.json"), JSON.stringify(malformed));
        await initMatchLog(makeFakeHost({ name: "music", dataDir: dir, storage: makeRealStorage() }));
        await recordRun(run({ setlistId: "after-repair" }));
        const onDisk = (await Bun.file(join(dir, "match-log.json")).json()) as MatchLogFile;
        expect(onDisk).toEqual({ v: 1, runs: [run({ setlistId: "after-repair" })] });
      });
    }
  });

  test("an existing well-formed file is kept and appended to", async () => {
    await inTmpDir(async (dir) => {
      await Bun.write(join(dir, "match-log.json"), JSON.stringify(fileOf([run({ setlistId: "kept" })])));
      await initMatchLog(makeFakeHost({ name: "music", dataDir: dir, storage: makeRealStorage() }));
      await recordRun(run({ setlistId: "new" }));
      const onDisk = (await Bun.file(join(dir, "match-log.json")).json()) as MatchLogFile;
      expect(onDisk.runs.map((r) => r.setlistId)).toEqual(["kept", "new"]);
    });
  });
});
