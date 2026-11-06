// The waifucave account against a local sign-in stack (lane M's GoTrue stub) and a stand-in account service: sign-in
// by password and by PKCE through the loopback, refresh, minted tokens that lane I's verifier accepts, the account's
// devices, and revocation's fan-out to the services that keep per-device state.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAccountToken } from "../../../../../services/shared/account-token";
import { startSignInStub } from "../../../../test-harness/src/signin-stub";
import { isContractError } from "../../contracts/common";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { Secret } from "../../contracts/secret-store";
import { revokeDevice, syncAccountDevices } from "../../devices/account-devices";
import { FileDeviceRegistry } from "../../devices/registry";
import { ACCOUNT_SESSION_REF, AccountClient } from "../account";
import { startFakeAccountService } from "../account-fake";
import { BoxKey, sealToBoxKey } from "../box-key";
import { DeviceKey } from "../device-key";
import { utf8 } from "../bytes";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops = [];
});

const clock = { now: () => Date.now() };

function stack() {
  const auth = startSignInStub();
  stops.push(() => auth.stop());
  const service = startFakeAccountService({ authUrl: auth.url, anonKey: auth.anonKey });
  stops.push(() => service.stop());
  auth.addUser({ email: "someone@example.invalid", password: "correct horse" });
  return { auth, service };
}

async function device(s: ReturnType<typeof stack>, name: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const boxKey = await BoxKey.loadOrCreate(store);
  const home = mkdtempSync(join(tmpdir(), "clover-h-account-"));
  const registry = await FileDeviceRegistry.open({ home, key, clock, self: { name, os: "macos" } });
  const account = new AccountClient({ config: { authUrl: s.auth.url, anonKey: s.auth.anonKey, serviceUrl: s.service.url }, store, device: key, clock });
  stops.push(() => account.close());
  return { name, store, key, boxKey, registry, account, home };
}

describe("the account service's statements, byte for byte with lane I's", () => {
  test("mint names the account, as services/accounts' own test vector has it", async () => {
    const { mintStatement } = await import("../account");
    expect(new TextDecoder().decode(mintStatement("acct", "push.waifucave.com", "dev", 1793000000123))).toBe("clover-account-v1 mint\nacct\npush.waifucave.com\ndev\n1793000000123");
  });
});

