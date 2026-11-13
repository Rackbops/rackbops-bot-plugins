import {
  GiftNotFoundError,
  GiftRevisionError,
  GiftValidationError,
  type GiftWriteMeta,
  allocationUnits,
  previewRoster,
  rosterIds,
} from "@rackbops/docket-core";
import { NO_LONGER_LISTED } from "../actions.js";
import { previewOrRefusal, sync } from "./api-gifts.js";
import type { Editor } from "./editor.js";
import { loadLedger, isStageColumn, overview, type OverviewFilter } from "./gift-overview.js";
import { type FormChoices, type FormState, giftFormPage, giftsPage, syncPage } from "./gift-pages.js";
import { htmlResponse, redirect } from "./html.js";
import { errorPage, notFoundPage } from "./pages.js";

/**
 * The family gift pages' handlers (rackbops-bot-plugins#384): the overview, the add forms and the
 * sync review, on the signed-in person's own gift ledger only. Every write takes the web's one
 * write queue, as the task editor's do, with the person read again inside it; every write goes
 * through docket's `GiftLedger`, which checks each field and that every id named is the person's
 * own. Nothing here posts to Discord.
 */

export const GIFT_FORMS = ["person", "group", "occasion", "gift", "purchase"] as const;
export type GiftForm = (typeof GIFT_FORMS)[number];

const NOTICES: Record<string, string> = {
  person: "Saved.",
  group: "Group saved.",
  occasion: "Occasion saved, with the people it covers.",
  gift: "Gift saved.",
  purchase: "Purchase recorded.",
  synced: "The occasion now matches its groups.",
};

function filterOf(params: URLSearchParams): OverviewFilter {
  const f: OverviewFilter = {};
  for (const k of ["occasion", "person", "group"] as const) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  const stage = params.get("stage");
  if (isStageColumn(stage)) f.stage = stage;
  return f;
}

/** `GET /gifts`. */
export async function giftsGet(e: Editor, params: URLSearchParams): Promise<Response> {
  const l = await loadLedger(e.d.gifts, e.v.user.id);
  const f = filterOf(params);
  const done = params.get("done");
  return htmlResponse(giftsPage(e.v, overview(l, f), f, l.recipients, l.groups, done ? NOTICES[done] : undefined));
}

async function choices(e: Editor): Promise<FormChoices> {
  const l = await loadLedger(e.d.gifts, e.v.user.id);
  const items = new Map(l.items.map((i) => [i.id, i.title]));
  const names = new Map(l.recipients.map((r) => [r.id, r.displayName]));
  const occasions = new Map(l.occasions.map((o) => [o.id, o.title]));
  const unbought = l.allocations
    .filter((a) => !a.archived && a.purchaseId === null)
    .map((a) => [a.id, `${items.get(a.itemId) ?? a.itemId} for ${a.recipientIds.map((id) => names.get(id) ?? id).join(", ")} (${occasions.get(a.occasionId) ?? ""})`] as const);
  return { recipients: l.recipients, groups: l.groups, occasions: l.occasions, unbought };
}

/** `GET /gifts/new/<form>`. */
export async function giftFormGet(e: Editor, form: GiftForm): Promise<Response> {
  return htmlResponse(giftFormPage(e.v, form, await choices(e), { values: new URLSearchParams() }));
}

