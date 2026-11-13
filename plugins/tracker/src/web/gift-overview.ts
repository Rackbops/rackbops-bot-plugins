import {
  type GiftAllocation,
  type GiftBucket,
  type GiftCoverage,
  type GiftCoverageStatus,
  type GiftGroup,
  type GiftItem,
  type GiftLedger,
  type GiftOccasion,
  type GiftOccasionRecipient,
  type GiftPurchase,
  type GiftRecipient,
  type GiftSpend,
  type GiftStage,
  giftBuckets,
  giftCoverage,
  giftSpend,
  occasionBudget,
  type GiftOccasionBudget,
} from "@rackbops/docket-core";

/**
 * The family gift overview's data (rackbops-bot-plugins#384), pure once loaded: one owner's whole
 * ledger read once, then the overview of one occasion with the filters applied. The rules are
 * docket's (`giftBuckets`, `giftCoverage`, `giftSpend`); this only groups and counts what they say.
 */

/** Every record of one owner, archived ones too, in creation order: what docket's rules need whole. */
export interface Ledger {
  recipients: GiftRecipient[];
  groups: GiftGroup[];
  occasions: GiftOccasion[];
  rows: GiftOccasionRecipient[];
  items: GiftItem[];
  purchases: GiftPurchase[];
  allocations: GiftAllocation[];
  buckets: GiftBucket[];
}

export async function loadLedger(gifts: GiftLedger, ownerId: string): Promise<Ledger> {
  const all = { includeArchived: true };
  const [recipients, groups, occasions, rows, items, purchases, allocations] = await Promise.all([
    gifts.list("recipient", ownerId, all),
    gifts.list("group", ownerId, all),
    gifts.list("occasion", ownerId, all),
    gifts.list("occasionRecipient", ownerId, all),
    gifts.list("item", ownerId, all),
    gifts.list("purchase", ownerId, all),
    gifts.list("allocation", ownerId, all),
  ]);
  return { recipients, groups, occasions, rows, items, purchases, allocations, buckets: giftBuckets(allocations, purchases) };
}

/** A currency's minor-unit digits (ISO 4217, as the runtime's Intl knows them: JPY 0, USD 2, KWD 3); 2 for a code it does not know. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** The overview's columns, in the order a gift moves through them. Awaiting arrival and arrived share one. */
export const STAGE_COLUMNS = [
  ["needs-planning", "Needs planning"],
  ["planned", "Planned"],
  ["bought", "Purchased or awaiting"],
  ["ready", "Ready"],
  ["given", "Given"],
  ["skipped", "Skipped"],
] as const;
export type StageColumn = (typeof STAGE_COLUMNS)[number][0];

export function columnOf(status: GiftCoverageStatus): StageColumn {
  return status === "awaiting" || status === "purchased" ? "bought" : status;
}

export const isStageColumn = (v: string | null): v is StageColumn => STAGE_COLUMNS.some(([k]) => k === v);

export interface OverviewFilter {
  occasion?: string;
  /** A person or household: their own row, and for a household its members' rows (and a member's household's). */
  person?: string;
  group?: string;
  stage?: StageColumn;
}

export interface OverviewRow {
  recipient: GiftRecipient;
  coverage: GiftCoverage;
  column: StageColumn;
  /** The groups (by name) the recipient is in, for the family view. */
  groups: string[];
}

export interface OverviewGift {
  allocation: GiftAllocation;
  title: string;
  recipients: string[];
  units: number;
  /** The least advanced stage of its buckets; null for an archived or empty one. */
  stage: GiftStage | null;
}

export interface Overview {
  /** Open occasions, in creation order. */
  occasions: GiftOccasion[];
  occasion: GiftOccasion | null;
  rows: OverviewRow[];
  counts: Record<StageColumn, number>;
  budget: GiftOccasionBudget | null;
  gifts: OverviewGift[];
  /** Planned and net spend per currency over the whole ledger, never summed across currencies. */
  spend: GiftSpend[];
}

const STAGE_ORDER: readonly GiftStage[] = ["planned", "purchased", "arrived", "ready", "given"];

/** The overview of one occasion (the filter's, else the first open one), filtered. An unknown id in a filter matches nothing. */
export function overview(l: Ledger, f: OverviewFilter): Overview {
  const occasions = l.occasions.filter((o) => !o.archived);
  const occasion = (f.occasion ? l.occasions.find((o) => o.id === f.occasion) : occasions[0]) ?? null;
  const counts = Object.fromEntries(STAGE_COLUMNS.map(([k]) => [k, 0])) as Record<StageColumn, number>;
  const spend = giftSpend(l.purchases, l.allocations, l.items);
  if (!occasion) return { occasions, occasion: null, rows: [], counts, budget: null, gifts: [], spend };
  const byId = new Map(l.recipients.map((r) => [r.id, r]));
  const matchesPerson = (id: string): boolean => {
    if (!f.person) return true;
    if (id === f.person) return true;
    const chosen = byId.get(f.person);
    const row = byId.get(id);
    return (chosen?.kind === "household" && chosen.memberIds.includes(id)) || (row?.kind === "household" && row.memberIds.includes(f.person));
  };
  const group = f.group ? l.groups.find((g) => g.id === f.group) : undefined;
  const rows: OverviewRow[] = [];
  for (const row of l.rows) {
    if (row.occasionId !== occasion.id || row.archived) continue;
    const recipient = byId.get(row.recipientId);
    if (!recipient || !matchesPerson(row.recipientId)) continue;
    if (f.group && !group?.memberIds.includes(row.recipientId)) continue;
    const coverage = giftCoverage(row, l.buckets);
    const column = columnOf(coverage.status);
    // The counts keep every column under the other filters, so a stage filter narrows the rows, not the counts.
    counts[column] += 1;
    if (f.stage && column !== f.stage) continue;
    const groups = l.groups.filter((g) => !g.archived && g.memberIds.includes(row.recipientId)).map((g) => g.name);
    rows.push({ recipient, coverage, column, groups });
  }
  const items = new Map(l.items.map((i) => [i.id, i]));
  const gifts = l.allocations
    .filter((a) => a.occasionId === occasion.id && !a.archived)
    .map((a) => {
      const stages = l.buckets.filter((b) => b.allocationId === a.id).map((b) => STAGE_ORDER.indexOf(b.stage));
      return {
        allocation: a,
        title: items.get(a.itemId)?.title ?? a.itemId,
        recipients: a.recipientIds.map((id) => byId.get(id)?.displayName ?? id),
        units: a.shared ? a.quantity : a.quantity * a.recipientIds.length,
        stage: stages.length > 0 ? (STAGE_ORDER[Math.min(...stages)] ?? null) : null,
      };
    });
  return { occasions, occasion, rows, counts, budget: occasionBudget(occasion, l.rows), gifts, spend };
}
