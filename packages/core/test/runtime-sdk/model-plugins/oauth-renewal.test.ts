// The renewal of a third party's oauth-pkce sign-in (oauth-renewal.ts), its rules one by one: what is kept and where,
// near-expiry and 401 renewal, one renewal at a time, a network failure changing nothing, a refused renewal or a
// changed token endpoint signing the plugin out with the reason, and sign-out dropping what was kept.
import { expect, test } from "bun:test";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { BACKOFF_MIN_MS, createOAuthRenewal, oauthEndedRef, oauthKeptRef, TOKEN_TIMEOUT_MS } from "../../../src/runtime-sdk/model-plugins/oauth-renewal";
import { TokenExchangeError, type ExchangeOptions } from "../../../src/providers/pkce";

const entry = (tokenUrl = "https://auth.acme.example/token") => ({ method: "oauth-pkce", authorizeUrl: "https://auth.acme.example/authorize", tokenUrl, clientId: "acme-client", secret: "oauth" });
function world(o: { tokenUrl?: string; store?: MemorySecretStore; capabilities?: string[]; real?: boolean; refresh?: (url: string, client: string, rt: string, x: ExchangeOptions) => Promise<{ accessToken: string; refreshToken: string | null; idToken: null; accountId: null; expiresAt: number }> } = {}) {
  let manifest = { name: "Acme", contributes: { models: [{ provider: "acme", auth: [entry(o.tokenUrl)] }] } };
  const store = o.store ?? new MemorySecretStore();
  let t = 1_000_000;
  const calls: string[] = [];
  const signedOut: string[] = [];
  let n = 0;
  const renewal = createOAuthRenewal({
    store, registry: { get: (id) => (id === "acme" ? ({ id, source: "local", manifest, capabilities: o.capabilities ?? [] } as never) : undefined) }, now: () => t,
    ...(o.real === true ? {} : { refresh: o.refresh ?? (async (url: string, client: string, rt: string) => { calls.push(`${url} ${client} ${rt}`); n += 1; return { accessToken: `acc-${n}`, refreshToken: `ref-${n}`, idToken: null, accountId: null, expiresAt: t + 3_600_000 }; }) }),
    onSignedOut: (id, _s, reason) => { signedOut.push(`${id}: ${reason}`); },
  });
  const own = { owner: { kind: "plugin" as const, pluginId: "acme" }, name: "oauth" };
  return { renewal, store, calls, signedOut, own, advance: (ms: number) => { t += ms; }, setManifest: (m: typeof manifest) => { manifest = m; }, now: () => t };
}

test("kept as a device item, never the plugin's own; a fresh token is used as it is; one near expiry is renewed first", async () => {
  const w = world();
  await w.store.set(w.own, "acc-0");
  await w.renewal.remember("acme", "oauth", { accessToken: "acc-0", refreshToken: "ref-0", idToken: null, accountId: null, expiresAt: w.now() + 3_600_000 });
  expect((await w.store.list({ kind: "plugin", pluginId: "acme" })).map((m) => m.ref.name)).toEqual(["oauth"]);
  expect(JSON.parse((await w.store.get(oauthKeptRef("acme", "oauth")))!.value.reveal())).toMatchObject({ refreshToken: "ref-0", tokenUrl: "https://auth.acme.example/token", clientId: "acme-client" });
  const src = w.renewal.tokens("acme", "oauth");
  expect((await src.current())?.value).toBe("acc-0");
  expect(w.calls).toEqual([]);
  w.advance(3_600_000 - 30_000);
  expect((await src.current())?.value).toBe("acc-1");
  expect(w.calls).toEqual(["https://auth.acme.example/token acme-client ref-0"]);
  // The rotated refresh token is the one used next.
  const g = (await src.current())!.generation;
  expect((await src.newer(g))?.value).toBe("acc-2");
  expect(w.calls[1]).toEndWith("ref-1");
});

test("renewals at once are one; a network failure changes nothing and signs nothing out", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let count = 0;
  const w = world({ refresh: async () => { count += 1; await gate; throw new TypeError("fetch failed"); } });
  await w.store.set(w.own, "acc-0");
  await w.renewal.remember("acme", "oauth", { accessToken: "acc-0", refreshToken: "ref-0", idToken: null, accountId: null, expiresAt: w.now() + 1000 });
  const both = Promise.all([w.renewal.renew("acme", "oauth"), w.renewal.renew("acme", "oauth")]);
  release();
  expect(await both).toEqual(["failed", "failed"]);
  expect(count).toBe(1);
  expect((await w.store.get(w.own))?.value.reveal()).toBe("acc-0");
  expect(w.signedOut).toEqual([]);
});

