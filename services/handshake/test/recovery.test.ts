// Group recovery (PROTOCOL.md, "Group recovery"): votes, the quorum for changes to others, the rollback of a removed
// member's changes, and the recovery code as one vote.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import {
  admitStatement,
  type Cosignature,
  formatRecoveryCode,
  HandshakeError,
  type HandshakeClient,
  joinStatement,
  LIMITS,
  newRecoveryCode,
  parseRecoveryCode,
  recoverySigner,
  recoveryStatement,
  removeStatement,
  type Signer,
  signText,
} from "../client";
import type { HandshakeDO } from "../src/handshake-do";
import { client, createdGroup, rawSocket, signer } from "./helpers";

const DAY = 24 * 3600_000;

async function refusal(p: Promise<unknown>): Promise<HandshakeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HandshakeError);
  return err as HandshakeError;
}

/** A join admitted by `by`, and by `more` too; `from` a group the key moves out of, at `requester`'s request. */
async function admit(
  c: HandshakeClient,
  group: string,
  joiner: Signer,
  by: Signer,
  more: Signer[] = [],
  options: { from?: string; requester?: Signer; unsignedFrom?: boolean } = {},
): Promise<{ votesFrom: number }> {
  const t = Date.now();
  const statement = admitStatement(group, joiner.key, t);
  return (await c.joinGroup(group, {
    key: joiner.key,
    t,
    sig: await signText(joiner, joinStatement(group, joiner.key, t, options.unsignedFrom ? undefined : options.from)),
    by: by.key,
    bysig: await signText(by, statement),
    admits: await Promise.all(more.map(async (m) => ({ by: m.key, sig: await signText(m, statement) }))),
    ...(options.from ? { from: options.from } : {}),
    ...(options.requester ? { requester: { key: options.requester.key, sig: await signText(options.requester, statement) } } : {}),
  })) as unknown as { votesFrom: number };
}

const removal = async (group: string, target: string, t: number, signers: Signer[], keep: string[] = []): Promise<Cosignature[]> =>
  Promise.all(signers.map(async (s) => ({ by: s.key, sig: await signText(s, removeStatement(group, target, t, keep)) })));

const recoveryVotes = async (group: string, key: string | null, t: number, signers: Signer[]): Promise<Cosignature[]> =>
  Promise.all(signers.map(async (s) => ({ by: s.key, sig: await signText(s, recoveryStatement(group, key, t)) })));

/** As if 7 days and more had passed for these members: they vote now. */
async function vote(group: string, ...keys: string[]): Promise<void> {
  await runInDurableObject(env.HANDSHAKE.getByName(`group:${group}`), async (_o: HandshakeDO, state) => {
    for (const key of keys) state.storage.sql.exec("UPDATE members SET votes_from = 0 WHERE key = ?", key);
  });
}

/** As if `days` had passed since every change so far. */
async function age(group: string, days: number): Promise<void> {
  await runInDurableObject(env.HANDSHAKE.getByName(`group:${group}`), async (_o: HandshakeDO, state) => {
    state.storage.sql.exec("UPDATE changes SET at = at - ?", days * DAY);
  });
}

const keysOf = async (c: HandshakeClient, group: string, as: Signer) => (await c.group(group, as).get()).members.map((m) => m.key).sort();

