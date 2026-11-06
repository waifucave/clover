import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { clearJwksCache, verifyAccountTokenFrom } from "../../shared/jwks";
import { CLOSE, HandshakeError } from "../client";
import type { HandshakeDO } from "../src/handshake-do";
import { accountToken, box, client, rawSocket } from "./helpers";

let accounts = 0;
const uniqueAccount = () => `acct-${Date.now()}-${++accounts}`;

async function refusal(promise: Promise<unknown>): Promise<HandshakeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandshakeError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

function device(account: string, id: string) {
  return client().account(() => accountToken({ account, device: id }));
}

describe("the account channel", () => {
  test("a token is required, for this service's audience", async () => {
    const account = uniqueAccount();
    const noToken = await refusal(client().account(async () => "nope").get());
    expect(noToken.status).toBe(401);
    const otherAud = client().account(() => accountToken({ account, device: "d1", aud: "hooks.waifucave.com" }));
    expect((await refusal(otherAud.get())).status).toBe(401);
    expect(await device(account, "d1").get()).toEqual({ online: [], records: [], lease: { holder: null, epoch: 0, expiresAt: 0 } });
  });

  test("records and messages are addressed to one device, and only it reads them", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    const laptop = device(account, "laptop");
    const phone = device(account, "phone");
    const sealed = box();
    await studio.putRecord("addr", "laptop", { gen: 10, box: sealed });
    expect((await laptop.get()).records).toEqual([expect.objectContaining({ from: "studio", kind: "addr", gen: 10, box: sealed })]);
    expect((await phone.get()).records).toEqual([]);
    expect((await refusal(studio.putRecord("addr", "laptop", { gen: 9, box: box() }))).code).toBe("stale");

    const sent = await laptop.sendMessage("studio", "dial", { box: box() });
    expect(sent.delivered).toBe(false);
    expect((await phone.inbox()).length).toBe(0);
    expect((await studio.inbox()).map((m) => m.id)).toEqual([sent.id]);
    expect((await refusal(studio.sendMessage("studio", "dial", { box: box() }))).status).toBe(400);
  });

  test("the lease works as in a group, with device ids as holders", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    const laptop = device(account, "laptop");
    expect(await studio.lease("acquire")).toMatchObject({ holder: "studio", epoch: 1 });
    expect((await refusal(laptop.lease("acquire"))).code).toBe("held");
    expect(await laptop.lease("takeover")).toMatchObject({ holder: "laptop", epoch: 2 });
  });

  test("a revoked device is refused, loses its records, messages, lease and socket", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    const old = device(account, "old");
    await old.putRecord("addr", "studio", { gen: 1, box: box() });
    await old.lease("acquire");
    const s = await rawSocket((await old.ticket()).url);
    expect(await s.frames.until((f) => f.t === "hello")).toMatchObject({ scope: "account", online: [] });

    const watcher = await rawSocket((await studio.ticket()).url);
    expect(await watcher.frames.until((f) => f.t === "hello")).toMatchObject({ online: ["old"] });
    await studio.revokeDevice("old");
    expect(await s.frames.closed()).toBe(CLOSE.ended);
    await watcher.frames.until((f) => f.t === "presence" && f.device === "old" && f.online === false);
    await watcher.frames.until((f) => f.t === "lease" && f.lease.holder === null);
    expect((await studio.get()).records).toEqual([]);
    expect((await refusal(old.get())).code).toBe("revoked");
    expect((await refusal(studio.sendMessage("old", "dial", { box: box() }))).code).toBe("revoked");
  });

  test("an account socket ends with the token it was opened with", async () => {
    const account = uniqueAccount();
    const exp = Math.floor(Date.now() / 1000) + 120;
    const studio = client().account(() => accountToken({ account, device: "studio", exp }));
    const s = await rawSocket((await studio.ticket()).url);
    await s.frames.until((f) => f.t === "hello");
    const stub = env.HANDSHAKE.getByName(`account:${account}`);
    const until = await runInDurableObject(stub, async (_o: HandshakeDO, state) => (state.getWebSockets()[0]!.deserializeAttachment() as { until: number }).until);
    expect(until).toBe(exp * 1000);
    // Past the token's end, the next write to the socket closes it instead.
    await runInDurableObject(stub, async (_o: HandshakeDO, state) => {
      const ws = state.getWebSockets()[0]!;
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), until: Date.now() - 1 });
    });
    await device(account, "laptop").putRecord("addr", "studio", { gen: 1, box: box() });
    expect(await s.frames.closed()).toBe(CLOSE.reauth);
  });

  test("presence frames name the device", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    const watcher = await rawSocket((await studio.ticket()).url);
    await watcher.frames.until((f) => f.t === "hello");
    const laptop = await rawSocket((await device(account, "laptop").ticket()).url);
    await laptop.frames.until((f) => f.t === "hello");
    await watcher.frames.until((f) => f.t === "presence" && f.device === "laptop" && f.online);
    expect((await studio.get()).online).toEqual(["laptop"]);
  });
});

