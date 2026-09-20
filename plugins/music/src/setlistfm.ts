// The setlist.fm half of the plugin: turning a URL or an artist name into a flat, ordered list of
// songs. Everything here is pure except `createSetlistFmClient`, which is the one place a real
// `fetch` is used -- the parsing (`parseSetlistUrl`, `flattenSetlist`) and the shape-validation take
// plain values, so `setlistfm.test.ts` drives them against captured fixtures with no network.
//
// The API is free for non-commercial use and keyed per account (https://api.setlist.fm/docs/1.0/).
// It answers XML unless `Accept: application/json` is sent, so the client always sends it.

/** How long any one setlist.fm request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 10_000;

const API_BASE = "https://api.setlist.fm/rest/1.0";

/** One performed song, already resolved to the artist whose recording we should look for. */
export interface SetlistSong {
  /** The song title as setlist.fm records it. */
  name: string;
  /**
   * Whose recording to search for. For an ordinary song this is the performing artist; for a song
   * setlist.fm marks as a `cover`, it is the ORIGINAL artist, because a band that covers a song
   * live has usually never released it themselves -- the recording that exists is the original's.
   */
  searchArtist: string;
  /** True when `searchArtist` is not the performing artist (i.e. setlist.fm flagged it a cover). */
  isCover: boolean;
}

export interface Setlist {
  id: string;
  artistName: string;
  /** `dd-MM-yyyy` as setlist.fm returns it; rendered, never parsed into a Date. */
  eventDate: string;
  venueName?: string;
  cityName?: string;
  countryName?: string;
  tourName?: string;
  url: string;
  songs: SetlistSong[];
  /**
   * Songs dropped from `songs` because setlist.fm marked them `tape` -- walk-on/interlude music
   * played over the PA rather than performed. Counted so the reply can say so instead of silently
   * producing a shorter playlist than the setlist page shows.
   */
  tapeCount: number;
}

// ---------------------------------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------------------------------

/**
 * Pulls the setlist id out of a setlist.fm URL. The canonical form is
 * `https://www.setlist.fm/setlist/<artist-slug>/<year>/<venue-slug>-<id>.html`, where `<id>` is the
 * hex-ish token after the LAST hyphen -- the venue slug itself contains hyphens, so anchoring on the
 * last one is the only stable rule. Also accepts a bare id, so a user can paste either.
 *
 * Returns `undefined` rather than throwing: the caller turns that into a user-facing "that doesn't
 * look like a setlist.fm link" reply, which is a normal outcome, not an error.
 */
export function parseSetlistUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;

  // A bare id, pasted on its own.
  if (/^[0-9a-f]{6,10}$/i.test(trimmed)) return trimmed.toLowerCase();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!/(^|\.)setlist\.fm$/i.test(url.hostname)) return undefined;

  // `/setlist/<artist>/<year>/<venue-slug>-<id>.html`
  const last = url.pathname.split("/").filter((s) => s !== "").pop();
  if (last === undefined) return undefined;
  const match = last.match(/-([0-9a-f]{6,10})\.html$/i);
  return match ? match[1]!.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------------------------------

/** The subset of setlist.fm's setlist JSON this plugin reads. Everything is optional because the
 *  API omits empty objects entirely (a setlist with no tour has no `tour` key at all). */
