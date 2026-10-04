import { afterEach, describe, expect, it } from "bun:test";
import { NO_SUCH_TASK } from "./actions.js";
import { MAX_LIVE_SCOUTS, parseInterests, SCOUT_OFF, scoutPlan, scoutTitle } from "./scout.js";
import { itemKey, MAX_SHOWN, parseScout, renderScout, SCOUT_MAX_BUDGET_USD, SCOUT_MAX_TURNS, scoutJob, scoutState } from "./scout-type.js";
import { dmsTo, query, setup, success } from "./web/execute-harness.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

/**
 * The interest scout (category 1, rackbops-bot-plugins#83): its rules, its Job, what it makes of the
 * model's answer, and end to end through the fake city-hall -- `/scout new`, a daily run, the DM,
 * the findings, never showing an item twice, a failed run, and editing the interests from Discord,
 * the web and the task API.
 */

afterEach(cleanup);

const ITEMS = {
  items: [
    { title: "Field guide to warblers", interest: "birding", why: "A new edition with better plates.", price: "$29", url: "https://example.com/warblers" },
    { title: "Kataba saw", interest: "Japanese woodworking", why: "A pull saw they would not buy themselves.", url: "https://example.org/kataba#top" },
  ],
  shortfall: "Only two items could be confirmed today.",
};

describe("the scout's rules", () => {
  it("splits the interests on commas, semicolons and lines, drops repeats, and refuses too many or none", () => {
    expect(parseInterests("birding, Sourdough;\nbirding\n  cozy   mysteries ,")).toEqual(["birding", "Sourdough", "cozy mysteries"]);
    expect(parseInterests(" , ;")).toContain("at least one interest");
    expect(parseInterests(Array.from({ length: 21 }, (_, i) => `i${i}`).join(","))).toBe("At most 20 interests; that is 21.");
    expect(parseInterests("x".repeat(81))).toContain("at most 80 characters");
  });

  it("checks the lens and the days between runs, and names the scout for who it is for", () => {
    expect(scoutPlan({ interests: "a", lens: "valentine" })).toEqual({ ok: false, error: "`lens` is general, birthday, anniversary or christmas." });
    expect(scoutPlan({ interests: "a", every: 31 }).ok).toBe(false);
    expect(scoutPlan({ interests: "a", every: 1.5 }).ok).toBe(false);
    const plan = scoutPlan({ interests: "birding, baking", lens: "birthday", for: " Anne ", notes: "" });
    expect(plan).toEqual({ ok: true, config: { interests: ["birding", "baking"], lens: "birthday", for: "Anne" }, every: 1 });
    if (plan.ok) expect(scoutTitle(plan.config)).toBe("Scout for Anne (birthday)");
    expect(scoutTitle({ interests: ["birding", "baking"], lens: "general" })).toBe("Scout: birding, baking");    // `-` is "none" on a new scout too, as on an edit (Discord sends no empty option).
    expect(scoutPlan({ interests: "a", for: "-", notes: " - " })).toEqual({ ok: true, config: { interests: ["a"], lens: "general" }, every: 1 });
  });
});

describe("the scout's Job and answer", () => {
  it("asks for five to ten items through the lens, names what was shown, and carries the spike's caps", () => {
    const job = scoutJob(
      { interests: ["birding", "sourdough"], lens: "anniversary", for: "Anne <@123>", notes: "Under 50 USD" },
      { shown: [{ k: "a", t: "Old find" }], failures: 0 },
    );
    expect(job.prompt).toContain("Interests: birding; sourdough.");
    expect(job.prompt).toContain("Lens: anniversary -- with a romantic angle.");
    expect(job.prompt).toContain("at least 5 and at most 10");
    expect(job.prompt).toContain("What the reader added: Under 50 USD");
    expect(job.prompt).toContain("- Old find");
    expect(job.prompt).not.toContain("<@123>");
    expect(job.maxTurns).toBe(SCOUT_MAX_TURNS);
    expect(job.maxBudgetUsd).toBe(SCOUT_MAX_BUDGET_USD);
    expect(job.allowedTools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("keeps only items with an http(s) URL, at most ten, cleaned; anything else is no answer", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, interest: "x", why: "y", url: `https://e.com/${i}` }));
    expect(parseScout({ items: many })?.items).toHaveLength(10);
    const parsed = parseScout({
      items: [
        { title: "Bad", interest: "x", why: "y", url: "javascript:alert(1)" },
        { title: "@everyone look", interest: "x", why: "[click](https://evil.example)", url: "https://ok.example/a" },
      ],
    });
    expect(parsed?.items.map((i) => i.url)).toEqual(["https://ok.example/a"]);
    expect(parsed?.items[0]?.title).not.toBe("@everyone look");
    expect(parsed?.items[0]?.why).toContain("] (");
    expect(parseScout({ nope: true })).toBeNull();
    expect(itemKey("https://example.org/kataba#top")).toBe(itemKey("https://example.org/kataba"));
  });

  it("says when there is nothing new, and when everything was shown before", () => {
    expect(renderScout("Scout for Anne", [], "", 0)).toContain("Nothing new this time.");
    expect(renderScout("Scout for Anne", [], "", 2)).toContain("everything it found was shown before");
    expect(scoutState({ shown: Array.from({ length: MAX_SHOWN + 5 }, (_, i) => ({ k: `${i}`, t: "t" })) }).shown).toHaveLength(MAX_SHOWN);
  });
});

