import { afterEach, describe, expect, it } from "bun:test";
import { NO_SUCH_TASK } from "./actions.js";
import { MAX_LIVE_NEWS, NEWS_OFF, newsPlan, newsTitle, parseInclude } from "./news.js";
import { dmsTo, query, setup, success } from "./web/execute-harness.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

/**
 * The news watch (plan item 153, docket#78): its rules here, and end to end through the fake
 * city-hall -- `/news new`, a run whose search finds items, the review that keeps one, the DM and
 * its finding, a run with nothing new that sends nothing, and editing from Discord, the web and the
 * task API. The type's own Jobs and answers are tested in Rackbops/docket (packages/types/test/news.test.ts).
 */

afterEach(cleanup);

const REISSUE = {
  title: "Alien Shores 40th anniversary vinyl reissue",
  kind: "reissue",
  summary: "A remastered double LP is announced for December.",
  url: "https://label.example/news/alien-shores-40",
  date: "2026-09-28",
};
const NAMESAKE = {
  title: "Platinum Blonde (the UK duo) share a new single",
  kind: "new music",
  summary: "A synth single from the London duo.",
  url: "https://blog.example/platinum-blonde-uk",
  date: "2026-09-29",
};

describe("the news watch's rules", () => {
  it("splits what counts, drops repeats, and refuses too many or too long", () => {
    expect(parseInclude("new music, Reissues;\nnew music\n  show   announcements ,")).toEqual(["new music", "Reissues", "show announcements"]);
    expect(parseInclude(" , ;")).toEqual([]);
    expect(parseInclude(Array.from({ length: 11 }, (_, i) => `k${i}`).join(","))).toContain("at most 10 kinds");
    expect(parseInclude("x".repeat(81))).toContain("at most 80 characters");
  });

  it("checks the subject, the exclusions and the days, and names the watch for its subject", () => {
    expect(newsPlan({ subject: "  " }).ok).toBe(false);
    expect(newsPlan({ subject: "x".repeat(201) }).ok).toBe(false);
    expect(newsPlan({ subject: "a", every: 31 }).ok).toBe(false);
    expect(newsPlan({ subject: "a", exclude: "x".repeat(81) }).ok).toBe(false);
    const plan = newsPlan({ subject: " Platinum  Blonde ", include: "reissues, new music", exclude: "concert", disambiguate: "-", shows: true });
    expect(plan).toEqual({ ok: true, config: { subject: "Platinum Blonde", include: ["reissues", "new music"], exclude: ["concert"], shows: true }, every: 7 });
    if (plan.ok) expect(newsTitle(plan.config)).toBe("News: Platinum Blonde");
    // `-` is "none" on a new watch too, as on an edit (Discord sends no empty option).
    expect(newsPlan({ subject: "a", include: "-", exclude: "-" })).toEqual({ ok: true, config: { subject: "a" }, every: 7 });
  });
});

describe("/news while the model runner is not set up", () => {
  it("answers that the news watch is not available and makes nothing", async () => {
    const w = await world();
    await people(w.plugin);
    expect(await slash(w.plugin, "news", LARRY, { sub: "new", strings: { subject: "Platinum Blonde" } })).toBe(NEWS_OFF);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
    const larry = await signIn(w.plugin, LARRY);
    const token = await makeToken({ plugin: w.plugin, sent: w.sent }, larry);
    const res = await api(w.plugin, "POST", "/tasks", { token, body: { type: "news", subject: "Platinum Blonde" } });
    expect(res.status).toBe(503);
  });
});