const dead = (status: number, error?: string) => async (): Promise<never> => { throw new TokenExchangeError(status, error, error === undefined ? "" : JSON.stringify({ error })); };
const signedIn = async (w: ReturnType<typeof world>) => {
  await w.store.set(w.own, "acc-0");
  await w.renewal.remember("acme", "oauth", { accessToken: "acc-0", refreshToken: "ref-0", idToken: null, accountId: null, expiresAt: w.now() + 1000 });
};

test("only an answer that means the refresh token is dead signs it out (400 invalid_grant, 401), with the reason; so does a token endpoint the manifest no longer names", async () => {
  for (const [status, error, said] of [[400, "invalid_grant", "400 invalid_grant"], [401, undefined, "401"]] as const) {
    const w = world({ refresh: dead(status, error) });
    await signedIn(w);
    expect(await w.renewal.renew("acme", "oauth")).toBe("refused");
    expect(await w.store.get(w.own)).toBeNull();
    expect(await w.store.get(oauthKeptRef("acme", "oauth"))).toBeNull();
    expect(await w.renewal.refusedReason("acme", "oauth")).toBe(`Your sign-in to Acme expired and couldn't be renewed (the service answered ${said}): sign in again.`);
    expect(w.signedOut).toHaveLength(1);
    // Nothing kept: nothing to renew with.
    expect(await w.renewal.renew("acme", "oauth")).toBe("none");
  }

  const v = world();
  await signedIn(v);
  v.setManifest({ name: "Acme", contributes: { models: [{ provider: "acme", auth: [entry("https://elsewhere.example/token")] }] } });
  expect(await v.renewal.renew("acme", "oauth")).toBe("refused");
  expect(v.calls).toEqual([]);
  expect(await v.renewal.refusedReason("acme", "oauth")).toContain("its sign-in changed since");
});

test("408, 429, 5xx and any other answer keep everything and try again later: after a failure the sign-in waits, doubling, so a loop on 401 can't hammer the endpoint", async () => {
  for (const [status, error] of [[408, undefined], [429, undefined], [500, undefined], [503, undefined], [400, "invalid_request"], [403, undefined]] as const) {
    let asked = 0;
    const w = world({ refresh: async () => { asked += 1; return dead(status, error)(); } });
    await signedIn(w);
    expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
    expect((await w.store.get(w.own))?.value.reveal()).toBe("acc-0");
    expect(await w.store.get(oauthKeptRef("acme", "oauth"))).not.toBeNull();
    expect(await w.renewal.refusedReason("acme", "oauth")).toBeUndefined();
    expect(w.signedOut).toEqual([]);
    // At once again (a plugin looping on 401): the endpoint isn't asked.
    for (let i = 0; i < 5; i++) expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
    expect(asked).toBe(1);
    w.advance(BACKOFF_MIN_MS);
    expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
    expect(asked).toBe(2);
    // The second wait is twice the first.
    w.advance(BACKOFF_MIN_MS);
    expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
    expect(asked).toBe(2);
    w.advance(BACKOFF_MIN_MS);
    expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
    expect(asked).toBe(3);
  }
  // A renewal that works after a failure ends the wait.
  let fail = true;
  let n = 0;
  const w = world({ refresh: async () => { if (fail) throw new TypeError("fetch failed"); n += 1; return { accessToken: `acc-${n}`, refreshToken: null, idToken: null, accountId: null, expiresAt: 9e15 }; } });
  await signedIn(w);
  expect(await w.renewal.renew("acme", "oauth")).toBe("failed");
  fail = false;
  w.advance(BACKOFF_MIN_MS);
  expect(await w.renewal.renew("acme", "oauth")).toBe("renewed");
  expect(await w.renewal.renew("acme", "oauth")).toBe("renewed");
});

