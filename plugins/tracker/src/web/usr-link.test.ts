import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { CONFIRM_WORD } from "./admin-pages.js";
import { usrLinkRunsSettled } from "./admin.js";
import { ADMIN, call, cleanup, CURLY, csrfOf, GUILD, LARRY, ORIGIN, people, signIn, type WebLookup, world } from "./harness.js";

/**
 * "Link everyone to usr" on the admin page (admin.ts `linkEveryone`): each person with a Discord id
 * and no usr link is allowed in usr by the pressing admin and linked. usr is a fake `fetch`.
 */

afterEach(cleanup);

const USR = "https://id.example.com";
const sub = (n: number) => `6f1c2a9e-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Answer = { status: number; body: unknown };

function fakeUsr(answer: (body: Record<string, unknown>, n: number) => Answer | Promise<Answer>) {
  const calls: Record<string, unknown>[] = [];
  const usrFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/api/discord/allow") throw new Error(`unexpected usr call ${path}`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    const a = await answer(body, calls.length);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, usrFetch };
}

const ok = (n: number): Answer => ({ status: 200, body: { user_id: sub(n), created: true, roles: ["tracker:member"] } });

/** Everyone is a member of the server unless `webMembership` says otherwise. */
async function setup(
  answer: (body: Record<string, unknown>, n: number) => Answer | Promise<Answer>,
  guild = true,
  webMembership: WebLookup = async () => "member",
) {
  const usr = fakeUsr(answer);
  const w = await world({ guild, env: { TRACKER_USR_URL: USR, TRACKER_USR_KEY: "k" }, usrFetch: usr.usrFetch, webMembership });
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

type World = Awaited<ReturnType<typeof setup>>;

/** Presses the button; a run starts in the background and the press goes back to the admin page. */
function press(w: World) {
  return call(w.plugin, "POST", "/admin/usr-link", { jar: w.admin, form: { csrf: w.csrf }, origin: ORIGIN });
}

/** Waits for the run to end, then reads the admin page. */
async function finished(w: World): Promise<string> {
  await usrLinkRunsSettled();
  return (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
}

function held() {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

describe("Link everyone to usr", () => {
  it("allows and links everyone not yet linked, in the background, with the admin as the invoker, in TRACKER_GUILD_ID's server", async () => {
    const w = await setup((_b, n) => ok(n));
    const page = await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
    expect(page).toContain("3 on the list are not linked to usr yet.");
    const res = await press(w);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/admin");
    expect(await finished(w)).toContain("Last run: Linked 3 of 3 to usr.");
    expect(w.usr.calls.map((c) => [c.discord_user_id, c.guild_id, c.invoker_discord_user_id, c.roles])).toEqual([
      [ADMIN, GUILD, ADMIN, ["tracker:member"]],
      [LARRY, GUILD, ADMIN, ["tracker:member"]],
      [CURLY, GUILD, ADMIN, ["tracker:member"]],
    ]);
    expect(subjects(w.dbPath)).toEqual({ [ADMIN]: sub(1), [LARRY]: sub(2), [CURLY]: sub(3) });
    // Done: the page says so, and pressing again asks usr for nothing.
    const again = await press(w);
    expect(await again.text()).toContain("Everyone on the list is already linked to usr.");
    expect(w.usr.calls).toHaveLength(3);
  });

  it("shows how far a run has got, and a second press while it runs starts nothing", async () => {
    const hold = held();
    const w = await setup(async (_b, n) => {
      await hold.gate;
      return ok(n);
    });
    expect((await press(w)).status).toBe(303);
    const during = await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
    expect(during).toContain("Linking everyone to usr: 0 of 3 done.");
    expect(during).not.toContain('action="/admin/usr-link"');
    const second = await press(w);
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("Already linking everyone to usr: 0 of 3 done.");
    hold.release();
    expect(await finished(w)).toContain("Last run: Linked 3 of 3 to usr.");
    expect(w.usr.calls).toHaveLength(3);
  });

  it("stops at the first failure that would fail everyone, and goes on past a 400 about one person", async () => {
    const refusals: Answer[] = [
      { status: 403, body: { error: "the invoker is not linked to a usr account" } },
      { status: 403, body: { error: 'key "clerk" is not configured as a Discord service' } },
      { status: 401, body: { error: "unauthorized" } },
      { status: 400, body: { error: "guild_id must be a Discord id" } },
      { status: 500, body: { error: "internal" } },
    ];
    for (const refusal of refusals) {
      const w = await setup(() => refusal);
      await press(w);
      const page = await finished(w);
      expect(page).toContain("Linking to usr stopped, since it would fail for everyone:");
      expect(page).toContain("Linked 0 so far");
      expect(w.usr.calls).toHaveLength(1);
    }

    const down = await setup(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await press(down);
    expect(await finished(down)).toContain("Linking to usr stopped, since it would fail for everyone:");
    expect(down.usr.calls).toHaveLength(1);

    const v = await setup((b, n) => (b.discord_user_id === LARRY ? { status: 400, body: { error: "display_name is too long" } } : ok(n)));
    await press(v);
    const mixed = await finished(v);
    expect(mixed).toContain("Linked 2 of 3 to usr.");
    expect(mixed).toContain("Not linked: Larry: usr answered HTTP 400: display_name is too long.");
  });

  it("checks each person is a member of the server, as /allow does, and never sends one who is not", async () => {
    const w = await setup((_b, n) => ok(n), true, async (id) => (id === LARRY ? "not-member" : id === CURLY ? null : "member"));
    await press(w);
    const page = await finished(w);
    expect(page).toContain("Linked 1 of 3 to usr.");
    expect(page).toContain("Larry: not a member of the server, or lacks its role");
    expect(page).toContain("user333: could not check they are a member of the server");
    expect(w.usr.calls.map((c) => c.discord_user_id)).toEqual([ADMIN]);
  });

  it("never sends usr someone forgotten while the run was going", async () => {
    const hold = held();
    const w = await setup(async (_b, n) => {
      if (n === 1) await hold.gate;
      return ok(n);
    });
    await press(w);
    const curly = await signIn(w.plugin, CURLY);
    const gone = await call(w.plugin, "POST", "/forget", { jar: curly, form: { csrf: await csrfOf(w.plugin, curly), confirm: "yes", word: CONFIRM_WORD }, origin: ORIGIN });
    expect(gone.status).toBe(303);
    hold.release();
    expect(await finished(w)).toContain("Linked 2 of 3 to usr.");
    expect(w.usr.calls.map((c) => c.discord_user_id)).toEqual([ADMIN, LARRY]);
  });

  it("refuses without a membership gate, since usr needs a server", async () => {
    const w = await setup((_b, n) => ok(n), false);
    const res = await press(w);
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
