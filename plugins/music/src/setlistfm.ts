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
// The client
// ---------------------------------------------------------------------------------------------------

export type SetlistFmResult =
  | { ok: true; setlist: Setlist }
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
}

/** Injected so tests drive the client without a network; production passes the global `fetch`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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

export function createSetlistFmClient(apiKey: string, fetchImpl: FetchLike = fetch): SetlistFmClient {
  async function get(path: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
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
    if (!response.ok) return { ok: false, error: describeStatus(response.status) };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, error: "setlist.fm sent a response we couldn't read" };
    }
  }

  return {
    async getSetlist(id) {
      const result = await get(`/setlist/${encodeURIComponent(id)}`);
      if (!result.ok) return result;
      const setlist = toSetlist(result.body);
      return setlist ? { ok: true, setlist } : { ok: false, error: "setlist.fm sent a setlist we couldn't read" };
    },

    async latestForArtist(artistName) {
      const result = await get(`/search/setlists?artistName=${encodeURIComponent(artistName)}&p=1`);
      if (!result.ok) return result;
      const body = result.body as { setlist?: unknown };
      const candidates = Array.isArray(body.setlist) ? body.setlist : [];
      for (const candidate of candidates) {
        const setlist = toSetlist(candidate);
        if (setlist && setlist.songs.length > 0) return { ok: true, setlist };
      }
      return {
        ok: false,
        error: candidates.length === 0
          ? `no setlists on setlist.fm for "${artistName}"`
          : `setlist.fm has shows for "${artistName}" but none with a song list filled in yet`,
      };
    },
  };
}