test("the refresh goes with the plugin's pinned fetch, the 15 s timeout and no redirect", async () => {
  const seen: ExchangeOptions[] = [];
  const w = world({ refresh: async (_u, _c, _r, x) => { seen.push(x); return { accessToken: "acc-1", refreshToken: null, idToken: null, accountId: null, expiresAt: 9e15 }; } });
  await signedIn(w);
  expect(await w.renewal.renew("acme", "oauth")).toBe("renewed");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ timeoutMs: TOKEN_TIMEOUT_MS, noRedirect: true });
  expect(typeof seen[0]!.fetch).toBe("function");
  expect(TOKEN_TIMEOUT_MS).toBe(15_000);
});

test("the real refresh: a token endpoint on this computer is reached only when the plugin's OK names it with its port; a redirect is never followed; nothing is signed out for either", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
    hits += 1;
    if (new URL(req.url).pathname === "/moved") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/token" } });
    return Response.json({ access_token: "acc-real", refresh_token: "ref-real", expires_in: 3600 });
  } });
  try {
    const url = `http://127.0.0.1:${server.port}/token`;
    // Not named on its OK: refused before anything is sent.
    const off = world({ tokenUrl: url, real: true });
    await signedIn(off);
    expect(await off.renewal.renew("acme", "oauth")).toBe("failed");
    expect(hits).toBe(0);
    expect(off.signedOut).toEqual([]);
    // Named with its port: reached.
    const on = world({ tokenUrl: url, real: true, capabilities: [`network:127.0.0.1:${server.port}`] });
    await signedIn(on);
    expect(await on.renewal.renew("acme", "oauth")).toBe("renewed");
    expect((await on.store.get(on.own))?.value.reveal()).toBe("acc-real");
    expect(hits).toBe(1);
    // A redirect answer: not followed, kept, tried later.
    const moved = world({ tokenUrl: `http://127.0.0.1:${server.port}/moved`, real: true, capabilities: [`network:127.0.0.1:${server.port}`] });
    await signedIn(moved);
    expect(await moved.renewal.renew("acme", "oauth")).toBe("failed");
    expect(hits).toBe(2);
    expect((await moved.store.get(moved.own))?.value.reveal()).toBe("acc-0");
  } finally {
    void server.stop(true);
  }
});

test("the sign-out reason survives a restart, until the next sign-in or sign-out", async () => {
  const store = new MemorySecretStore();
  const w = world({ store, refresh: dead(401) });
  await signedIn(w);
  expect(await w.renewal.renew("acme", "oauth")).toBe("refused");
  expect((await store.get(oauthEndedRef("acme", "oauth")))?.value.reveal()).toContain("sign in again");
  // A new core over the same store (a restart).
  const after = world({ store });
  expect(await after.renewal.refusedReason("acme", "oauth")).toBe("Your sign-in to Acme expired and couldn't be renewed (the service answered 401): sign in again.");
  await after.renewal.remember("acme", "oauth", { accessToken: "a", refreshToken: "r", idToken: null, accountId: null, expiresAt: 9e15 });
  expect(await after.renewal.refusedReason("acme", "oauth")).toBeUndefined();
  expect(await world({ store }).renewal.refusedReason("acme", "oauth")).toBeUndefined();
  // Sign-out drops it too.
  await store.set(oauthEndedRef("acme", "oauth"), "ended", { synced: false });
  const again = world({ store });
  expect(await again.renewal.refusedReason("acme", "oauth")).toBe("ended");
  await again.renewal.forget("acme", "oauth");
  expect(await again.renewal.refusedReason("acme", "oauth")).toBeUndefined();
  expect(await store.get(oauthEndedRef("acme", "oauth"))).toBeNull();
});

test("a sign-in with no refresh token keeps nothing; sign-out drops what was kept and the reason", async () => {
  const w = world();
  await w.renewal.remember("acme", "oauth", { accessToken: "a", refreshToken: null, idToken: null, accountId: null, expiresAt: 0 });
  expect(await w.store.get(oauthKeptRef("acme", "oauth"))).toBeNull();
  await w.renewal.remember("acme", "oauth", { accessToken: "a", refreshToken: "r", idToken: null, accountId: null, expiresAt: 0 });
  await w.renewal.forget("acme", "oauth");
  expect(await w.store.get(oauthKeptRef("acme", "oauth"))).toBeNull();
  expect(w.renewal.handles("acme", "oauth")).toBe(true);
  expect(w.renewal.handles("acme", "api-key")).toBe(false);
});