describe("votes", () => {
  test("the founder votes at once; a key admitted by a quorum of voters votes at once, by fewer after 7 days", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, cc, d] = [await signer(), await signer(), await signer()];
    const now = Date.now();
    // The founder alone is the quorum of a one-voter group.
    expect((await admit(c, group, b, a)).votesFrom).toBeLessThanOrEqual(Date.now());
    const later = (await admit(c, group, cc, a)).votesFrom;
    expect(later).toBeGreaterThanOrEqual(now + LIMITS.recovery.voteDelayMs);
    expect((await admit(c, group, d, a, [b])).votesFrom).toBeLessThanOrEqual(Date.now());
    const members = (await c.group(group, a).get()).members;
    expect(members.find((m) => m.key === a.key)).toMatchObject({ votesFrom: expect.any(Number) });
    expect(members.find((m) => m.key === a.key)!.admittedBy).toBeUndefined();
    expect(members.find((m) => m.key === cc.key)).toMatchObject({ admittedBy: a.key, votesFrom: later });
  });

  test("a key admitted without a quorum votes only after the full 7-day rollback window, and can't co-sign before", async () => {
    expect(LIMITS.recovery.voteDelayMs).toBe(LIMITS.recovery.rollbackMs);
    const { group, founder: a, c } = await createdGroup();
    const [b, late, target] = [await signer(), await signer(), await signer()];
    await admit(c, group, b, a);
    await vote(group, b.key);
    await admit(c, group, target, a, [b]);
    const before = Date.now();
    expect((await admit(c, group, late, b)).votesFrom).toBeGreaterThanOrEqual(before + LIMITS.recovery.rollbackMs);
    // Four days on, past the old 72 hours, it is still no vote: not as a co-signer, and not as a requester.
    await age(group, 4);
    const when = Date.now();
    expect((await refusal(c.group(group, a).remove(target.key, { t: when, cosigners: await removal(group, target.key, when, [late]) }))).code).toBe("not_voter");
    expect((await refusal(c.group(group, late).remove(target.key, { t: when }))).code).toBe("no_quorum");
  });

  test("a non-voter's admit lets a key in, but doesn't count toward the quorum", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, fresh, e] = [await signer(), await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, fresh, a);
    // fresh doesn't vote yet; its admit is enough to let e in, and e waits.
    expect((await admit(c, group, e, fresh)).votesFrom).toBeGreaterThan(Date.now() + DAY);
    expect((await admit(c, group, await signer(), a, [fresh])).votesFrom).toBeGreaterThan(Date.now() + DAY);
  });

  test("a takeover needs a vote; acquiring a free lease doesn't", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, fresh] = [await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, fresh, a);
    expect((await refusal(c.group(group, fresh).lease("takeover"))).code).toBe("not_voter");
    expect((await c.group(group, fresh).lease("acquire")).holder).toBe(fresh.key);
    expect((await c.group(group, b).lease("takeover")).holder).toBe(b.key);
  });
});

describe("removing others", () => {
  test("takes a quorum of the voters other than the target; yourself, only you", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, t, fresh] = [await signer(), await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, t, a, [b]);
    await admit(c, group, fresh, a);
    // Voters other than t: a and b, so two.
    const alone = await refusal(c.group(group, a).remove(t.key));
    expect([alone.status, alone.code, alone.body]).toEqual([403, "no_quorum", { error: "no_quorum", voters: 2, needed: 2 }]);
    const when = Date.now();
    expect((await refusal(c.group(group, a).remove(t.key, { t: when, cosigners: await removal(group, t.key, when, [fresh]) }))).code).toBe("not_voter");
    await c.group(group, a).remove(t.key, { t: when, cosigners: await removal(group, t.key, when, [b]) });
    expect(await keysOf(c, group, a)).toEqual([a.key, b.key, fresh.key].sort());
    // Leaving needs no one else.
    await c.group(group, fresh).remove(fresh.key);
    expect(await keysOf(c, group, a)).toEqual([a.key, b.key].sort());
  });

  test("a co-signer's vote is bound to the target, the time and the kept keys", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, t] = [await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, t, a, [b]);
    const when = Date.now();
    const votes = await removal(group, t.key, when, [b]);
    expect((await refusal(c.group(group, a).remove(t.key, { t: when + 1, cosigners: votes }))).code).toBe("unauthorized");
    expect((await refusal(c.group(group, a).remove(t.key, { t: when, cosigners: votes, keep: [b.key] }))).code).toBe("unauthorized");
    expect((await refusal(c.group(group, a).remove(b.key, { t: when, cosigners: votes }))).code).toBe("unauthorized");
    // A statement from before the target joined is stale.
    const before = when - 60_000;
    expect((await refusal(c.group(group, a).remove(t.key, { t: before, cosigners: await removal(group, t.key, before, [b]) }))).code).toBe("stale");
  });

  test("removing a member rolls back what it did: the members it removed come back, the keys it admitted go unless kept", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [thief, b, x1, x2, y] = [await signer(), await signer(), await signer(), await signer(), await signer()];
    await admit(c, group, thief, a);
    await admit(c, group, b, a, [thief]);
    // Weeks ago, so a's admits are out of the window.
    await age(group, 8);
    // The thief admits two keys of its own (they wait for their vote), and one of them admits another.
    await admit(c, group, x1, thief);
    await admit(c, group, x2, thief);
    await admit(c, group, y, x1);
    // And b is fooled into co-signing the thief's removal of a.
    let when = Date.now();
    await c.group(group, thief).remove(a.key, { t: when, cosigners: await removal(group, a.key, when, [b]) });
    expect(await keysOf(c, group, b)).toEqual([thief.key, b.key, x1.key, x2.key, y.key].sort());

    // The card shows what removing the thief rolls back.
    expect(await c.group(group, b).rollback(thief.key)).toEqual({ restores: [a.key], drops: [x1.key, x2.key, y.key].sort() });
    when = Date.now();
    await c.group(group, b).remove(thief.key, { t: when, keep: [x2.key], cosigners: [] });
    const members = (await c.group(group, b).get()).members;
    expect(members.map((m) => m.key).sort()).toEqual([a.key, b.key, x2.key].sort());
    // a is back as it was: joined first, voting.
    expect(members[0]).toMatchObject({ key: a.key, votesFrom: expect.any(Number) });
    expect(members[0]!.votesFrom!).toBeLessThanOrEqual(Date.now());
  });

  test("the keys a target admitted neither count toward the quorum nor sign it", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, thief, x] = [await signer(), await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, thief, a, [b]);
    await admit(c, group, x, thief);
    await vote(group, x.key);
    const when = Date.now();
    expect((await refusal(c.group(group, a).remove(thief.key, { t: when, cosigners: await removal(group, thief.key, when, [x]) }))).code).toBe("not_voter");
    // Voters other than the thief, without x: a and b.
    expect((await refusal(c.group(group, a).remove(thief.key))).body).toMatchObject({ voters: 2, needed: 2 });
    await c.group(group, a).remove(thief.key, { t: when, cosigners: await removal(group, thief.key, when, [b]) });
    expect(await keysOf(c, group, a)).toEqual([a.key, b.key].sort());
  });

  test("the rollback reaches back 7 days, no further", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, x] = [await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, x, b);
    await age(group, 8);
    expect(await c.group(group, a).rollback(b.key)).toEqual({ restores: [], drops: [] });
    await c.group(group, a).remove(b.key);
    expect(await keysOf(c, group, a)).toEqual([a.key, x.key].sort());
  });
});

