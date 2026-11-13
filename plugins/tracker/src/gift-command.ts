import {
  GiftNotFoundError,
  GiftRevisionError,
  GiftValidationError,
  type GiftOccasion,
  type GiftRecipient,
  type GiftWriteMeta,
  type User,
  allocationUnits,
} from "@rackbops/docket-core";
import type { TrackerDeps } from "./actions.js";
import { loadLedger, minorDigits, overview, STAGE_COLUMNS, type Ledger } from "./web/gift-overview.js";
import type { WebLocation } from "./web/command.js";

/**
 * `/gift` (rackbops-bot-plugins#385, epic Rackbops/docket#94): quick capture from Discord on the
 * person's own gift ledger -- an idea, a purchase, and who still needs a gift. Each runs inside the
 * command's turn in the one write queue, through docket's `GiftLedger`; every answer is the
 * command's ephemeral reply (discord.ts `run`), never a channel post. Anything bigger is the web
 * page (`/gifts`, #384), linked when the web area is set up.
 */

type Deps = Pick<TrackerDeps, "gifts" | "clock">;

export interface GiftIdeaInput {
  person: string;
  title: string;
  occasion?: string;
  estimate?: number;
  currency?: string;
}

export interface GiftBoughtInput {
  gift: string;
  price: number;
  person?: string;
  merchant?: string;
  arrived?: boolean;
}

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function giftsLink(web: WebLocation | null, occasionId?: string): string {
  if (!web) return "";
  const q = occasionId ? `?occasion=${encodeURIComponent(occasionId)}` : "";
  return `\nMore on the web page: <${web.origin}/${web.name}/gifts${q}>`;
}

function meta(d: Deps, user: User): GiftWriteMeta {
  return { ownerId: user.id, actor: user.id, source: "discord", at: d.clock.now().toISOString() };
}

/** One live person or household by name (or id), else the answer saying why not. */
function findPerson(l: Ledger, raw: string): GiftRecipient | string {
  const want = fold(raw);
  const live = l.recipients.filter((r) => !r.archived);
  const hits = live.filter((r) => r.id === raw.trim() || fold(r.displayName) === want);
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1) return `More than one person on your gift list is called ${raw.trim()}. Rename one on the web page first.`;
  return `No one called ${raw.trim()} is on your gift list. Add them on the web page first.`;
}

/** One open occasion by title (or id), else the answer saying why not. */
function findOccasion(l: Ledger, raw: string): GiftOccasion | string {
  const want = fold(raw);
  const hits = l.occasions.filter((o) => !o.archived && (o.id === raw.trim() || fold(o.title) === want));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1) return `More than one open occasion is called ${raw.trim()}.`;
  return `No open occasion called ${raw.trim()} is on your gift list.`;
}

