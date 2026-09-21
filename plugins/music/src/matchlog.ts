// A rolling record of how each `/setlist` build matched its songs, kept in `match-log.json` beside
// `music.json`. It exists because `findSong` used to keep only the winning track: after a build the
// candidates Spotify returned, their scores and the query that hit were all gone, so the matching
// heuristics had nothing real to be tuned against.
//
// Recording is best-effort by construction. Nothing here can fail, delay or alter the `/setlist`
// reply -- `commands.ts` sends the reply first and calls `recordRun` afterwards, `recordRun` turns a
// failed write into a log line instead of an exception, and `commands.ts` contains anything that
// still escapes (a logger that itself throws, say).
//
// The log carries NO Discord user id and no token. It records what was searched and what came back,
// never who asked.

import type { HostApi, HostStorage, PluginLog } from "../../../packages/api/contract.js";
import type { BuildResult, SongTrace } from "./build.js";
import type { Setlist } from "./setlistfm.js";

/** How many runs the file keeps; the oldest are dropped first. */
export const MAX_RUNS = 50;

export interface MatchRun {
  /** ISO 8601, from the caller's clock. */
  at: string;
  setlistId: string;
  setlistUrl: string;
  artist: string;
  eventDate: string;
  venue?: string;
  city?: string;
  tour?: string;
  /** False when the build failed outright; `error` says why and `songs` holds what was traced first. */
  ok: boolean;
  error?: string;
  /** Songs on the setlist we set out to find. */
  attempted: number;
  /**
   * Tracks Spotify confirmed as added -- 0 for a failed build, including one that failed after the
   * first batch of 100 had landed; the error text says how many made it.
   */
  added: number;
  songs: SongTrace[];
}

export interface MatchLogFile {
  v: 1;
  runs: MatchRun[];
}

function freshLog(): MatchLogFile {
  return { v: 1, runs: [] };
}

/** Newest last, oldest dropped past `max`. Pure: the input file is not modified. */
export function appendRun(file: MatchLogFile, run: MatchRun, max: number = MAX_RUNS): MatchLogFile {
  const runs = [...file.runs, run];
  return { v: 1, runs: runs.slice(Math.max(0, runs.length - max)) };
}

/** What one finished (or failed) build looks like as a log entry. Pure. */
export function toMatchRun(setlist: Setlist, result: BuildResult, at: string): MatchRun {
  const run: MatchRun = {
    at,
    setlistId: setlist.id,
    setlistUrl: setlist.url,
    artist: setlist.artistName,
    eventDate: setlist.eventDate,
    ok: result.ok,
    attempted: setlist.songs.length,
    added: result.ok ? result.outcome.added : 0,
    songs: result.songs,
  };
  if (setlist.venueName !== undefined && setlist.venueName !== "") run.venue = setlist.venueName;
  if (setlist.cityName !== undefined && setlist.cityName !== "") run.city = setlist.cityName;
  if (setlist.tourName !== undefined && setlist.tourName !== "") run.tour = setlist.tourName;
  if (!result.ok) run.error = result.error;
  return run;
}

/**
 * The one line a build leaves in the bot log. "loose" is `medium` plus `low`: matched, but not
 * confidently. The wording and punctuation are ASCII, since this reaches `docker logs` on hosts
 * whose console may not be UTF-8; the artist and any error text are interpolated as they arrived,
 * so an accented artist name still appears accented.
 */
export function summarize(run: MatchRun): string {
  const missing = run.songs.filter((s) => s.outcome === "missing").length;
  const loose = run.songs.filter((s) => s.outcome === "medium" || s.outcome === "low").length;
  const line =
    `setlist ${run.setlistId} "${run.artist} ${run.eventDate}": ` +
    `added ${run.added}/${run.attempted}, missing ${missing}, loose ${loose}`;
  return run.ok ? line : `${line} -- failed: ${run.error ?? "unknown error"}`;
}

// ---------------------------------------------------------------------------------------------------
// The live singleton -- the same shape as store.ts / party.ts
// ---------------------------------------------------------------------------------------------------

let current: MatchLogFile = freshLog();
let writer: { save: (data: MatchLogFile) => Promise<void> } | undefined;
let log: PluginLog | undefined;
let warnedUninitialized = false;

/**
 * Loads `match-log.json` if there is one, else starts empty -- the file itself is first written by
 * the first recorded run. Runs in `activate()`, never in `createPlugin`.
 */
export async function initMatchLog(host: HostApi): Promise<void> {
  const path = `${host.dataDir}/match-log.json`;
  const loaded = await host.storage.readJsonOrFresh<MatchLogFile>(path, freshLog, "music:match-log");
  // A file hand-edited into the wrong shape, or written by some other version, must not make every
  // later append throw. It is a diagnostic log: starting it again loses nothing that matters.
  const wellFormed =
    typeof loaded === "object" && loaded !== null && loaded.v === 1 && Array.isArray(loaded.runs);
  current = wellFormed ? loaded : freshLog();
  writer = host.storage.createJsonWriter<MatchLogFile>(path);
  log = host.log;
}

/**
 * Appends one run, persists it and logs its summary line. A failed write (a full disk, a
 * permissions error) is reported with `log.warn` rather than thrown, and the build that triggered
 * it carries on. A logger that itself throws is not guarded here; `commands.ts` contains that.
 *
 * The summary is logged BEFORE the write, so `docker logs` still shows the build when the write is
 * the thing that failed.
 */
export async function recordRun(run: MatchRun): Promise<void> {
  if (writer === undefined) {
    if (!warnedUninitialized) {
      warnedUninitialized = true;
      console.warn("[music] match log used before initMatchLog() -- runs are not being recorded");
    }
    return;
  }
  try {
    current = appendRun(current, run);
    log?.info(summarize(run));
    await writer.save(current);
  } catch (err) {
    log?.warn(`could not write the match log for setlist ${run.setlistId}: ${String(err)}`);
  }
}

/** Test seam: point the singleton at a given file, storage and logger without a real `HostApi`. */
export function resetMatchLogForTest(
  file: MatchLogFile,
  storage?: HostStorage,
  path?: string,
  logger?: PluginLog,
): void {
  current = file;
  writer = storage && path ? storage.createJsonWriter<MatchLogFile>(path) : undefined;
  log = logger;
  warnedUninitialized = false;
}