describe("moving between the user's groups", () => {
  test("a vote never moves with a key: it votes at the host only as any new key does, and leaves the old group", async () => {
    const { group: old, founder: a, c } = await createdGroup();
    const [k, b] = [await signer(), await signer()];
    await admit(c, old, b, a);
    await admit(c, old, k, a, [b]);
    // Each group's joins from an address of its own, under the registration limit.
    const { group: host, founder: h, c: hc } = await createdGroup(client());
    const v = await signer();
    await admit(hc, host, v, h);
    await vote(host, v.key);
    // k votes in its old group, but at the host one admitter of two voters isn't a quorum: it waits the 7 days.
    expect((await admit(hc, host, k, h, [], { from: old })).votesFrom).toBeGreaterThanOrEqual(Date.now() + 6 * DAY);
    expect(await keysOf(c, old, a)).toEqual([a.key, b.key].sort());
    // With the host's quorum (both of its voters' cards) a merged key votes at once.
    const [k2] = [await signer()];
    await admit(c, old, k2, a, [b]);
    expect((await admit(hc, host, k2, h, [v], { from: old })).votesFrom).toBeLessThanOrEqual(Date.now());
    // A one-voter host is that quorum by itself.
    const { group: single, founder: s1, c: sc } = await createdGroup(client());
    const k3 = await signer();
    await admit(c, old, k3, a, [b]);
    expect((await admit(sc, single, k3, s1, [], { from: old })).votesFrom).toBeLessThanOrEqual(Date.now());
  });

  test("a thief's own group lends it no votes: its keys can't remove the founder or replace the recovery code", async () => {
    const { group, founder: a, c } = await createdGroup();
    const b = await signer();
    await admit(c, group, b, a);
    await vote(group, b.key);
    const code = await recoverySigner(newRecoveryCode(), group);
    const setAt = Date.now();
    await c.group(group, a).setRecovery(code.key, setAt, await recoveryVotes(group, code.key, setAt, [b]));
    // The thief holds b. It founds a group of its own, where its keys vote at once, and b lets them in here.
    const { group: theirs, founder: thief } = await createdGroup(c);
    const [t1, t2] = [await signer(), await signer()];
    await admit(c, theirs, t1, thief);
    await admit(c, theirs, t2, thief, [t1]);
    for (const key of [thief, t1, t2]) {
      expect((await admit(c, group, key, b, [], { from: theirs })).votesFrom).toBeGreaterThanOrEqual(Date.now() + 6 * DAY);
    }
    // Removing the founder: b alone, with the thief's keys co-signing (not voters), or without them (no quorum).
    let when = Date.now();
    expect((await refusal(c.group(group, b).remove(a.key, { t: when, cosigners: await removal(group, a.key, when, [t1, t2, thief]) }))).code).toBe("not_voter");
    when = Date.now();
    expect((await refusal(c.group(group, b).remove(a.key, { t: when }))).code).toBe("no_quorum");
    // Replacing the recovery code's vote with a key of the thief's.
    const theirCode = await recoverySigner(newRecoveryCode(), group);
    const at = setAt + 1;
    expect((await refusal(c.group(group, b).setRecovery(theirCode.key, at, await recoveryVotes(group, theirCode.key, at, [t1, t2, thief])))).code).toMatch(/^(no_quorum|not_voter)$/);
    expect((await refusal(c.group(group, b).setRecovery(theirCode.key, at))).code).toBe("no_quorum");
    expect((await c.group(group, a).get()).members.map((m) => m.key)).toContain(a.key);
  });

  test("`from` is the joining key's own: unsigned it is refused, and a join that adds nothing moves nothing", async () => {
    const { group: old, founder: a, c } = await createdGroup();
    const k = await signer();
    await admit(c, old, k, a);
    const { group: host, founder: h } = await createdGroup(c);
    // A `from` the key didn't sign (anyone could add it to move a key out of its group) is refused.
    expect((await refusal(admit(c, host, k, h, [], { from: old, unsignedFrom: true }))).status).toBe(401);
    expect(await keysOf(c, old, a)).toEqual([a.key, k.key].sort());
    // A statement for one `from` doesn't serve another.
    await admit(c, host, k, h, [], { from: old });
    expect(await keysOf(c, old, a)).toEqual([a.key]);
    // k is back in old; a join to the host it is already in changes nothing there, so it moves nothing either.
    await admit(c, old, k, a);
    await admit(c, host, k, h, [], { from: old });
    expect(await keysOf(c, old, a)).toEqual([a.key, k.key].sort());
  });

  test("a `from` the key isn't in is an ordinary join; the last member moving out ends the old group", async () => {
    const { group: old, founder: solo, c } = await createdGroup();
    const { group: host, founder: h } = await createdGroup(c);
    const v = await signer();
    await admit(c, host, v, h);
    await vote(host, v.key);
    const stranger = await signer();
    expect((await admit(c, host, stranger, h, [], { from: old })).votesFrom).toBeGreaterThan(Date.now() + DAY);
    expect(await keysOf(c, old, solo)).toEqual([solo.key]);
    await admit(c, host, solo, h, [], { from: old });
    expect((await refusal(c.group(old, solo).get())).status).toBe(410);
    expect((await refusal(admit(c, host, await signer(), h, [], { from: "not-a-group" }))).status).toBe(400);
  });

  test("a key a member asked for is rolled back with that member, whoever signed its admit", async () => {
    const { group, founder: a, c } = await createdGroup();
    const [b, thief, x] = [await signer(), await signer(), await signer()];
    await admit(c, group, b, a);
    await admit(c, group, thief, a, [b]);
    // a signs the admit, at the thief's request.
    await admit(c, group, x, a, [], { requester: thief });
    await vote(group, x.key);
    expect(await c.group(group, a).rollback(thief.key)).toEqual({ restores: [], drops: [x.key] });
    // x is left out of the vote on the thief, as a key the thief admitted.
    const when = Date.now();
    expect((await refusal(c.group(group, a).remove(thief.key, { t: when, cosigners: await removal(group, thief.key, when, [x]) }))).code).toBe("not_voter");
    await c.group(group, a).remove(thief.key, { t: when, cosigners: await removal(group, thief.key, when, [b]) });
    expect(await keysOf(c, group, a)).toEqual([a.key, b.key].sort());
  });
});

