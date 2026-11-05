// Account tokens, tags and tickets: who may use the plugin API, and what a made-up value gets.

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { verifyAccountToken } from "../../shared/account-token";
import type { ForwarderDO } from "../src/forwarder-do";
import { accountTag, isValidTag, mintTicket, readTicket } from "../src/identity";
import { accountToken, apiCall, registerComputer, uniqueAccount, upgrade, worker } from "./helpers";

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

  it("the API answers 401 without a valid token", async () => {
    expect((await worker("/v1/routines")).status).toBe(401);
    expect((await worker("/v1/routines", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const stale = await accountToken({ account: "a", device: "d", exp: now() - 3600, iat: now() - 7200 });
    expect((await apiCall(stale, "GET", "/v1/routines")).status).toBe(401);
  });
});

describe("tags", () => {
  it("are stable per account, differ between accounts, and carry a MAC", async () => {
    const a = await accountTag(env.TAG_SECRET, "account-a");
    expect(await accountTag(env.TAG_SECRET, "account-a")).toBe(a);
    expect(await accountTag(env.TAG_SECRET, "account-b")).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await isValidTag(env.TAG_SECRET, a)).toBe(true);
    const flipped = a.slice(0, 23) + (a[23] === "A" ? "B" : "A");
    expect(await isValidTag(env.TAG_SECRET, flipped)).toBe(false);
  });

  it("a made-up tag never reaches a Durable Object", async () => {
    const response = await worker("/AAAAAAAAAAAAAAAAAAAAAAAA/some-routine", { method: "POST", body: "x" });
    expect(response.status).toBe(404);
  });
});

describe("tickets", () => {
  it("open one connection for one computer, briefly", async () => {
    const t = Date.now();
    const { ticket, claims } = await mintTicket(env.TICKET_SECRET, { tag: await accountTag(env.TAG_SECRET, "x"), device: "laptop", now: t, ttlMs: 60_000 });
    expect(await readTicket(env.TICKET_SECRET, ticket, t + 1000)).toEqual(claims);
    expect(await readTicket(env.TICKET_SECRET, ticket, t + 61_000)).toBeNull();
    const parts = ticket.split(".");
    parts[1] = "desktop";
    expect(await readTicket(env.TICKET_SECRET, parts.join("."), t)).toBeNull();
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
    await evictDurableObject(env.FORWARDER.getByName(laptop.tag), { webSockets: "close" });
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
    const object = env.FORWARDER.getByName(laptop.tag);
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