interface RawSetlist {
  id?: unknown;
  eventDate?: unknown;
  url?: unknown;
  artist?: { name?: unknown };
  venue?: { name?: unknown; city?: { name?: unknown; country?: { name?: unknown } } };
  tour?: { name?: unknown };
  sets?: { set?: unknown };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Reads a setlist.fm collection that is documented as an array but is not reliably one.
 *
 * The JSON is serialised from an XML schema, and a one-element collection comes back as the bare
 * element instead of a list. It is a long-standing, unannounced inconsistency: a 2016 report on
 * setlist.fm's own API forum ("Modeling results in java class") describes `set` arriving as an
 * object "for the most part", "in some instances ... a String", and "in other instances ... an
 * array", with no staff answer. Not reproduced here -- this plugin has never run against a live
 * key -- but the cost of being wrong is one-sided, which is why it is guarded rather than argued
 * about.
 *
 * Being wrong the old way is SILENT: a non-array `set` yielded zero songs while `toSetlist` still
 * returned a perfectly valid setlist, and `latestForArtist` skips zero-song setlists as unfilled
 * stubs -- so a real gig was walked straight past with no error and nothing to diagnose.
 *
 * A bare string is accepted into the list for shape's sake but carries no song data either way, so
 * it still yields nothing. Only the object case actually recovers songs.
 */
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * Splits a medley entry into its parts.
 *
 * setlist.fm has no medley field: its editing guidelines put a medley on ONE line with the songs
 * separated by slashes, so a four-song medley arrives as a single entry named
 * `"Universal Death Squad / The Last Crusade / The Phantom Agony / Design Your Universe"`. Left
 * whole, that string is one Spotify query, and `matching.ts` scores it against nothing: its
 * `titleScore` needs the CANDIDATE title to contain the query, and no track is named after the
 * whole medley -- so every part of it scores 0 and the entry matches nothing at all. Four songs
 * the band played vanish from the playlist with nothing to show for them. Split, each part is an
 * exact title and matches `high`.
 *
 * Only a SPACED slash splits. That is what setlist.fm's own convention produces, and an unspaced
 * one is far more often part of a real title -- "Zoo Station/The Fly", "Ac/Dc" -- which must stay
 * whole. A one-part result is just the title, so a non-medley entry passes through untouched.
 */
export function splitMedley(name: string): string[] {
  const parts = name
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 ? parts : [name];
}

/**
 * Flattens setlist.fm's nested `sets.set[].song[]` into one ordered list, in stage order (main set
 * first, then each encore), and resolves each song's search artist.
 *
 * Three kinds of entry are dropped, because none of them is a track anyone can add to a playlist:
 * a song with no name (setlist.fm allows a blank entry to mark "something was played here"), and a
 * `tape` song (counted separately -- see `Setlist.tapeCount`). `with` (a guest performer) is
 * deliberately ignored: the recording is still the main artist's.
 *
 * One entry can yield more than one song: a medley is one setlist.fm entry but several tracks --
 * see `splitMedley`. Each part inherits the entry's cover credit, since the whole medley is
 * credited to the one original artist.
 */
export function flattenSetlist(raw: RawSetlist): { songs: SetlistSong[]; tapeCount: number } {
  const performingArtist = str(raw.artist?.name) ?? "";
  const sets = asList(raw.sets?.set);
  const songs: SetlistSong[] = [];
  let tapeCount = 0;

  for (const oneSet of sets) {
    if (typeof oneSet !== "object" || oneSet === null) continue;
    // `song` has the same exposure as `set`: a one-song set arrives as a bare object.
    for (const entry of asList((oneSet as { song?: unknown }).song)) {
      if (typeof entry !== "object" || entry === null) continue;
      const song = entry as { name?: unknown; tape?: unknown; cover?: { name?: unknown } };
      const name = str(song.name);
      if (name === undefined) continue;
      if (song.tape === true) {
        tapeCount += 1;
        continue;
      }
      const coverArtist = str(song.cover?.name);
      for (const part of splitMedley(name)) {
        songs.push({
          name: part,
          searchArtist: coverArtist ?? performingArtist,
          isCover: coverArtist !== undefined,
        });
      }
    }
  }
  return { songs, tapeCount };
}

/**
 * Validates and shapes one raw setlist. Returns `undefined` when the payload is missing the two
 * fields nothing downstream can work without (an id and an artist name) -- a malformed response is
 * reported to the user, never half-used.
 */
export function toSetlist(raw: unknown): Setlist | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as RawSetlist;
  const id = str(r.id);
  const artistName = str(r.artist?.name);
  if (id === undefined || artistName === undefined) return undefined;
  const { songs, tapeCount } = flattenSetlist(r);
  return {
    id,
    artistName,
    eventDate: str(r.eventDate) ?? "",
    venueName: str(r.venue?.name),
    cityName: str(r.venue?.city?.name),
    countryName: str(r.venue?.city?.country?.name),
    tourName: str(r.tour?.name),
    url: str(r.url) ?? `https://www.setlist.fm/setlist/${id}.html`,
    songs,
    tapeCount,
  };
}

