// Account tokens, tags and tickets: who may use the plugin API, and what a made-up value gets.

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { verifyAccountToken } from "../../shared/account-token";
import { CLOSE_REAUTH } from "../../../plugins/clover/forwarder/src/wire/protocol";
import type { ForwarderDO } from "../src/forwarder-do";
import { accountObject, accountTag, mintTicket, readTag, readTicket, tagKeysFrom } from "../src/identity";
import {
  accountToken,
  apiCall,
  objectOf,
  openSocket,
  postHook,
  registerComputer,
  registeredRoutine,
  routineKey,
  Socket,
  uniqueAccount,
  upgrade,
  worker,
} from "./helpers";

const config = () => ({ jwks: env.ACCOUNT_JWKS, issuer: env.ACCOUNT_ISSUER, audience: env.HOOKS_AUDIENCE });
const now = () => Math.floor(Date.now() / 1000);

describe("account tokens", () => {
  it("accepts ES256 and EdDSA tokens from the account service", async () => {
    for (const alg of ["ES256", "EdDSA"] as const) {
      const token = await accountToken({ account: "acct-1", device: "laptop", alg });
      expect(await verifyAccountToken(token, config())).toMatchObject({ account: "acct-1", device: "laptop" });
    }
  });

  it("accepts an audience list that names this service", async () => {
    const token = await accountToken({ account: "a", device: "d", aud: ["push.waifucave.com", env.HOOKS_AUDIENCE] });
    expect(await verifyAccountToken(token, config())).not.toBeNull();
  });

  it("refuses tokens that are expired, early, too long-lived, or for someone else", async () => {
    const cases: Parameters<typeof accountToken>[0][] = [
      { account: "a", device: "d", exp: now() - 120 },
      { account: "a", device: "d", iat: now() + 600, exp: now() + 1200 },
      { account: "a", device: "d", iat: now(), exp: now() + 3 * 24 * 3600 },
      { account: "a", device: "d", aud: "push.waifucave.com" },
      { account: "a", device: "d", iss: "https://evil.example" },
      { account: "a", device: "not a device id!" },
      { account: "a", device: "d", kid: "unknown-kid" },
      { account: "", device: "d" },
    ];
    for (const options of cases) {
      expect(await verifyAccountToken(await accountToken(options), config())).toBeNull();
    }
  });

  it("refuses a tampered or unsigned token", async () => {
    const token = await accountToken({ account: "a", device: "d" });
    const [header, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ iss: env.ACCOUNT_ISSUER, aud: env.HOOKS_AUDIENCE, sub: "victim", dev: "d", iat: now(), exp: now() + 60 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAccountToken(`${header}.${forged}.${signature}`, config())).toBeNull();
    const none = btoa(JSON.stringify({ alg: "none" })).replace(/=+$/, "");
    expect(await verifyAccountToken(`${none}.${forged}.`, config())).toBeNull();
    expect(await verifyAccountToken("not-a-token", config())).toBeNull();
    // An ES256 key named by an EdDSA header is not accepted either.
    const mixed = await accountToken({ account: "a", device: "d", alg: "EdDSA", kid: "test-es256" });
    expect(await verifyAccountToken(mixed, config())).toBeNull();
  });

  it("refuses a token not yet valid, one with critical header extensions, and an oversized one", async () => {
    expect(await verifyAccountToken(await accountToken({ account: "a", device: "d", extra: { nbf: now() + 600 } }), config())).toBeNull();
    expect(await verifyAccountToken(await accountToken({ account: "a", device: "d", extra: { nbf: now() - 10 } }), config())).not.toBeNull();
    expect(await verifyAccountToken(await accountToken({ account: "a", device: "d", extra: { nbf: "soon" } }), config())).toBeNull();
    expect(await verifyAccountToken(await accountToken({ account: "a", device: "d", header: { crit: ["exp"] } }), config())).toBeNull();
    const padded = await accountToken({ account: "a", device: "d", extra: { pad: "x".repeat(9000) } });
    expect(padded.length).toBeGreaterThan(8192);
    expect(await verifyAccountToken(padded, config())).toBeNull();
  });

  it("the API answers 401 without a valid token", async () => {
    expect((await worker("/v1/routines")).status).toBe(401);
    expect((await worker("/v1/routines", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const stale = await accountToken({ account: "a", device: "d", exp: now() - 3600, iat: now() - 7200 });
    expect((await apiCall(stale, "GET", "/v1/routines")).status).toBe(401);
  });
});

describe("tags", () => {
  const keys = () => tagKeysFrom(env.TAG_KEYS);

  it("are stable per account, differ between accounts, and carry a MAC", async () => {
    const a = await accountTag(keys(), env.ACCOUNT_ID_KEY, "account-a");
    expect(await accountTag(keys(), env.ACCOUNT_ID_KEY, "account-a")).toBe(a);
    expect(await accountTag(keys(), env.ACCOUNT_ID_KEY, "account-b")).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await readTag(keys(), a)).toEqual({ object: await accountObject(env.ACCOUNT_ID_KEY, "account-a"), version: 2 });
    const flipped = a.slice(0, 23) + (a[23] === "A" ? "B" : "A");
    expect(await readTag(keys(), flipped)).toBeNull();
  });

  it("rotate: a tag under an older listed key still names the same account's object, and a retired one does not", async () => {
    const current = keys();
    const v1Only = tagKeysFrom(JSON.stringify({ "1": current.byVersion.get(1)! }));
    const old = await accountTag(v1Only, env.ACCOUNT_ID_KEY, "account-r");
    const now = await accountTag(current, env.ACCOUNT_ID_KEY, "account-r");
    expect(old).not.toBe(now);
    const object = await accountObject(env.ACCOUNT_ID_KEY, "account-r");
    expect(await readTag(current, old)).toEqual({ object, version: 1 });
    expect(await readTag(current, now)).toEqual({ object, version: 2 });
    const v2Only = tagKeysFrom(JSON.stringify({ "2": current.byVersion.get(2)! }));
    expect(await readTag(v2Only, old)).toBeNull();
  });

  it("a webhook URL from before a rotation keeps working while its key version is listed", async () => {
    const pc = await registerComputer(uniqueAccount(), "pc");
    const key = routineKey();
    const { url } = await registeredRoutine(pc, "rotated", key);
    expect(url).toContain(`/${pc.tag}/`);
    const v1Only = tagKeysFrom(JSON.stringify({ "1": keys().byVersion.get(1)! }));
    const oldTag = await accountTag(v1Only, env.ACCOUNT_ID_KEY, pc.account);
    expect((await postHook(`https://hooks.test/${oldTag}/rotated`, key, "via the old tag")).status).toBe(202);
  });

  it("a made-up tag never reaches a Durable Object", async () => {
    const response = await worker("/AAAAAAAAAAAAAAAAAAAAAAAA/some-routine", { method: "POST", body: "x" });
    expect(response.status).toBe(404);
  });
});

describe("tickets", () => {
  it("open one connection for one computer, briefly", async () => {
    const t = Date.now();
    const object = await accountObject(env.ACCOUNT_ID_KEY, "x");
    const { ticket, claims } = await mintTicket(env.TICKET_SECRET, { object, device: "laptop", now: t, ttlMs: 60_000, authExpiresAt: t + 600_000 });
    expect(await readTicket(env.TICKET_SECRET, ticket, t + 1000)).toEqual(claims);
    expect(await readTicket(env.TICKET_SECRET, ticket, t + 61_000)).toBeNull();
    const parts = ticket.split(".");
    parts[1] = "desktop";
    expect(await readTicket(env.TICKET_SECRET, parts.join("."), t)).toBeNull();
    const longer = ticket.split(".");
    longer[3] = String(t + 999_999_000); // a later token expiry, forged
    expect(await readTicket(env.TICKET_SECRET, longer.join("."), t)).toBeNull();
  });

  it("never outlive the token they were bought with", async () => {
    const t = Date.now();
    const { claims } = await mintTicket(env.TICKET_SECRET, { object: "AAAAAAAAAAAAAAA", device: "d", now: t, ttlMs: 60_000, authExpiresAt: t + 5_000 });
    expect(claims.expiresAt).toBe(t + 5_000);
  });

  it("a forged or missing ticket cannot connect", async () => {
    expect((await upgrade("https://hooks.test/v1/connect?ticket=nope")).status).toBe(401);
    expect((await upgrade("https://hooks.test/v1/connect")).status).toBe(401);
    expect((await worker("/v1/connect?ticket=x")).status).toBe(426);
  });

  it("a computer that never registered its key cannot connect", async () => {
    const token = await accountToken({ account: uniqueAccount(), device: "ghost" });
    const ticket = (await (await apiCall(token, "POST", "/v1/tickets")).json()) as { url: string };
    expect((await upgrade(ticket.url)).status).toBe(403);
  });

  it("a ticket opens one connection, even after that connection closes and the object is evicted", async () => {
    const laptop = await registerComputer(uniqueAccount(), "laptop");
    const ticket = (await (await apiCall(laptop.token, "POST", "/v1/tickets")).json()) as { url: string };
    // Each refusal's body is read: an unread one keeps its request open, and eviction waits for it.
    const again = async () => {
      const response = await upgrade(ticket.url);
      await response.text();
      return response.status;
    };
    const first = await upgrade(ticket.url);
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    expect(await again()).toBe(409);
    first.webSocket!.close(1000, "done");
    await new Promise((r) => setTimeout(r, 100));
    expect(await again()).toBe(409);
    await evictDurableObject(env.FORWARDER.getByName(objectOf(laptop.tag)), { webSockets: "close" });
    expect(await again()).toBe(409);
    // A fresh ticket still connects.
    const fresh = (await (await apiCall(laptop.token, "POST", "/v1/tickets")).json()) as { url: string };
    const next = await upgrade(fresh.url);
    expect(next.status).toBe(101);
    next.webSocket!.accept();
    next.webSocket!.close(1000, "done");
  });

  it("forgets a used ticket once it can no longer be presented", async () => {
    const laptop = await registerComputer(uniqueAccount(), "laptop");
    const object = env.FORWARDER.getByName(objectOf(laptop.tag));
    const used = (await (await apiCall(laptop.token, "POST", "/v1/tickets")).json()) as { url: string };
    (await upgrade(used.url)).webSocket!.accept();
    await runInDurableObject(object, (_i: ForwarderDO, state) => {
      state.storage.sql.exec("INSERT INTO tickets (nonce, expires) VALUES ('expired-long-ago', ?)", Date.now() - 120_001);
    });
    const fresh = (await (await apiCall(laptop.token, "POST", "/v1/tickets")).json()) as { url: string };
    const next = await upgrade(fresh.url);
    expect(next.status).toBe(101);
    next.webSocket!.accept();
    const left = await runInDurableObject(object, (_i: ForwarderDO, state) =>
      state.storage.sql.exec<{ nonce: string }>("SELECT nonce FROM tickets").toArray().map((row) => row.nonce),
    );
    expect(left).toHaveLength(2);
    expect(left).not.toContain("expired-long-ago");
    next.webSocket!.close(1000, "done");
  });
});

describe("a connection and its token", () => {
  it("ends with the account token it was opened with: the next thing to arrive closes it, and nothing is sent", async () => {
    const account = uniqueAccount();
    const pc = await registerComputer(account, "pc");
    const { key, url } = await registeredRoutine(pc, "late");
    const expiresAt = now() + 2;
    const short = await accountToken({ account, device: "pc", exp: expiresAt });
    const ticket = (await (await apiCall(short, "POST", "/v1/tickets")).json()) as { url: string; expiresAt: number };
    expect(ticket.expiresAt).toBeLessThanOrEqual(expiresAt * 1000);
    const response = await upgrade(ticket.url);
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    const socket = new Socket(response.webSocket!);
    await socket.until(() => socket.text().some((m) => m.includes('"hello"')), 5000, "hello");
    while (Date.now() <= expiresAt * 1000 + 50) await new Promise((r) => setTimeout(r, 50));

    expect((await postHook(url, key, "after the token")).status).toBe(202);
    await socket.until(() => socket.closed !== null, 5000, "the close");
    expect(socket.closed!.code).toBe(CLOSE_REAUTH);
    expect(socket.text().some((m) => m.includes('"reauth"'))).toBe(true);
    expect(socket.binary()).toHaveLength(0);
    // Still held, for the computer's next connection with a fresh token.
    const fresh = await openSocket(pc);
    await fresh.until(() => fresh.binary().length === 1, 5000, "the held webhook");
    fresh.close();
  });
});

describe("logs", () => {
  it("never carry a routine key, an account token or a ticket", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    try {
      const pc = await registerComputer(uniqueAccount(), "pc");
      const key = routineKey();
      const { url } = await registeredRoutine(pc, "quiet-logs", key);
      const ticket = (await (await apiCall(pc.token, "POST", "/v1/tickets")).json()) as { ticket: string; url: string };
      const socket = await openSocket(pc);
      await postHook(url, key, "by header");
      await postHook(url, key, "by query", { keyIn: "query" });
      await postHook(url, `${key}x`, "a wrong key", { keyIn: "query" });
      await postHook(url, key, null, { method: "GET", keyIn: "query" });
      await upgrade(ticket.url).then((r) => r.text());
      await apiCall(`${pc.token}x`, "GET", "/v1/routines");
      socket.close();
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((part) => String(part))).join("\n");
      for (const secret of [key, pc.token, ticket.ticket, ticket.ticket.split(".").at(-1)!]) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