describe("the recovery code", () => {
  test("is 26 Crockford base32 characters, read in any case, with 0/O and 1/I/L alike", () => {
    const code = newRecoveryCode();
    const shown = formatRecoveryCode(code);
    expect(shown).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}-[0-9A-HJKMNP-TV-Z]$/);
    expect(parseRecoveryCode(shown)).toEqual(code);
    expect(parseRecoveryCode(shown.toLowerCase().replace(/-/g, " "))).toEqual(code);
    const zeros = formatRecoveryCode(new Uint8Array(16));
    expect(parseRecoveryCode(zeros.replace(/0/g, "o"))).toEqual(new Uint8Array(16));
    expect(parseRecoveryCode(formatRecoveryCode(new Uint8Array(16).fill(0x84)).replace(/1/g, "l"))).toEqual(new Uint8Array(16).fill(0x84));
    expect(parseRecoveryCode(shown.slice(0, -1))).toBeNull();
    expect(parseRecoveryCode(`${shown.slice(0, -1)}U`)).toBeNull();
    // The last character carries 3 bits and 2 zeros.
    expect(parseRecoveryCode(`${zeros.slice(0, -1)}1`)).toBeNull();
  });

  test("gives one key per group", async () => {
    const code = newRecoveryCode();
    const one = b64group();
    expect((await recoverySigner(code, one)).key).toBe((await recoverySigner(code.slice(), one)).key);
    expect((await recoverySigner(code, one)).key).not.toBe((await recoverySigner(code, b64group())).key);
  });

  test("is set by a quorum of the voters, with a newer t each time, and never as a member's key", async () => {
    const { group, founder: a, c } = await createdGroup();
    const b = await signer();
    // When the second device joins, the founder alone is the quorum.
    await admit(c, group, b, a);
    await vote(group, b.key);
    const code = await recoverySigner(newRecoveryCode(), group);
    let t = Date.now();
    expect((await refusal(c.group(group, a).setRecovery(code.key, t))).code).toBe("no_quorum");
    expect((await c.group(group, a).setRecovery(code.key, t, await recoveryVotes(group, code.key, t, [b]))).recovery).toBe(true);
    expect((await refusal(c.group(group, a).setRecovery(null, t, await recoveryVotes(group, null, t, [b])))).code).toBe("stale");
    t++;
    expect((await refusal(c.group(group, a).setRecovery(b.key, t, await recoveryVotes(group, b.key, t, [b, code])))).code).toBe("conflict");
    // Now three votes: clearing it takes two of them.
    expect((await refusal(c.group(group, a).setRecovery(null, t, await recoveryVotes(group, null, t, [])))).code).toBe("no_quorum");
    expect((await c.group(group, a).get()).recovery).toBe(true);
    expect((await c.group(group, a).setRecovery(null, t, await recoveryVotes(group, null, t, [code]))).recovery).toBe(false);
    expect((await c.group(group, a).get()).recovery).toBe(false);
  });

  test("in a two-device group, neither device alone removes the other; with the code, the survivor does, and hears of it", async () => {
    const { group, founder: a, c } = await createdGroup();
    const b = await signer();
    await admit(c, group, b, a);
    await vote(group, b.key);
    const code = await recoverySigner(newRecoveryCode(), group);
    let t = Date.now();
    await c.group(group, a).setRecovery(code.key, t, await recoveryVotes(group, code.key, t, [b]));

    // Neither device alone. Voters other than b: a and the code. Voters other than a: the code alone, since a admitted
    // b this week; b's request doesn't count, the code's vote does.
    expect((await refusal(c.group(group, a).remove(b.key))).body).toMatchObject({ voters: 2, needed: 2 });
    expect((await refusal(c.group(group, b).remove(a.key))).body).toMatchObject({ voters: 1, needed: 1 });
    const sb = await rawSocket((await c.group(group, b).ticket()).url);
    expect(await sb.frames.until((f) => f.t === "hello")).toMatchObject({ recovery: true });
    t = Date.now();
    await c.group(group, b).remove(a.key, { t, cosigners: await removal(group, a.key, t, [code]) });
    expect(await sb.frames.until((f) => f.t === "recovery")).toMatchObject({ change: "remove", target: a.key, by: b.key });
    expect(await keysOf(c, group, b)).toEqual([b.key]);
    // A member that was away gets it from the group's view and its next hello.
    expect((await c.group(group, b).get()).recoveryUsed).toMatchObject({ change: "remove", target: a.key, by: b.key });
    const again = await rawSocket((await c.group(group, b).ticket()).url);
    expect(await again.frames.until((f) => f.t === "hello")).toMatchObject({ recoveryUsed: { target: a.key } });
  });
});

function b64group(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