/** An amount in whole currency units as minor units, by the currency's own digits; null when not one. */
function toMinor(amount: number, currency: string): number | null {
  const minor = Math.round(amount * 10 ** minorDigits(currency));
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

function refusal(err: unknown): string {
  if (err instanceof GiftValidationError) return `Not saved: ${err.problems.join("; ")}.`;
  if (err instanceof GiftNotFoundError) return "Not saved: something it names is not on your gift list any more.";
  if (err instanceof GiftRevisionError) return "Not saved: it changed while this ran. Try again.";
  throw err;
}

/** `/gift idea`: an idea for a person; with an occasion, a gift planned for them on it. */
export async function giftIdea(d: Deps, user: User, input: GiftIdeaInput, web: WebLocation | null): Promise<string> {
  const l = await loadLedger(d.gifts, user.id);
  const person = findPerson(l, input.person);
  if (typeof person === "string") return person + giftsLink(web);
  const occasion = input.occasion ? findOccasion(l, input.occasion) : null;
  if (typeof occasion === "string") return occasion + giftsLink(web);
  const currency = (input.currency ?? occasion?.currency ?? "").trim().toUpperCase();
  let estimate: number | null = null;
  if (input.estimate !== undefined) {
    if (currency === "") return "Give a currency with the estimate, or an occasion to take it from.";
    estimate = toMinor(input.estimate, currency);
    if (estimate === null) return "The estimate is not an amount.";
  }
  const m = meta(d, user);
  try {
    const item = await d.gifts.create("item", m, {
      title: input.title.trim(),
      url: null,
      productKey: null,
      variant: null,
      notes: occasion ? null : `For ${person.displayName}`,
      source: { kind: "manual", ref: null },
      planning: occasion ? "selected" : "idea",
      estimateMinor: estimate,
      currency: estimate === null ? null : currency,
    });
    if (!occasion) return `Saved ${item.title} as an idea for ${person.displayName}.${giftsLink(web)}`;
    await d.gifts.create("allocation", m, { itemId: item.id, occasionId: occasion.id, recipientIds: [person.id], quantity: 1, shared: false, purchaseId: null, handoff: "none", givenOn: null });
    return `Planned ${item.title} for ${person.displayName} for ${occasion.title}.${giftsLink(web, occasion.id)}`;
  } catch (err) {
    return refusal(err);
  }
}

/** `/gift bought`: records the purchase of one planned, not yet bought gift, found by its title (and person). */
export async function giftBought(d: Deps, user: User, input: GiftBoughtInput, web: WebLocation | null): Promise<string> {
  const l = await loadLedger(d.gifts, user.id);
  let personId: string | null = null;
  if (input.person) {
    const person = findPerson(l, input.person);
    if (typeof person === "string") return person + giftsLink(web);
    personId = person.id;
  }
  const want = fold(input.gift);
  const titles = new Map(l.items.map((i) => [i.id, i.title]));
  const names = new Map(l.recipients.map((r) => [r.id, r.displayName]));
  const occasions = new Map(l.occasions.map((o) => [o.id, o]));
  const open = l.allocations.filter(
    (a) => !a.archived && a.purchaseId === null && fold(titles.get(a.itemId) ?? "") === want && (personId === null || a.recipientIds.includes(personId)) && occasions.get(a.occasionId)?.archived === false,
  );
  const label = (a: (typeof open)[number]) => `${titles.get(a.itemId)} for ${a.recipientIds.map((id) => names.get(id) ?? id).join(", ")} (${occasions.get(a.occasionId)?.title ?? ""})`;
  if (open.length === 0) return `No planned gift called ${input.gift.trim()}${input.person ? ` for ${input.person.trim()}` : ""} is waiting to be bought.${giftsLink(web)}`;
  if (open.length > 1) return [`More than one planned gift matches; name the person too:`, ...open.map((a) => `- ${label(a)}`)].join("\n");
  const allocation = open[0];
  if (!allocation) return "No planned gift matches.";
  const occasion = occasions.get(allocation.occasionId);
  const currency = occasion?.currency ?? "";
  const price = toMinor(input.price, currency);
  if (price === null) return "The price is not an amount.";
  const units = allocationUnits(allocation);
  const m = meta(d, user);
  try {
    const purchase = await d.gifts.create("purchase", m, {
      itemId: allocation.itemId,
      merchant: input.merchant?.trim() || null,
      currency,
      unitPriceMinor: price,
      ordered: units,
      received: input.arrived ? units : 0,
      cancelled: 0,
      returned: 0,
      taxMinor: null,
      shippingMinor: null,
      discountMinor: null,
      totalComplete: false,
      refundedMinor: 0,
      purchasedOn: m.at.slice(0, 10),
      reference: null,
    });
    await d.gifts.update("allocation", allocation.id, m, allocation.revision, { purchaseId: purchase.id });
  } catch (err) {
    return refusal(err);
  }
  return `Recorded: bought ${label(allocation)}, ${units} at ${input.price} ${currency} each${input.arrived ? ", arrived" : ", on its way"}.${giftsLink(web, allocation.occasionId)}`;
}

/** Names joined, at most about 700 characters of them (two lists fit one Discord message), then how many more. */
export function capped(names: readonly string[], max = 700): string {
  let out = "";
  for (const [i, n] of names.entries()) {
    const next = out === "" ? n : `${out}, ${n}`;
    if (next.length > max) return `${out}, and ${names.length - i} more`;
    out = next;
  }
  return out;
}

/** `/gift needs`: who on an occasion (the first open one unless named) still needs a gift, by docket's coverage. */
export async function giftNeeds(d: Deps, user: User, occasionName: string | undefined, web: WebLocation | null): Promise<string> {
  const l = await loadLedger(d.gifts, user.id);
  let occasionId: string | undefined;
  if (occasionName) {
    const o = findOccasion(l, occasionName);
    if (typeof o === "string") return o + giftsLink(web);
    occasionId = o.id;
  }
  const view = overview(l, occasionId ? { occasion: occasionId } : {});
  if (!view.occasion) return `You have no open occasions on your gift list.${giftsLink(web)}`;
  const label = (k: string) => STAGE_COLUMNS.find(([c]) => c === k)?.[1] ?? k;
  const still = (["needs-planning", "planned"] as const).map((k) => [k, view.rows.filter((r) => r.column === k).map((r) => r.recipient.displayName)] as const);
  const count = still.reduce((n, [, names]) => n + names.length, 0);
  const lines = [count === 0 ? `${view.occasion.title}: everyone has a gift bought or on its way.` : `${view.occasion.title}: ${count} still need${count === 1 ? "s" : ""} a gift.`];
  for (const [k, names] of still) if (names.length > 0) lines.push(`${label(k)}: ${capped(names)}`);
  lines.push(STAGE_COLUMNS.map(([k, name]) => `${name} ${view.counts[k]}`).join(" | "));
  return lines.join("\n") + giftsLink(web, view.occasion.id);
}
