import { describe, expect, test } from "vitest";

import { CLOSE, groupStatement, HandshakeError, type LeaseView, signText } from "../client";
import { client, createdGroup, join, newPairId, rawSocket, signer } from "./helpers";

async function refusal(promise: Promise<unknown>): Promise<HandshakeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandshakeError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("membership", () => {
  test("the founder creates; a member admits a newcomer; the same again is 200; a stranger can't admit", async () => {
    const { group, founder, c } = await createdGroup();
    // One `t` for the request and its statement: read twice, the clock can tick between them and the signature then
    // covers another time (the 401 seen in merge-group run 42381855476).
    let t = Date.now();
    const again = await c.createGroup({ group, key: founder.key, t, sig: await signText(founder, groupStatement(group, founder.key, t)) });
    expect(again).toEqual({ group });
    const someone = await signer();
    t = Date.now();
    const taken = await refusal(c.createGroup({ group, key: someone.key, t, sig: await signText(someone, groupStatement(group, someone.key, t)) }));
    expect([taken.status, taken.code]).toEqual([409, "conflict"]);

    const laptop = await signer();
    const joined = await join(c, group, laptop, founder);
    expect((joined.members as { key: string }[]).map((m) => m.key)).toEqual([founder.key, laptop.key]);
    expect(await join(c, group, laptop, founder)).toMatchObject({ members: expect.any(Array) });

    const stranger = await signer();
    expect((await refusal(join(c, group, await signer(), stranger))).code).toBe("not_member");
    const view = await c.group(group, laptop).get();
    expect(view.members.map((m) => m.key)).toEqual([founder.key, laptop.key]);
    expect(view.lease).toEqual({ holder: null, epoch: 0, expiresAt: 0 });
  });

  test("a join needs the joiner's own statement and the admitter's over the same key and time", async () => {
    const { group, founder, c } = await createdGroup();
    const joiner = await signer();
    const t = Date.now();
    const sig = await signText(joiner, `clover-handshake-v1 join\n${group}\n${joiner.key}\n${t}`);
    const wrongAdmit = await signText(founder, `clover-handshake-v1 admit\n${group}\n${joiner.key}\n${t + 1}`);
    const err = await refusal(c.joinGroup(group, { key: joiner.key, t, sig, by: founder.key, bysig: wrongAdmit }));
    expect(err.status).toBe(401);
  });

  test("at most 32 members", async () => {
    const { group, founder, c } = await createdGroup();
    // Each join from its own address: joins count against the registration limit.
    for (let i = 1; i < 32; i++) await join(client(), group, await signer(), founder);
    expect((await refusal(join(client(), group, await signer(), founder))).code).toBe("full");
    expect((await c.group(group, founder).get()).members).toHaveLength(32);
  });

  test("a removed key can't come back on an old statement, only on a newer one", async () => {
    const { group, founder, c } = await createdGroup();
    const phone = await signer();
    const t = Date.now() - 5000;
    await join(c, group, phone, founder, t);
    await c.group(group, founder).remove(phone.key);
    expect((await refusal(c.group(group, phone).get())).code).toBe("not_member");
    expect((await refusal(join(c, group, phone, founder, t))).code).toBe("revoked");
    await join(c, group, phone, founder, Date.now() + 1000);
    expect((await c.group(group, phone).get()).members).toHaveLength(2);
  });

  test("the group ends when its last member leaves", async () => {
    const { group, founder, c } = await createdGroup();
    await c.group(group, founder).remove(founder.key);
    expect((await refusal(c.group(group, founder).get())).status).toBe(410);
    const t = Date.now();
    const again = await refusal(c.createGroup({ group, key: founder.key, t, sig: await signText(founder, groupStatement(group, founder.key, t)) }));
    expect(again.status).toBe(410);
  });

  test("an unknown group is 404", async () => {
    expect((await refusal(client().group(newPairId(), await signer()).get())).status).toBe(404);
  });
});

describe("the lease", () => {
  test("the first to acquire holds it; others are refused with the lease; renew and release need the epoch", async () => {
    const { group, founder: studio, c } = await createdGroup();
    const laptop = await signer();
    await join(c, group, laptop, studio);
    const gs = c.group(group, studio);
    const gl = c.group(group, laptop);

    const held = await gs.lease("acquire", { ttl: 30 });
    expect(held).toMatchObject({ holder: studio.key, epoch: 1 });
    expect(held.expiresAt - Date.now()).toBeGreaterThan(29_000);

    const refused = await refusal(gl.lease("acquire"));
    expect([refused.status, refused.code]).toEqual([409, "held"]);
    expect(refused.body.lease).toEqual(held);

    // Acquiring again while holding keeps the epoch; renewing with a wrong epoch is refused.
    expect((await gs.lease("acquire")).epoch).toBe(1);
    expect((await refusal(gs.lease("renew", { epoch: 0 }))).code).toBe("held");
    expect((await gs.lease("renew", { epoch: 1, ttl: 120 })).expiresAt - Date.now()).toBeGreaterThan(119_000);
    expect((await refusal(gl.lease("release", { epoch: 1 }))).code).toBe("held");

    await gs.lease("release", { epoch: 1 });
    const next = await gl.lease("acquire");
    expect(next).toMatchObject({ holder: laptop.key, epoch: 2 });
  });

  test("takeover always wins and raises the epoch; a lapsed lease is free to take", async () => {
    const { group, founder: studio, c } = await createdGroup();
    const laptop = await signer();
    await join(c, group, laptop, studio);
    await c.group(group, studio).lease("acquire", { ttl: 10 });
    const taken = await c.group(group, laptop).lease("takeover");
    expect(taken).toMatchObject({ holder: laptop.key, epoch: 2 });
    expect((await refusal(c.group(group, studio).lease("renew", { epoch: 1 }))).code).toBe("held");
    expect((await refusal(c.group(group, studio).lease("acquire", { ttl: 9 }))).status).toBe(400);
  });

  test("removing the holder frees the lease; the next holder gets a higher epoch", async () => {
    const { group, founder: studio, c } = await createdGroup();
    const laptop = await signer();
    await join(c, group, laptop, studio);
    await c.group(group, laptop).lease("acquire");
    await c.group(group, studio).remove(laptop.key);
    expect((await c.group(group, studio).get()).lease.holder).toBeNull();
    expect(await c.group(group, studio).lease("acquire")).toMatchObject({ holder: studio.key, epoch: 2 });
  });

  test("the group socket hears lease and membership changes; a removed member's socket closes", async () => {
    const { group, founder: studio, c } = await createdGroup();
    const laptop = await signer();
    await join(c, group, laptop, studio);
    const ss = await rawSocket((await c.group(group, studio).ticket()).url);
    expect(await ss.frames.until((f) => f.t === "hello")).toMatchObject({ scope: "group", members: expect.any(Array), lease: { holder: null } });
    const sl = await rawSocket((await c.group(group, laptop).ticket()).url);
    await sl.frames.until((f) => f.t === "hello");

    await c.group(group, laptop).lease("acquire");
    const pushed = (await ss.frames.until((f) => f.t === "lease")) as { lease: LeaseView };
    expect(pushed.lease.holder).toBe(laptop.key);

    const tablet = await signer();
    await join(c, group, tablet, studio);
    await ss.frames.until((f) => f.t === "members" && f.members.length === 3);

    await c.group(group, studio).remove(laptop.key);
    expect(await sl.frames.closed()).toBe(CLOSE.ended);
    await ss.frames.until((f) => f.t === "lease" && f.lease.holder === null);
  });
});