describe("the account service's keys by URL", () => {
  const base = { ACCOUNT_ISSUER: "https://accounts.test", ACCOUNT_JWKS_URL: "https://accounts.test/.well-known/jwks.json" };

  test("fetched once and cached; a key added later is picked up on its first token", async () => {
    clearJwksCache();
    let fetches = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches++;
      return fetch(input, init);
    }) as typeof fetch;
    const t1 = await accountToken({ account: "a", device: "d", key: "es256" });
    expect(await verifyAccountTokenFrom(t1, base, "handshake.waifucave.com", fetcher)).toMatchObject({ account: "a", device: "d" });
    expect(await verifyAccountTokenFrom(t1, base, "handshake.waifucave.com", fetcher)).not.toBeNull();
    expect(fetches).toBe(1);
    // The served set has the rotated key already, so its token checks out from the cache.
    const t2 = await accountToken({ account: "a", device: "d", key: "rotated" });
    expect(await verifyAccountTokenFrom(t2, base, "handshake.waifucave.com", fetcher)).not.toBeNull();
    expect(fetches).toBe(1);
  });

  test("an unknown kid makes one early fetch at most a minute; an http URL off this machine is never fetched", async () => {
    clearJwksCache();
    let fetches = 0;
    const served = { keys: [] as unknown[] };
    const fetcher = (async () => {
      fetches++;
      return new Response(JSON.stringify(served.keys.length ? served : { keys: [{ kid: "other", kty: "OKP", crv: "Ed25519", x: "AAAA" }] }));
    }) as unknown as typeof fetch;
    const token = await accountToken({ account: "a", device: "d", key: "rotated" });
    expect(await verifyAccountTokenFrom(token, base, "handshake.waifucave.com", fetcher)).toBeNull();
    expect(await verifyAccountTokenFrom(token, base, "handshake.waifucave.com", fetcher)).toBeNull();
    expect(fetches).toBe(1);

    let plain = 0;
    const counting = (async () => {
      plain++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const insecure = { ACCOUNT_ISSUER: "https://accounts.test", ACCOUNT_JWKS_URL: "http://accounts.test/jwks.json" };
    expect(await verifyAccountTokenFrom(token, insecure, "handshake.waifucave.com", counting)).toBeNull();
    expect(plain).toBe(0);
  });

  test("go through the account service's binding first, with the URL as the fallback", async () => {
    const token = await accountToken({ account: "a", device: "d", key: "es256" });
    const asked: string[] = [];
    let plain = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      plain++;
      return fetch(input, init);
    }) as typeof fetch;
    // The binding answers for the URL's path; the URL itself (on the same zone in production) is never fetched.
    clearJwksCache();
    const binding = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        asked.push(new URL(String(input)).pathname);
        return fetch("https://accounts.test/.well-known/jwks.json", init);
      },
    };
    expect(await verifyAccountTokenFrom(token, { ...base, ACCOUNT_SERVICE: binding }, "handshake.waifucave.com", fetcher)).toMatchObject({ account: "a" });
    expect([asked, plain]).toEqual([["/.well-known/jwks.json"], 0]);
    // A binding that fails falls back to the URL.
    clearJwksCache();
    const broken = { fetch: async () => new Response("no", { status: 503 }) };
    expect(await verifyAccountTokenFrom(token, { ...base, ACCOUNT_SERVICE: broken }, "handshake.waifucave.com", fetcher)).toMatchObject({ account: "a" });
    expect(plain).toBe(1);
  });

  test("refuse a token that lives longer than the account service mints, plus skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    const config = { ACCOUNT_ISSUER: env.ACCOUNT_ISSUER, ACCOUNT_JWKS: env.ACCOUNT_JWKS };
    expect(await verifyAccountTokenFrom(await accountToken({ account: "a", device: "d", exp: now + 360 }), config, "handshake.waifucave.com")).not.toBeNull();
    expect(await verifyAccountTokenFrom(await accountToken({ account: "a", device: "d", exp: now + 361 }), config, "handshake.waifucave.com")).toBeNull();
  });
});
