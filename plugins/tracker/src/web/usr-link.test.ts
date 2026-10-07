import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ADMIN, call, cleanup, CURLY, csrfOf, GUILD, LARRY, ORIGIN, people, signIn, world } from "./harness.js";

/**
 * "Link everyone to usr" on the admin page (admin.ts `linkEveryone`): each person with a Discord id
 * and no usr link is allowed in usr by the pressing admin and linked. usr is a fake `fetch`.
 */

afterEach(cleanup);

const USR = "https://id.example.com";
const sub = (n: number) => `6f1c2a9e-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Answer = { status: number; body: unknown };

function fakeUsr(answer: (body: Record<string, unknown>, n: number) => Answer) {
  const calls: Record<string, unknown>[] = [];
  const usrFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/api/discord/allow") throw new Error(`unexpected usr call ${path}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    const a = answer(body, calls.length);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, usrFetch };
}

const ok = (n: number): Answer => ({ status: 200, body: { user_id: sub(n), created: true, roles: ["tracker:member"] } });

async function setup(answer: (body: Record<string, unknown>, n: number) => Answer, guild = true) {
  const usr = fakeUsr(answer);
  const w = await world({ guild, env: { TRACKER_USR_URL: USR, TRACKER_USR_KEY: "k" }, usrFetch: usr.usrFetch });
  await people(w.plugin);
  const admin = await signIn(w.plugin, ADMIN);
  return { ...w, usr, admin, csrf: await csrfOf(w.plugin, admin) };
}

function subjects(dbPath: string): Record<string, string | null> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT discord_id, usr_subject FROM users ORDER BY seq").all() as { discord_id: string; usr_subject: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.discord_id, r.usr_subject]));
  } finally {
    db.close();
  }
}

describe("Link everyone to usr", () => {
  it("allows and links everyone not yet linked, with the admin as the invoker, in TRACKER_GUILD_ID's server", async () => {
    const w = await setup((_b, n) => ok(n));
    const page = await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
    expect(page).toContain("3 on the list are not linked to usr yet.");
    const res = await call(w.plugin, "POST", "/admin/usr-link", { jar: w.admin, form: { csrf: w.csrf }, origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Linked 3 of 3 to usr.");
    expect(w.usr.calls.map((c) => [c.discord_user_id, c.guild_id, c.invoker_discord_user_id, c.roles])).toEqual([
      [ADMIN, GUILD, ADMIN, ["tracker:member"]],
      [LARRY, GUILD, ADMIN, ["tracker:member"]],
      [CURLY, GUILD, ADMIN, ["tracker:member"]],
    ]);
    expect(subjects(w.dbPath)).toEqual({ [ADMIN]: sub(1), [LARRY]: sub(2), [CURLY]: sub(3) });
    // Done: the page says so, and pressing again asks usr for nothing.
    const again = await call(w.plugin, "POST", "/admin/usr-link", { jar: w.admin, form: { csrf: w.csrf }, origin: ORIGIN });
    expect(await again.text()).toContain("Everyone on the list is already linked to usr.");
    expect(w.usr.calls).toHaveLength(3);
  });

  it("stops at the first refusal about the admin, and reports each person's own problem", async () => {
    const w = await setup(() => ({ status: 403, body: { error: "the invoker is not linked to a usr account" } }));
    const res = await call(w.plugin, "POST", "/admin/usr-link", { jar: w.admin, form: { csrf: w.csrf }, origin: ORIGIN });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("usr refused before linking anyone further (the invoker is not linked to a usr account). Linked 0 so far.");
    expect(w.usr.calls).toHaveLength(1);

    const v = await setup((b, n) => (b.discord_user_id === LARRY ? { status: 500, body: { error: "internal" } } : ok(n)));
    const mixed = await (await call(v.plugin, "POST", "/admin/usr-link", { jar: v.admin, form: { csrf: v.csrf }, origin: ORIGIN })).text();
    expect(mixed).toContain("Linked 2 of 3 to usr.");
    expect(mixed).toContain("Not linked: Larry: usr answered HTTP 500: internal.");
  });

  it("refuses without a membership gate, since usr needs a server", async () => {
    const w = await setup((_b, n) => ok(n), false);
    const res = await call(w.plugin, "POST", "/admin/usr-link", { jar: w.admin, form: { csrf: w.csrf }, origin: ORIGIN });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("TRACKER_GUILD_ID is unset: run /allow on each person in the server instead.");
    expect(w.usr.calls).toHaveLength(0);
  });

  it("is not there for a non-admin, nor with the usr link off", async () => {
    const w = await setup((_b, n) => ok(n));
    const larry = await signIn(w.plugin, LARRY);
    const res = await call(w.plugin, "POST", "/admin/usr-link", { jar: larry, form: { csrf: await csrfOf(w.plugin, larry) }, origin: ORIGIN });
    expect(res.status).toBe(404);
    const off = await world({ guild: true });
    await people(off.plugin);
    const admin = await signIn(off.plugin, ADMIN);
    expect(await (await call(off.plugin, "GET", "/admin", { jar: admin })).text()).not.toContain("Link everyone to usr");
    const post = await call(off.plugin, "POST", "/admin/usr-link", { jar: admin, form: { csrf: await csrfOf(off.plugin, admin) }, origin: ORIGIN });
    expect(post.status).toBe(404);
    expect(w.usr.calls).toHaveLength(0);
  });
});