describe("/news through city-hall", () => {
  it("searches, has the review check the finds, DMs only the kept one, and sends nothing on a run with nothing new", async () => {
    const w = await setup();
    const made = await slash(w.plugin, "news", LARRY, {
      sub: "new",
      strings: { subject: "Platinum Blonde (the Canadian band)", include: "new music, reissues", exclude: "concert" },
      ints: { every: 1 },
    });
    expect(made).toContain("News watch `t1` made: daily at 9:00. First run Thu Oct 1, 9:00.");
    const [task] = query<{ config: string; capabilities: string; lane: string; title: string }>(w.dbPath, "SELECT config, capabilities, lane, title FROM tasks");
    expect(JSON.parse(task?.config ?? "")).toEqual({ subject: "Platinum Blonde (the Canadian band)", include: ["new music", "reissues"], exclude: ["concert"] });
    expect(JSON.parse(task?.capabilities ?? "")).toEqual(["notify"]);
    expect(task?.lane).toBe("execute");
    expect(task?.title).toBe("News: Platinum Blonde (the Canadian band)");

    w.clock.set("2026-10-01T13:00:30.000Z");
    await w.round();
    const search = w.city.latest();
    expect(search?.spec.prompt).toContain("Subject: Platinum Blonde (the Canadian band).");
    expect(search?.spec.prompt).toContain("What never counts: concert.");
    const concert = { ...REISSUE, title: "Platinum Blonde concert at Massey Hall", url: "https://venue.example/pb" };
    if (search) Object.assign(search, { status: "done", result: success({ items: [REISSUE, concert, NAMESAKE] }, 0.6) });
    await w.round();
    await w.round();
    // No DM yet: the review runs first.
    expect(dmsTo(w.sent, LARRY).filter((c) => c.startsWith("News:"))).toEqual([]);
    const review = w.city.latest();
    expect(review?.key).not.toBe(search?.key);
    expect(review?.spec.prompt).toContain("You are reviewing");
    expect(review?.spec.prompt).not.toContain("Massey Hall");
    if (review) Object.assign(review, { status: "done", result: success({ verdicts: [{ n: 1, keep: true, why: "ok" }, { n: 2, keep: false, why: "the UK duo" }] }, 0.3) });
    await w.round();
    await w.round();
    const dm = dmsTo(w.sent, LARRY).find((c) => c.startsWith("News: Platinum Blonde"));
    expect(dm).toContain("Something new:");
    expect(dm).toContain("Alien Shores 40th anniversary vinyl reissue (2026-09-28)");
    expect(dm).toContain("<https://label.example/news/alien-shores-40>");
    expect(dm).not.toContain("UK duo");
    const findings = query<{ source: string }>(w.dbPath, "SELECT source FROM findings ORDER BY seq");
    expect(findings.map((f) => f.source)).toEqual([REISSUE.url]);

    // The next day: the same two again, and nothing new is sent.
    const before = w.sent.length;
    w.clock.set("2026-10-02T13:00:30.000Z");
    await w.round();
    const next = w.city.latest();
    expect(next?.spec.prompt).toContain(`- ${REISSUE.title}`);
    if (next) Object.assign(next, { status: "done", result: success({ items: [REISSUE, NAMESAKE] }, 0.4) });
    await w.round();
    await w.round();
    expect(w.city.latest()?.key).toBe(next?.key);
    expect(w.sent.length).toBe(before);
    const summaries = query<{ summary: string }>(w.dbPath, "SELECT summary FROM occurrences WHERE dedupe_key LIKE 'sched:%' AND status = 'done' ORDER BY due_at").map((o) => o.summary);
    expect(summaries[0]).toBe("3 found, 0 reported before, 1 excluded; 2 to review");
    expect(summaries.at(-1)).toBe("no news (2 found, 2 reported before, 0 excluded)");
    expect(w.logs.join("\n")).not.toContain("Alien Shores");
  });

  it("caps the news watches one person may have", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_LIVE_NEWS; i++) await slash(w.plugin, "news", LARRY, { sub: "new", strings: { subject: `band ${i}` } });
    expect(await slash(w.plugin, "news", LARRY, { sub: "new", strings: { subject: "one more" } })).toContain(`You already have ${MAX_LIVE_NEWS} news watches`);
  });

  it("edits from Discord, the web and the task API; only the owner's watch", async () => {
    const w = await setup();
    await slash(w.plugin, "news", LARRY, { sub: "new", strings: { subject: "Rhythm Corps", exclude: "tour dates", disambiguate: "the Detroit band" } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water plants", when: "in 1 hour" } });

    const saved = await slash(w.plugin, "news", LARRY, { sub: "edit", strings: { task: "t1", include: "reissues" }, ints: { every: 2 } });
    expect(saved).toContain("Saved `t1` (news watch): every 2 days");
    const config = () => JSON.parse(query<{ config: string }>(w.dbPath, "SELECT config FROM tasks WHERE seq = 1")[0]?.config ?? "");
    expect(config()).toEqual({ subject: "Rhythm Corps", include: ["reissues"], exclude: ["tour dates"], disambiguate: "the Detroit band" });
    expect(await slash(w.plugin, "news", LARRY, { sub: "edit", strings: { task: "t2", subject: "x" } })).toBe(NO_SUCH_TASK);
    // `-` clears a text field, which Discord cannot send empty.
    await slash(w.plugin, "news", LARRY, { sub: "edit", strings: { task: "t1", disambiguate: "-" } });
    expect(config()).toEqual({ subject: "Rhythm Corps", include: ["reissues"], exclude: ["tour dates"] });

    // The web: the edit form shows the kinds one per line; an empty exclude clears it.
    const larry = await signIn(w.plugin, LARRY);
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar: larry })).text();
    expect(form).toContain("reissues</textarea>");
    expect(form).toContain('value="tour dates"');
    const csrf = await csrfOf(w.plugin, larry);
    const res = await call(w.plugin, "POST", "/tasks/t1/edit", {
      jar: larry,
      origin: ORIGIN,
      form: { csrf, subject: "Rhythm Corps (the Detroit band)", include: "reissues\r\nnew music", exclude: "", disambiguate: "", shows: "yes", every: "2" },
    });
    expect(res.status).toBe(303);
    expect(config()).toEqual({ subject: "Rhythm Corps (the Detroit band)", include: ["reissues", "new music"], shows: true });

    // The API: a PATCH takes the same fields; a POST makes one.
    const token = await makeToken({ plugin: w.plugin, sent: w.sent }, larry);
    const patched = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { shows: "no", every: 3 } });
    expect(patched.status).toBe(200);
    expect(config()).toEqual({ subject: "Rhythm Corps (the Detroit band)", include: ["reissues", "new music"] });
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "news", subject: "Platinum Blonde", exclude: "concert" } });
    expect(made.status).toBe(201);
    const checked = await api(w.plugin, "POST", "/tasks/validate", { token, body: { type: "news", subject: "Platinum Blonde", exclude: "x".repeat(81) } });
    expect(checked.status).toBe(400);
    const fine = await api(w.plugin, "POST", "/tasks/validate", { token, body: { type: "news", subject: "Platinum Blonde", every: 14 } });
    expect(((await fine.json()) as { valid: boolean }).valid).toBe(true);
  });

  it("is offered on the web only while the model runner is set up", async () => {
    const on = await setup();
    const larry = await signIn(on.plugin, LARRY);
    expect(await (await call(on.plugin, "GET", "/", { jar: larry })).text()).toContain('href="/tracker/new/news"');
    await cleanup();
    const off = await setup({});
    const jar = await signIn(off.plugin, LARRY);
    expect(await (await call(off.plugin, "GET", "/", { jar })).text()).not.toContain("/new/news");
  });
});