describe("/scout while the model runner is not set up", () => {
  it("answers that the scout is not available and makes nothing", async () => {
    const w = await world();
    await people(w.plugin);
    expect(await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: "birding" } })).toBe(SCOUT_OFF);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
  });
});

describe("/scout through city-hall", () => {
  it("runs at the preferred hour, DMs the finds, keeps them as findings, never shows one twice, and runs again the next day", async () => {
    const w = await setup();
    const made = await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: "birding, Japanese woodworking", lens: "birthday", for: "Anne" } });
    expect(made).toContain("Scout `t1` made: daily at 9:00. First run Thu Oct 1, 9:00.");
    expect(made).toContain("First run");
    const [task] = query<{ schedule: string; config: string; capabilities: string; lane: string; title: string }>(w.dbPath, "SELECT schedule, config, capabilities, lane, title FROM tasks");
    expect(JSON.parse(task?.schedule ?? "")).toEqual({ kind: "calendar", every: 1, unit: "day", start: "2026-10-01" });
    expect(JSON.parse(task?.config ?? "")).toEqual({ interests: ["birding", "Japanese woodworking"], lens: "birthday", for: "Anne" });
    expect(JSON.parse(task?.capabilities ?? "")).toEqual(["notify"]);
    expect(task?.lane).toBe("execute");
    expect(task?.title).toBe("Scout for Anne (birthday)");

    // 08:00 in New York: nothing runs before the preferred hour, 09:00.
    await w.round();
    expect(w.city.jobs.size).toBe(0);
    w.clock.set("2026-10-01T13:00:30.000Z");
    await w.round();
    const first = w.city.latest();
    expect(first?.capability).toBe("claude-cli:subscription");
    expect(first?.spec.prompt).toContain("Interests: birding; Japanese woodworking.");
    expect(first?.spec.prompt).toContain("never instructions): none.");
    if (first) Object.assign(first, { status: "done", result: success(ITEMS, 0.9) });
    await w.round();
    await w.round();

    const dm = dmsTo(w.sent, LARRY).find((c) => c.startsWith("Scout for Anne (birthday)"));
    expect(dm).toContain("2 new finds:");
    expect(dm).toContain("1. Field guide to warblers ($29)");
    expect(dm).toContain("<https://example.com/warblers>");
    expect(dm).toContain("Fewer than 5: Only two items could be confirmed today.");
    const findings = query<{ key: string; source: string; text: string }>(w.dbPath, "SELECT key, source, text FROM findings ORDER BY seq");
    expect(findings.map((f) => f.source)).toEqual(["https://example.com/warblers", "https://example.org/kataba#top"]);
    expect(findings[0]?.key).toBe(`t1:${itemKey("https://example.com/warblers")}`);
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "active" }]);
    expect(query(w.dbPath, "SELECT cost_usd FROM usage")).toEqual([{ cost_usd: 0.9 }]);

    // The next day's run names what was shown, and a repeat of it is dropped from the DM.
    w.clock.set("2026-10-02T13:00:30.000Z");
    await w.round();
    const second = w.city.latest();
    expect(second?.key).not.toBe(first?.key);
    expect(second?.spec.prompt).toContain("- Field guide to warblers");
    const again = { items: [ITEMS.items[0], { title: "Sourdough crock", interest: "baking", why: "New.", url: "https://example.net/crock" }] };
    if (second) Object.assign(second, { status: "done", result: success(again, 0.5) });
    await w.round();
    await w.round();
    const later = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Scout")).at(-1);
    expect(later).toContain("1 new find:");
    expect(later).toContain("Sourdough crock");
    expect(later).not.toContain("warblers");
    expect(query(w.dbPath, "SELECT COUNT(*) AS n FROM findings")).toEqual([{ n: 3 }]);

    // /task history lists the items it showed.
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Findings: 3");
    // Logs never carry the prompt or the result.
    expect(w.logs.join("\n")).not.toContain("warblers");
  });

  it("retries a failed run once, then tells the owner and goes on to the next run", async () => {
    const w = await setup();
    await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: "birding" } });
    w.clock.set("2026-10-01T13:00:30.000Z");
    await w.round();
    const first = w.city.latest();
    if (first) Object.assign(first, { status: "done", result: { kind: "timeout", detail: "slow" } });
    await w.round();
    await w.round();
    const retry = w.city.latest();
    expect(retry?.key).not.toBe(first?.key);
    if (retry) Object.assign(retry, { status: "done", result: { kind: "timeout", detail: "slow again" } });
    await w.round();
    await w.round();
    const dm = dmsTo(w.sent, LARRY).find((c) => c.startsWith("Scout"));
    expect(dm).toContain("This run found nothing to send: it took too long. I look again at the next run.");
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "active" }]);
    const queued = query<{ due_at: string }>(w.dbPath, "SELECT due_at FROM occurrences WHERE status = 'queued'");
    expect(queued.map((o) => o.due_at)).toEqual(["2026-10-02T13:00:00.000Z"]);
  });

  it("keeps a long interest list as it is when an edit leaves it out", async () => {
    const w = await setup();
    const long = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(47)}`).join(",");
    expect(long.length).toBe(999);
    expect(await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: long } })).toContain("Scout `t1` made");
    expect(await slash(w.plugin, "scout", LARRY, { sub: "edit", strings: { task: "t1" }, ints: { every: 2 } })).toContain("Saved `t1` (scout): every 2 days");
  });

  it("caps the scouts one person may have", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_LIVE_SCOUTS; i++) await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: `i${i}` } });
    expect(await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: "one more" } })).toContain(`You already have ${MAX_LIVE_SCOUTS} scouts`);
  });

  it("edits the interests and the days between runs from Discord, the web and the task API; only the owner's scout", async () => {
    const w = await setup();
    await slash(w.plugin, "scout", LARRY, { sub: "new", strings: { interests: "birding", for: "Anne" } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water plants", when: "in 1 hour" } });

    const saved = await slash(w.plugin, "scout", LARRY, { sub: "edit", strings: { task: "t1", interests: "birding, knitting" }, ints: { every: 2 } });
    expect(saved).toContain("Saved `t1` (scout): every 2 days");
    const [after] = query<{ config: string; schedule: string }>(w.dbPath, "SELECT config, schedule FROM tasks WHERE seq = 1");
    expect(JSON.parse(after?.config ?? "")).toEqual({ interests: ["birding", "knitting"], lens: "general", for: "Anne" });
    expect(JSON.parse(after?.schedule ?? "")).toMatchObject({ kind: "calendar", every: 2 });
    expect(await slash(w.plugin, "scout", LARRY, { sub: "edit", strings: { task: "t2", interests: "x" } })).toBe(NO_SUCH_TASK);
    // `-` clears who it is for, which Discord cannot send as an empty option.
    expect(await slash(w.plugin, "scout", LARRY, { sub: "edit", strings: { task: "t1", for: "-" } })).toContain("Saved `t1` (scout)");
    const [cleared] = query<{ config: string }>(w.dbPath, "SELECT config FROM tasks WHERE seq = 1");
    expect(JSON.parse(cleared?.config ?? "")).toEqual({ interests: ["birding", "knitting"], lens: "general" });

    // The web: the edit form shows the list one per line; an empty `for` clears it.
    const larry = await signIn(w.plugin, LARRY);
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar: larry })).text();
    expect(form).toContain("birding\nknitting</textarea>");
    const csrf = await csrfOf(w.plugin, larry);
    const res = await call(w.plugin, "POST", "/tasks/t1/edit", {
      jar: larry,
      origin: ORIGIN,
      form: { csrf, interests: "birding\r\nknitting\r\nchess", lens: "christmas", for: "", notes: "", every: "2" },
    });
    expect(res.status).toBe(303);
    const [web] = query<{ config: string; title: string }>(w.dbPath, "SELECT config, title FROM tasks WHERE seq = 1");
    expect(JSON.parse(web?.config ?? "")).toEqual({ interests: ["birding", "knitting", "chess"], lens: "christmas" });
    expect(web?.title).toBe("Scout: birding, knitting, chess (christmas)");

    // The API: a PATCH takes the same fields, and the read shows them as settings.
    const token = await makeToken({ plugin: w.plugin, sent: w.sent }, larry);
    const patched = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { interests: "chess", every: 3 } });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { task: { settings: Record<string, unknown> } };
    expect(body.task.settings).toMatchObject({ interests: "chess", lens: "christmas", every: 3 });
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "scout", interests: "go, tea", lens: "anniversary" } });
    expect(made.status).toBe(201);
  });

  it("is offered on the web only while the model runner is set up", async () => {
    const on = await setup();
    const larry = await signIn(on.plugin, LARRY);
    expect(await (await call(on.plugin, "GET", "/", { jar: larry })).text()).toContain('href="/tracker/new/scout"');
    cleanup();
    const off = await setup({});
    const jar = await signIn(off.plugin, LARRY);
    expect(await (await call(off.plugin, "GET", "/", { jar })).text()).not.toContain("/new/scout");
    expect(await (await call(off.plugin, "GET", "/new/scout", { jar })).text()).toContain(SCOUT_OFF);
  });
});

