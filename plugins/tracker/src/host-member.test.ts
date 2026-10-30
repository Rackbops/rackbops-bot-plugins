import { afterEach, describe, expect, it } from "bun:test";
import type { HostMember } from "../../../packages/api/contract.js";
import { MEMBERSHIP_UNKNOWN } from "./web/api.js";
import { MEMBER_GRACE_MS, MEMBER_RECHECK_MS } from "./web/app.js";
import { api, cleanup, GUILD, LARRY, makeToken, people, signIn, world } from "./web/harness.js";

/**
 * The host's member lookup (`HostApi.member`, rackbops-discord-bot#623): with it, the web area and
 * the task API check membership with no interaction in hand, so a restart no longer blocks an API
 * caller until someone uses a command (Rod 2026-10-30: "this needs to be fixed"). Without it, the
 * old path (an interaction's Client) stays, pinned in web/api.test.ts (#229).
 */

afterEach(cleanup);

const ROLE = "555555555555555555";

function lookup() {
  const l = { answer: { roleIds: [GUILD], guildRoleIds: [GUILD] } as HostMember | null | Error, calls: [] as string[][] };
  const fn = async (guildId: string, userId: string): Promise<HostMember | null> => {
    l.calls.push([guildId, userId]);
    if (l.answer instanceof Error) throw l.answer;
    return l.answer;
  };
  return { l, fn };
}

async function setup(hostMember: (g: string, u: string) => Promise<HostMember | null>, env: Record<string, string> = {}) {
  const w = await world({ guild: true, hostMember, env });
  await people(w.plugin);
  const jar = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, jar);
  return { ...w, token };
}

describe("HostApi.member", () => {
  it("answers the task API's re-check with no interaction ever handled: a member stays, one who left loses the token", async () => {
    const { l, fn } = lookup();
    const w = await setup(fn);
    w.clock.advance(MEMBER_RECHECK_MS);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    expect(l.calls).toContainEqual([GUILD, LARRY]);
    w.clock.advance(MEMBER_RECHECK_MS);
    l.answer = null;
    const left = await api(w.plugin, "GET", "/me", { token: w.token });
    expect(left.status).toBe(403);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
  });

  it("a lookup that fails is unknown: let on through the grace, then 503, never a revoke", async () => {
    const { l, fn } = lookup();
    const w = await setup(fn);
    l.answer = new Error("Discord down");
    w.clock.advance(MEMBER_GRACE_MS);
    const res = await api(w.plugin, "GET", "/me", { token: w.token });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(MEMBERSHIP_UNKNOWN);
    // Back up: the next check, a minute on, lets them on; the token was never revoked.
    l.answer = { roleIds: [GUILD], guildRoleIds: [GUILD] };
    w.clock.advance(60_000);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
  });

  it("reads TRACKER_GUILD_ROLES off the host's role ids: the role held is a member, lacking it is not", async () => {
    const { l, fn } = lookup();
    l.answer = { roleIds: [GUILD, ROLE], guildRoleIds: [GUILD, ROLE] };
    const w = await setup(fn, { TRACKER_GUILD_ROLES: `${GUILD}:${ROLE}` });
    w.clock.advance(MEMBER_RECHECK_MS);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    w.clock.advance(MEMBER_RECHECK_MS);
    l.answer = { roleIds: [GUILD], guildRoleIds: [GUILD, ROLE] };
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(403);
  });
});
