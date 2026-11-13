// The renewal of a third party's oauth-pkce sign-in (oauth-renewal.ts), its rules one by one: what is kept and where,
// near-expiry and 401 renewal, one renewal at a time, a network failure changing nothing, a refused renewal or a
// changed token endpoint signing the plugin out with the reason, and sign-out dropping what was kept.
import { expect, test } from "bun:test";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { createOAuthRenewal, oauthKeptRef } from "../../../src/runtime-sdk/model-plugins/oauth-renewal";

const entry = (tokenUrl = "https://auth.acme.example/token") => ({ method: "oauth-pkce", authorizeUrl: "https://auth.acme.example/authorize", tokenUrl, clientId: "acme-client", secret: "oauth" });
function world(o: { tokenUrl?: string; refresh?: (url: string, client: string, rt: string) => Promise<{ accessToken: string; refreshToken: string | null; idToken: null; accountId: null; expiresAt: number }> } = {}) {
  let manifest = { name: "Acme", contributes: { models: [{ provider: "acme", auth: [entry(o.tokenUrl)] }] } };
  const store = new MemorySecretStore();
  let t = 1_000_000;
  const calls: string[] = [];
  const signedOut: string[] = [];
  let n = 0;
  const renewal = createOAuthRenewal({
    store, registry: { get: (id) => (id === "acme" ? ({ id, source: "local", manifest } as never) : undefined) }, now: () => t,
    refresh: o.refresh ?? (async (url, client, rt) => { calls.push(`${url} ${client} ${rt}`); n += 1; return { accessToken: `acc-${n}`, refreshToken: `ref-${n}`, idToken: null, accountId: null, expiresAt: t + 3_600_000 }; }),
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

test("a refused renewal (a 4xx) signs it out with the reason; so does a token endpoint the manifest no longer names", async () => {
  const w = world({ refresh: async () => { throw new Error("token exchange failed: HTTP 400 — {\"error\":\"invalid_grant\"}"); } });
  await w.store.set(w.own, "acc-0");
  await w.renewal.remember("acme", "oauth", { accessToken: "acc-0", refreshToken: "ref-0", idToken: null, accountId: null, expiresAt: w.now() + 1000 });
  expect(await w.renewal.renew("acme", "oauth")).toBe("refused");
  expect(await w.store.get(w.own)).toBeNull();
  expect(await w.store.get(oauthKeptRef("acme", "oauth"))).toBeNull();
  expect(w.renewal.refusedReason("acme", "oauth")).toBe("Your sign-in to Acme expired and couldn't be renewed (the service answered 400): sign in again.");
  expect(w.signedOut).toHaveLength(1);
  // Nothing kept: nothing to renew with.
  expect(await w.renewal.renew("acme", "oauth")).toBe("none");

  const v = world();
  await v.store.set(v.own, "acc-0");
  await v.renewal.remember("acme", "oauth", { accessToken: "acc-0", refreshToken: "ref-0", idToken: null, accountId: null, expiresAt: v.now() + 1000 });
  v.setManifest({ name: "Acme", contributes: { models: [{ provider: "acme", auth: [entry("https://elsewhere.example/token")] }] } });
  expect(await v.renewal.renew("acme", "oauth")).toBe("refused");
  expect(v.calls).toEqual([]);
  expect(v.renewal.refusedReason("acme", "oauth")).toContain("its sign-in changed since");
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