describe("account", () => {
  test("password sign-in keeps the session as a device item, never in the registry's file", async () => {
    const s = stack();
    const d = await device(s, "Studio");
    expect(await d.account.status()).toEqual({ signedIn: false });
    const view = await d.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    expect(view).toMatchObject({ signedIn: true, provider: "email", user: { email: "someone@example.invalid" } });
    const meta = (await d.store.list()).find((m) => m.ref.name === ACCOUNT_SESSION_REF.name)!;
    expect(meta.synced).toBe(false);
    const session = JSON.parse((await d.store.get(ACCOUNT_SESSION_REF))!.value.reveal()) as { refreshToken: string };
    expect(readFileSync(join(d.home, "devices", "registry.json"), "utf8")).not.toContain(session.refreshToken);
    expect(isContractError(await d.account.signInWithPassword("someone@example.invalid", new Secret("wrong")).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("PKCE sign-in through the loopback redirect", async () => {
    const s = stack();
    const d = await device(s, "Studio");
    const { url, done } = await d.account.startSignIn("discord");
    expect(url).toContain("code_challenge_method=s256");
    expect(url).not.toContain("code_verifier");
    const consent = await fetch(url, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const back = await fetch(consent.headers.get("location")!);
    expect(back.status).toBe(200);
    expect(await done).toMatchObject({ signedIn: true, provider: "discord" });
  });

  test("an expired access token is refreshed once, even when two callers ask at the same time", async () => {
    const s = stack();
    const d = await device(s, "Studio");
    await d.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    const first = await d.account.accessToken();
    s.auth.advanceClock(3600);
    // The stub's clock moved, not ours: make the stored session look expired too.
    const stored = JSON.parse((await d.store.get(ACCOUNT_SESSION_REF))!.value.reveal()) as Record<string, unknown>;
    await d.store.set(ACCOUNT_SESSION_REF, new Secret(JSON.stringify({ ...stored, expiresAt: Date.now() - 1 })), { synced: false });
    const other = new AccountClient({ config: { authUrl: s.auth.url, anonKey: s.auth.anonKey, serviceUrl: s.service.url }, store: d.store, device: d.key, clock });
    // Two refreshes with one refresh token would end the session at the stub (a reused token); one refresh doesn't.
    const [a, b] = await Promise.all([other.accessToken(), other.accessToken()]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(await other.status()).toMatchObject({ signedIn: true });
  });

  test("minted tokens: one per audience, at most 5 minutes, accepted by lane I's verifier for that audience only", async () => {
    const s = stack();
    const d = await device(s, "Studio");
    await d.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    await d.account.registerDevice({ name: "Studio", kind: "desktop", os: "macos", boxKey: d.boxKey.publicKeyBase64Url });
    const token = await d.account.tokens.current("push.waifucave.com");
    expect(token).not.toBeNull();
    expect(String(token!.value)).toBe("[secret]");
    const id = await verifyAccountToken(token!.value.reveal(), { jwks: s.service.jwks, issuer: s.service.issuer, audience: "push.waifucave.com" });
    expect(id).toMatchObject({ account: (await d.account.accountId())!, device: d.key.id });
    expect(await verifyAccountToken(token!.value.reveal(), { jwks: s.service.jwks, issuer: s.service.issuer, audience: "hooks.waifucave.com" })).toBeNull();
    const claims = JSON.parse(Buffer.from(token!.value.reveal().split(".")[1]!, "base64url").toString()) as { iat: number; exp: number; jti: string };
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(typeof claims.jti).toBe("string");
    // Cached per audience.
    expect((await d.account.tokens.current("push.waifucave.com"))!.generation).toBe(token!.generation);
    expect(s.service.mints.filter((m) => m.aud === "push.waifucave.com")).toHaveLength(1);
  });

  test("two devices on one account take each other from its list, with their box keys", async () => {
    const s = stack();
    const a = await device(s, "Studio");
    const b = await device(s, "Laptop 2");
    for (const d of [a, b]) await d.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    await syncAccountDevices({ registry: a.registry, account: a.account, device: a.key, boxKey: a.boxKey });
    expect((await syncAccountDevices({ registry: b.registry, account: b.account, device: b.key, boxKey: b.boxKey })).added).toEqual([a.key.id]);
    expect((await syncAccountDevices({ registry: a.registry, account: a.account, device: a.key, boxKey: a.boxKey })).added).toEqual([b.key.id]);
    expect(a.registry.get(b.key.id)?.addedBy).toBe("account");
    // Its tree name is one lane J takes, made from its name (S4), never the raw name.
    expect(a.registry.get(b.key.id)?.computer).toBe("Laptop-2");
    // A's box key, as B holds it, opens what is sealed to it.
    const sealed = sealToBoxKey(Buffer.from(b.registry.boxKey(a.key.id)!, "base64url"), utf8("aad"), utf8("hello"));
    expect(new TextDecoder().decode(a.boxKey.open(sealed, utf8("aad"))!)).toBe("hello");
    expect(a.boxKey.open(sealed, utf8("other aad"))).toBeUndefined();
  });

  test("revoking an account device: here at once, then the account, hooks, push and the handshake", async () => {
    const s = stack();
    const a = await device(s, "Studio");
    const b = await device(s, "Laptop");
    for (const d of [a, b]) await d.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    await syncAccountDevices({ registry: a.registry, account: a.account, device: a.key, boxKey: a.boxKey });
    await syncAccountDevices({ registry: b.registry, account: b.account, device: b.key, boxKey: b.boxKey });
    await syncAccountDevices({ registry: a.registry, account: a.account, device: a.key, boxKey: a.boxKey });
    const seen: string[] = [];
    const services = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const audience = url.pathname.startsWith("/hooks") ? "hooks.waifucave.com" : url.pathname.startsWith("/push") ? "push.waifucave.com" : "handshake.waifucave.com";
        const token = (req.headers.get("authorization") ?? "").slice("Bearer ".length);
        const who = await verifyAccountToken(token, { jwks: s.service.jwks, issuer: s.service.issuer, audience });
        if (!who) return new Response(null, { status: 401 });
        seen.push(`${req.method} ${url.pathname} by ${who.device === a.key.id ? "a" : "?"}`);
        return new Response(null, { status: 204 });
      },
    });
    stops.push(() => services.stop(true));
    const base = `http://127.0.0.1:${services.port}`;
    const out = await revokeDevice({
      registry: a.registry, store: a.store, account: a.account,
      services: { hooks: { url: `${base}/hooks`, audience: "hooks.waifucave.com" }, push: { url: `${base}/push`, audience: "push.waifucave.com" }, handshake: { url: `${base}/hs`, audience: "handshake.waifucave.com" } },
    }, b.key.id, "lost");
    expect(out.steps.every((x) => x.ok)).toBe(true);
    expect(a.registry.get(b.key.id)?.revokedAt).toBeDefined();
    expect(seen.sort()).toEqual([
      `DELETE /hooks/v1/devices/${b.key.id} by a`,
      `DELETE /hs/v1/accounts/self/devices/${b.key.id} by a`,
      `DELETE /push/v1/devices/${b.key.id} by a`,
    ]);
    // The account refuses the revoked device's mints, and a sync on B can't bring it back on A.
    expect(await b.account.mint("push.waifucave.com").catch((e: unknown) => e)).toBeInstanceOf(Error);
    expect((await syncAccountDevices({ registry: a.registry, account: a.account, device: a.key, boxKey: a.boxKey })).added).toEqual([]);
  });
});