// ---------------------------------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------------------------------

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Normalises a date a user typed into the `dd-MM-yyyy` that setlist.fm's `date` search parameter
 * requires. That format is the API's, not a choice: `?date=2026-09-08` silently matches nothing.
 *
 * Two spellings are accepted and no others, because every other separator ordering is genuinely
 * ambiguous: `yyyy-MM-dd` (ISO, what most people type) and `dd-MM-yyyy` (what setlist.fm itself
 * prints on every setlist page, so it is what someone copying from the site will paste). A
 * four-digit leading group means the first is a year; anything else is read day-first. `03-04-2026`
 * is therefore always 3 April, matching the site -- there is no reading of it as 4 March, which is
 * why `MM-dd-yyyy` is not accepted at all rather than guessed at.
 *
 * The result is round-tripped through a real calendar date, so `31-02-2026` is rejected instead of
 * rolling over into March. Returns `undefined` rather than throwing: an unreadable date is a normal
 * user typo the caller answers with a sentence.
 */
export function parseDateOption(input: string): string | undefined {
  const trimmed = input.trim();
  let year: number;
  let month: number;
  let day: number;

  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const dmy = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (iso !== null) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dmy !== null) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else {
    return undefined;
  }

  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${pad2(day)}-${pad2(month)}-${year}`;
}

// ---------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------

export type SetlistFmResult =
  | { ok: true; setlist: Setlist }
  | { ok: false; error: string };

/** Several setlists at once -- an artist+date search, where more than one match is normal. */
export type SetlistListResult =
  | { ok: true; setlists: Setlist[] }
  | { ok: false; error: string };

export interface SetlistFmClient {
  /** One setlist by its id. */
  getSetlist(id: string): Promise<SetlistFmResult>;
  /**
   * The most recent setlist for an artist name that actually has songs on it. setlist.fm's search
   * is newest-first and full of stubs (a show someone created but never filled in), so this skips
   * empty ones rather than returning a playlist of nothing.
   */
  latestForArtist(artistName: string): Promise<SetlistFmResult>;
  /**
   * EVERY setlist that artist has on that date (`dd-MM-yyyy`, see `parseDateOption`), in the order
   * setlist.fm returns them, including ones with no songs on them yet.
   *
   * Deliberately not narrowed to one: a band can play a festival slot in the afternoon and a club
   * show the same night, and setlist.fm also carries genuine duplicate entries for one gig. Either
   * way there is no rule that picks the right one, so the caller puts the choice to the user rather
   * than this guessing. An empty list means nothing matched -- which is a normal answer, not an
   * error.
   */
  showsOn(artistName: string, date: string): Promise<SetlistListResult>;
}

/** Injected so tests drive the client without a network; production passes the global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injected for the same reason as `FetchLike` -- so the retry tests below don't actually wait. */
export type SleepLike = (ms: number) => Promise<void>;

/**
 * Maps a setlist.fm HTTP status onto a sentence a Discord user can act on. 404 is by far the most
 * common and is not an error worth logging -- it just means the id or artist doesn't exist.
 */
function describeStatus(status: number): string {
  if (status === 404) return "setlist.fm has nothing under that link or artist name";
  if (status === 403) return "setlist.fm rejected the API key -- check SETLISTFM_API_KEY";
  if (status === 429) return "setlist.fm is rate-limiting us right now; try again in a minute";
  return `setlist.fm returned HTTP ${status}`;
}

/**
 * Whether a status is worth trying again. 429 is setlist.fm's documented rate limit (the free
 * tier is a small number of requests per second, and one `/setlist` can fire two calls back to
 * back), and a 5xx is the server having a moment. Every other 4xx is a statement about the
 * REQUEST -- a bad key, a missing id -- and repeating it unchanged only wastes the user's time.
 */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Reads a `Retry-After` header into milliseconds. Both forms in RFC 9110 are accepted: a count of
 * seconds (what setlist.fm sends) and an HTTP-date. Returns `undefined` when the header is absent
 * or unreadable, which the caller treats as "back off on your own schedule" rather than as an
 * error -- a malformed header must not be the reason a request fails.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Attempts AFTER the first one, for a retryable status. */
const MAX_RETRIES = 3;
/** The first backoff step; each retry after that doubles it. */
const BACKOFF_BASE_MS = 500;
/**
 * The longest this will sit on any one retry. A `/setlist` runs behind a deferred Discord reply,
 * so a long sleep is not a crash -- but it is an unexplained silence, and setlist.fm answers a
 * sustained rate-limit with a `Retry-After` in whole minutes. Past this, giving up immediately and
 * telling the user to try again in a minute beats making them watch a spinner for it.
 */
const MAX_BACKOFF_MS = 5_000;

/**
 * How long to wait before retry number `attempt` (0-based), or `undefined` to stop retrying now.
 *
 * A server-supplied `Retry-After` wins over our own backoff -- it is the only number that knows
 * when the limit actually lifts -- but one longer than `MAX_BACKOFF_MS` ends the retries instead
 * of being clamped down to it: hammering the endpoint again before the server said we could is
 * exactly what the header exists to prevent.
 */
export function retryDelay(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs > MAX_BACKOFF_MS ? undefined : retryAfterMs;
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSetlistFmClient(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  sleepImpl: SleepLike = defaultSleep,
): SetlistFmClient {
  type GetResult =
    | { ok: true; body: unknown }
    | { ok: false; error: string; status?: number };

  /**
   * One GET, retried on a rate limit or a server error. A transport failure (a timeout, a DNS or
   * TLS error) is NOT retried: the 10-second timeout has already been spent, and the failures that
   * reach here are the ones a second immediate attempt does not fix.
   *
   * `status` is carried on the failure so a caller can tell setlist.fm's "nothing matched" 404
   * apart from a real error -- the search endpoints answer an empty result set with 404 rather
   * than an empty list.
   */
  async function get(path: string): Promise<GetResult> {
    let lastStatus = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${API_BASE}${path}`, {
          headers: { "x-api-key": apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        return { ok: false, error: timedOut ? "setlist.fm took too long to answer" : "couldn't reach setlist.fm" };
      }

      if (response.ok) {
        try {
          return { ok: true, body: await response.json() };
        } catch {
          return { ok: false, error: "setlist.fm sent a response we couldn't read" };
        }
      }

      lastStatus = response.status;
      if (!isRetryable(response.status)) {
        return { ok: false, error: describeStatus(response.status), status: response.status };
      }
      if (attempt === MAX_RETRIES) break;

      const delay = retryDelay(attempt, parseRetryAfter(response.headers.get("Retry-After"), Date.now()));
      if (delay === undefined) break;
      await sleepImpl(delay);
    }

    return { ok: false, error: describeStatus(lastStatus), status: lastStatus };
  }

  /** The shared shape of both search calls: a page of setlists, already validated. */
  async function search(query: string): Promise<SetlistListResult> {
    const result = await get(`/search/setlists?${query}&p=1`);
    if (!result.ok) {
      // A search that matched nothing answers 404, not an empty page -- so for a SEARCH that is a
      // result, not a failure. (`getSetlist`'s own 404 stays a failure: an id either exists or the
      // user mistyped it.)
      if (result.status === 404) return { ok: true, setlists: [] };
      return { ok: false, error: result.error };
    }
    const body = result.body as { setlist?: unknown };
    const setlists: Setlist[] = [];
    // `setlist` has the same one-element-is-not-an-array exposure as `sets.set` -- see `asList`.
    for (const candidate of asList(body.setlist)) {
      const setlist = toSetlist(candidate);
      if (setlist !== undefined) setlists.push(setlist);
    }
    return { ok: true, setlists };
  }

  return {
    async getSetlist(id) {
      const result = await get(`/setlist/${encodeURIComponent(id)}`);
      if (!result.ok) return { ok: false, error: result.error };
      const setlist = toSetlist(result.body);
      return setlist ? { ok: true, setlist } : { ok: false, error: "setlist.fm sent a setlist we couldn't read" };
    },

    async latestForArtist(artistName) {
      const found = await search(`artistName=${encodeURIComponent(artistName)}`);
      if (!found.ok) return { ok: false, error: found.error };
      for (const setlist of found.setlists) {
        if (setlist.songs.length > 0) return { ok: true, setlist };
      }
      return {
        ok: false,
        error: found.setlists.length === 0
          ? `no setlists on setlist.fm for "${artistName}"`
          : `setlist.fm has shows for "${artistName}" but none with a song list filled in yet`,
      };
    },

    async showsOn(artistName, date) {
      return search(`artistName=${encodeURIComponent(artistName)}&date=${encodeURIComponent(date)}`);
    },
  };
}