/** An amount typed as `12`, `12.5` or `12.50`, as minor units; null when blank, undefined when not an amount. */
export function parseMoney(raw: string | null): number | null | undefined {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

class Refused extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

const words = (raw: string | null) =>
  (raw ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w !== "");
const text = (raw: string | null) => (raw ?? "").trim();
const orNull = (raw: string | null) => (text(raw) === "" ? null : text(raw));

/** Runs one form's writes in the queue, as the person still on the list; a refusal re-renders the form. */
async function inQueue(e: Editor, form: GiftForm, values: URLSearchParams, run: (meta: GiftWriteMeta) => Promise<string | null>): Promise<Response> {
  const outcome = await e.queue(async () => {
    if (!(await e.d.store.getUser(e.v.user.id))) return { gone: true as const };
    const meta: GiftWriteMeta = { ownerId: e.v.user.id, actor: e.v.user.id, source: "web", at: e.d.clock.now().toISOString() };
    try {
      return { occasion: await run(meta) };
    } catch (err) {
      if (err instanceof Refused) return { error: err.message, problems: err.problems };
      if (err instanceof GiftValidationError) return { error: "Some of it could not be saved:", problems: err.problems };
      if (err instanceof GiftNotFoundError) return { error: "Something it names is not on your list any more. Reload and try again." };
      if (err instanceof GiftRevisionError) return { error: "It changed while you were editing. Reload and try again." };
      throw err;
    }
  });
  if ("gone" in outcome) return htmlResponse(errorPage(e.v.base, "Not saved", NO_LONGER_LISTED), 403);
  if ("error" in outcome) {
    const s: FormState = { values, error: outcome.error ?? "", problems: outcome.problems ?? [] };
    return htmlResponse(giftFormPage(e.v, form, await choices(e), s), 400);
  }
  return redirect(`${e.v.base}/gifts?${new URLSearchParams({ ...(outcome.occasion ? { occasion: outcome.occasion } : {}), done: form }).toString()}`);
}

/** `POST /gifts/new/<form>`. */
export async function giftFormPost(e: Editor, form: GiftForm, f: URLSearchParams): Promise<Response> {
  const gifts = e.d.gifts;
  if (form === "occasion" && f.get("step") === "preview") {
    const l = await loadLedger(gifts, e.v.user.id);
    const chosen = l.groups.filter((g) => f.getAll("group").includes(g.id));
    const entries = previewRoster(chosen, f.getAll("include"), f.getAll("exclude"));
    const name = (id: string) => l.recipients.find((r) => r.id === id)?.displayName ?? id;
    const preview = { names: rosterIds(entries).map(name), excluded: entries.filter((x) => x.excluded).map((x) => name(x.recipientId)) };
    return htmlResponse(giftFormPage(e.v, form, await choices(e), { values: f, preview }));
  }
  return inQueue(e, form, f, async (meta) => {
    switch (form) {
      case "person": {
        const household = f.get("kind") === "household";
        await gifts.create("recipient", meta, {
          displayName: text(f.get("name")),
          kind: household ? "household" : "person",
          memberIds: household ? f.getAll("member") : [],
          labels: words(f.get("labels")),
          interests: [],
          avoid: [],
          notes: orNull(f.get("notes")),
        });
        return null;
      }
      case "group":
        await gifts.create("group", meta, { name: text(f.get("name")), memberIds: f.getAll("member") });
        return null;
      case "occasion": {
        const budget = parseMoney(f.get("budget"));
        if (budget === undefined) throw new Refused("The budget is an amount, such as 500 or 500.00.");
        const date = orNull(f.get("date"));
        const groupIds = f.getAll("group");
        const includeIds = f.getAll("include");
        const excludeIds = f.getAll("exclude");
        const occasion = await gifts.create("occasion", meta, {
          kind: (f.get("kind") ?? "custom") as "christmas",
          title: text(f.get("title")),
          date,
          timeZone: null,
          year: date ? Number(date.slice(0, 4)) : null,
          currency: text(f.get("currency")).toUpperCase(),
          budgetMinor: budget,
          groupIds,
          includeIds,
          excludeIds,
        });
        // The roster is the snapshot of the groups as they are now (docket#97): one row per person, however many groups hold them.
        const groups = (await gifts.list("group", meta.ownerId, { includeArchived: true })).filter((g) => groupIds.includes(g.id));
        for (const recipientId of rosterIds(previewRoster(groups, includeIds, excludeIds))) {
          await gifts.create("occasionRecipient", meta, { occasionId: occasion.id, recipientId, target: null, budgetMinor: null, decision: "planning", skipReason: null });
        }
        return occasion.id;
      }
      case "gift": {
        const estimate = parseMoney(f.get("estimate"));
        if (estimate === undefined) throw new Refused("The estimate is an amount, such as 25 or 24.99.");
        const quantity = Number(f.get("quantity") ?? "1");
        const occasionId = orNull(f.get("occasion"));
        const recipientIds = f.getAll("for");
        if (occasionId && recipientIds.length === 0) throw new Refused("Choose who it is for, or no occasion to keep it as an idea.");
        const item = await gifts.create("item", meta, {
          title: text(f.get("title")),
          url: orNull(f.get("url")),
          productKey: null,
          variant: null,
          notes: null,
          source: { kind: "manual", ref: null },
          planning: occasionId ? "selected" : "idea",
          estimateMinor: estimate,
          currency: estimate === null ? null : text(f.get("currency")).toUpperCase(),
        });
        if (occasionId) {
          await gifts.create("allocation", meta, { itemId: item.id, occasionId, recipientIds, quantity, shared: f.get("shared") === "1", purchaseId: null, handoff: "none", givenOn: null });
        }
        return occasionId;
      }
      case "purchase": {
        const price = parseMoney(f.get("price"));
        if (price === undefined || price === null) throw new Refused("The price is an amount, such as 24.99.");
        const allocation = await gifts.get("allocation", meta.ownerId, text(f.get("gift")));
        if (!allocation || allocation.archived) throw new Refused("Choose a gift.");
        if (allocation.purchaseId !== null) throw new Refused("That gift is already bought.");
        const units = allocationUnits(allocation);
        const purchase = await gifts.create("purchase", meta, {
          itemId: allocation.itemId,
          merchant: orNull(f.get("merchant")),
          currency: text(f.get("currency")).toUpperCase(),
          unitPriceMinor: price,
          ordered: units,
          received: f.get("received") === "1" ? units : 0,
          cancelled: 0,
          returned: 0,
          taxMinor: null,
          shippingMinor: null,
          discountMinor: null,
          totalComplete: false,
          refundedMinor: 0,
          purchasedOn: orNull(f.get("on")),
          reference: null,
        });
        await gifts.update("allocation", allocation.id, meta, allocation.revision, { purchaseId: purchase.id });
        return allocation.occasionId;
      }
    }
  });
}

async function syncView(e: Editor, id: string, error?: string, status = 200): Promise<Response> {
  const gifts = e.d.gifts;
  const occasion = await gifts.get("occasion", e.v.user.id, id);
  const p = occasion ? await previewOrRefusal(gifts, e.v.user.id, id) : null;
  if (!occasion || !p || "status" in p) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const l = await loadLedger(gifts, e.v.user.id);
  const name = (rid: string) => l.recipients.find((r) => r.id === rid)?.displayName ?? rid;
  const title = (aid: string) => {
    const a = l.allocations.find((x) => x.id === aid);
    return l.items.find((i) => i.id === a?.itemId)?.title ?? aid;
  };
  return htmlResponse(syncPage(e.v, occasion, p.preview, p.previewToken, name, title, error), status);
}

/** `GET /gifts/occasions/<id>/sync`. */
export function syncGet(e: Editor, id: string): Promise<Response> {
  return syncView(e, id);
}

/** `POST /gifts/occasions/<id>/sync`: the form's choices, applied only to the preview the page showed (api-gifts.ts `sync`). */
export async function syncPost(e: Editor, id: string, f: URLSearchParams): Promise<Response> {
  const decisions: Record<string, unknown> = {};
  for (const [k, v] of f) {
    if (!k.startsWith("decision-")) continue;
    const allocationId = k.slice("decision-".length);
    decisions[allocationId] = v.startsWith("reassign:") ? { action: "reassign", recipientIds: [v.slice("reassign:".length)] } : { action: v };
  }
  const answer = await e.queue(async () => {
    if (!(await e.d.store.getUser(e.v.user.id))) return null;
    const meta: GiftWriteMeta = { ownerId: e.v.user.id, actor: e.v.user.id, source: "web", at: e.d.clock.now().toISOString() };
    return sync(e.d.gifts, meta, id, { previewToken: f.get("token") ?? "", decisions });
  });
  if (answer === null) return htmlResponse(errorPage(e.v.base, "Not saved", NO_LONGER_LISTED), 403);
  if (answer.status === 200) return redirect(`${e.v.base}/gifts?${new URLSearchParams({ occasion: id, done: "synced" }).toString()}`);
  if (answer.status === 404) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const message = (answer.body as { error: { message: string } }).error.message;
  return syncView(e, id, message, answer.status);
}
