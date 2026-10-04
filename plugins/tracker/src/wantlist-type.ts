import { defineTaskType, type Finding, type Outcome, type ReplyContext, type RunContext, type TaskType } from "@rackbops/docket-core";
import { MISSES_BEFORE_TELLING, money } from "@rackbops/docket-types";
import { clip } from "./actions.js";
import { BGG_ATTRIBUTION } from "./want-bgg.js";
import { type Listing, listingKey, type Source, type SourceId, SourceMiss, SourceUnavailableError } from "./want-sources.js";

/**
 * The want-list watcher (category 2, plan 1.2 row 2; rackbops-bot-plugins#83): one task per wanted
 * thing, read from one source (want-sources.ts) on a `poll` schedule. Each run lists what the source
 * has now, keeps those at or under the owner's top price, and DMs the ones it has not told them of
 * before, up to `SHOWN_IN_DM` lines, each kept as a finding (plan 5.2), with a Done button: the
 * thing is found, the task ends. A read that yields nothing counts as a miss, and the owner hears
 * once, at `MISSES_BEFORE_TELLING` in a row (the price tracker's rule). Notify lane, tier 0, no
 * model; the plan's model judge of new candidates (5.4) is a later piece.
 *
 * Defined in the plugin, like the scout, while docket-types ships no `wantlist`; a give-back to
 * Rackbops/docket follows.
 */

export interface WantConfig {
  source: SourceId;
  /** The page's address, or the BGG game (an id or its address). */
  target: string;
  /** Only listings at or under this, in `currency` when one is set. */
  maxPrice?: number;
  /** Only listings in this currency; a listing that names none passes. */
  currency?: string;
}

export interface WantState {
  /** `listingKey`s of the listings already DMed, newest last, at most `MAX_REPORTED`. */
  reported: string[];
  /** Reads in a row that yielded nothing. */
  misses: number;
  /** Listings DMed in all. */
  told: number;
}

export const MAX_REPORTED = 500;
export const SHOWN_IN_DM = 5;

export function wantState(value: unknown): WantState {
  const s = value as Partial<WantState> | null;
  if (!s || typeof s !== "object") return { reported: [], misses: 0, told: 0 };
  return {
    reported: Array.isArray(s.reported) ? s.reported.filter((k): k is string => typeof k === "string").slice(-MAX_REPORTED) : [],
    misses: typeof s.misses === "number" ? s.misses : 0,
    told: typeof s.told === "number" ? s.told : 0,
  };
}

/** Whether a listing is within the owner's limits: an unknown price never passes a top price. */
export function withinLimits(l: Listing, config: WantConfig): boolean {
  if (config.currency && l.currency && l.currency !== config.currency) return false;
  if (config.maxPrice === undefined) return true;
  return l.price !== undefined && l.price <= config.maxPrice + 1e-9;
}

function priceText(l: Listing, config: WantConfig): string {
  return l.price === undefined ? "price not shown" : money(l.price, l.currency ?? config.currency ?? "");
}

/** One DM line: what, how much, its condition and seller, then the link in <...> (no embed). */
export function listingLine(l: Listing, config: WantConfig): string {
  const parts = [l.title, priceText(l, config), ...(l.condition ? [l.condition] : []), ...(l.seller ? [`sold by ${l.seller}`] : [])];
  const via = config.source === "bgg" ? ` (${BGG_ATTRIBUTION})` : "";
  return `- ${parts.join(" -- ")} <${l.url}>${via}`;
}

export function renderWant(title: string, taskId: string, fresh: readonly Listing[], config: WantConfig): string {
  const lines = [`${title}: ${fresh.length === 1 ? "a new listing" : `${fresh.length} new listings`}.`];
  for (const l of fresh.slice(0, SHOWN_IN_DM)) lines.push(listingLine(l, config));
  if (fresh.length > SHOWN_IN_DM) lines.push(`...and ${fresh.length - SHOWN_IN_DM} more: \`/task history ${taskId}\` lists them all.`);
  lines.push("Press Done once you have it, and I stop looking.");
  return clip(lines.join("\n"));
}

function miss(ctx: RunContext<WantConfig>, state: WantState, err: unknown): Outcome {
  const reason = err instanceof Error ? err.message : String(err);
  const misses = state.misses + 1;
  const outcome: Outcome = { state: { ...state, misses }, summary: `nothing read: ${reason}` };
  if (misses === MISSES_BEFORE_TELLING || (err instanceof SourceUnavailableError && state.misses === 0)) {
    const where = ctx.config.source === "bgg" ? "BoardGameGeek" : ctx.config.target;
    outcome.notify = {
      text: clip(
        `${ctx.task.title}: I could read no listings from ${where} ${misses === 1 ? "just now" : `${misses} times in a row`} (${reason}). ` +
          "I keep looking; press Done to stop.",
      ),
      actions: ["done"],
    };
  }
  return outcome;
}

/** The type over `sources`: a task whose source this bot lacks (BGG without its token) counts misses. */
export function wantlistType(sources: Partial<Record<SourceId, Source>>): TaskType<WantConfig> {
  return defineTaskType<WantConfig>({
    id: "wantlist",
    lane: "notify",
    capabilities: ["notify"],
    schedule: ["poll"],
    intake: {
      options: [
        { name: "source", description: "Where to look: page or bgg", required: true, kind: "string" },
        { name: "target", description: "The listing page's address, or the BGG game", required: true, kind: "string" },
        { name: "max", description: "Only listings at or under this price", required: false, kind: "number" },
        { name: "currency", description: "Only listings in this currency", required: false, kind: "string" },
      ],
    },
    async run(ctx: RunContext<WantConfig>): Promise<Outcome> {
      const state = wantState(ctx.state);
      const source = sources[ctx.config.source];
      if (!source) return miss(ctx, state, new SourceUnavailableError(`this bot has no ${ctx.config.source === "bgg" ? "BoardGameGeek access" : "such source"}`));
      let listings: Listing[];
      try {
        listings = await source.search(ctx.config.target, ctx.ports.fetch);
      } catch (err) {
        if (err instanceof SourceMiss) return miss(ctx, state, err);
        throw err;
      }
      const told = new Set(state.reported);
      const within = listings.filter((l) => withinLimits(l, ctx.config));
      const fresh = within.filter((l) => !told.has(listingKey(l.id)));
      const summary = `${listings.length} listed, ${within.length} within limits, ${fresh.length} new`;
      if (fresh.length === 0) return { state: { ...state, misses: 0 }, summary };
      const findings: Finding[] = fresh.map((l) => ({
        text: clip(`${l.title} -- ${priceText(l, ctx.config)}${l.condition ? ` -- ${l.condition}` : ""}`, 400),
        source: l.url,
        key: listingKey(l.id),
        tags: ["wantlist", ctx.config.source],
      }));
      return {
        state: { reported: [...state.reported, ...fresh.map((l) => listingKey(l.id))].slice(-MAX_REPORTED), misses: 0, told: state.told + fresh.length },
        notify: { text: renderWant(ctx.task.title, ctx.task.id, fresh, ctx.config), actions: ["done"] },
        findings,
        summary,
      };
    },
    async onReply(ctx: ReplyContext<WantConfig>): Promise<Outcome> {
      if (ctx.reply.kind === "done") return { complete: true, summary: "found it; stopped looking" };
      return {};
    },
  });
}
