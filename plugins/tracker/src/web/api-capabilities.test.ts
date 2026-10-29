import { afterEach, describe, expect, it } from "bun:test";
import { MAX_LIVE_TASKS } from "../limits.js";
import { RATE_BURST } from "./api.js";
import { MAX_PAGE } from "./api-tasks.js";
import { api, cleanup, LARRY, makeToken, people, signIn, slash, world } from "./harness.js";

/**
 * `GET /tasks` paging and `GET /capabilities` (rackbops-bot-plugins#369, part 2), through the plugin's
 * own `http` handler.
 */

afterEach(cleanup);

async function setup(env: Record<string, string> = {}) {
  const w = await world({ env });
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, token };
}

type Page = { tasks: { id: string; title: string }[]; nextCursor?: string | null };

async function page(w: Awaited<ReturnType<typeof setup>>, query: string): Promise<Page> {
  const res = await api(w.plugin, "GET", `/tasks${query}`, { token: w.token });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

const remind = (w: Awaited<ReturnType<typeof setup>>, text: string) =>
  slash(w.plugin, "remind", LARRY, { strings: { text, when: "tomorrow 9am" } });

describe("GET /tasks in pages", () => {
  it("lists every task exactly once across pages, even when one is deleted between them", async () => {
    const w = await setup();
    for (const n of [1, 2, 3, 4, 5]) await remind(w, `task ${n}`);
    const first = await page(w, "?limit=2");
    expect(first.tasks.map((t) => t.title)).toEqual(["task 1", "task 2"]);
    expect(typeof first.nextCursor).toBe("string");
    // The page's last task is deleted before the next page is asked for: the cut does not move.
    const gone = first.tasks[1]?.id as string;
    expect((await api(w.plugin, "DELETE", `/tasks/${gone}`, { token: w.token })).status).toBe(200);
    const second = await page(w, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.tasks.map((t) => t.title)).toEqual(["task 3", "task 4"]);
    const third = await page(w, `?limit=2&cursor=${second.nextCursor}`);
    expect(third.tasks.map((t) => t.title)).toEqual(["task 5"]);
    expect(third.nextCursor).toBeNull();
  });

  it("answers as before without limit, and refuses a bad limit, a cursor alone, a made-up cursor or another parameter", async () => {
    const w = await setup();
    await remind(w, "only one");
    const all = await page(w, "");
    expect(all.tasks).toHaveLength(1);
    expect(all.nextCursor).toBeUndefined();
    const refused = async (q: string) => {
      const res = await api(w.plugin, "GET", `/tasks${q}`, { token: w.token });
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    };
    expect(await refused("?limit=0")).toEqual([400, "invalid"]);
    expect(await refused(`?limit=${MAX_PAGE + 1}`)).toEqual([400, "invalid"]);
    expect(await refused("?limit=1.5")).toEqual([400, "invalid"]);
    expect(await refused("?cursor=dDE")).toEqual([400, "invalid"]);
    expect(await refused("?limit=1&cursor=bm9wZQ")).toEqual([400, "invalid_cursor"]);
    expect(await refused("?limit=1&sort=desc")).toEqual([400, "unknown_field"]);
  });
});

describe("GET /capabilities", () => {
  it("names the types, the owner's zone, the caps and which sources are set up, and no configured value", async () => {
    const secret = "super-secret-firecrawl-key-1234";
    const w = await setup({ TRACKER_FIRECRAWL_KEY: secret });
    const res = await api(w.plugin, "GET", "/capabilities", { token: w.token });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);
    const body = JSON.parse(text) as {
      types: { type: string }[];
      owner: { timeZone: string };
      limits: Record<string, number>;
      sources: Record<string, boolean>;
    };
    expect(body.types.map((t) => t.type)).toContain("reminder");
    expect(typeof body.owner.timeZone).toBe("string");
    expect(body.limits).toMatchObject({ liveTasks: MAX_LIVE_TASKS, pageSize: MAX_PAGE, requestsBurst: RATE_BURST });
    expect(body.sources).toEqual({ runner: false, bgg: false, ebay: false, shopify: true, mail: false, web: true });
    for (const v of Object.values(body.sources)) expect(typeof v).toBe("boolean");
  });
});
