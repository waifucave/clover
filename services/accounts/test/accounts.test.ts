// The account service on lane H's wire (PROTOCOL.md): a Supabase session, the account's devices registered by their
// link keys, revocation, and account tokens the other services accept.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { fromB64u } from "../../shared/encoding";
import { clearJwksCache, verifyAccountTokenFrom } from "../../shared/jwks";
import { StepLimiter } from "../../shared/testing/step-limiter";
import type { AccountDO } from "../src/account-do";
import { LIMITS, mintStatement, registerStatement } from "../src/wire";
import {
  AUDIENCE,
  call,
  freshAddress,
  jwksFetcher,
  mintFor,
  newDevice,
  ORIGIN,
  register,
  registration,
  setAuthDown,
  signIn,
  signOut,
  userCalls,
  type Via,
  withEnv,
  worker,
} from "./helpers";

const listOf = async (session: Awaited<ReturnType<typeof signIn>>, via?: Via) =>
  ((await (await call("GET", "/v1/devices", { session, ...(via ? { via } : {}) })).json()) as { devices: Record<string, unknown>[] }).devices;

async function identityOf(token: string, audience: string, via: Via = worker) {
  clearJwksCache();
  return verifyAccountTokenFrom(token, { ACCOUNT_ISSUER: env.ISSUER, ACCOUNT_JWKS_URL: `${ORIGIN}/.well-known/jwks.json` }, audience, jwksFetcher(via));
}

function claimsOf(token: string): Record<string, unknown> {
  const [header, claims] = token.split(".") as [string, string];
  return { header: JSON.parse(new TextDecoder().decode(fromB64u(header))), ...JSON.parse(new TextDecoder().decode(fromB64u(claims))) };
}

describe("signing in", () => {
  test("every call needs a session the Supabase project accepts", async () => {
    expect((await call("GET", "/v1/devices")).status).toBe(401);
    expect((await call("GET", "/v1/devices", { session: "not-a-session" })).status).toBe(401);
    const session = await signIn();
    expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    await signOut(session);
    expect((await call("GET", "/v1/devices", { session })).status).toBe(401);
    // An anonymous Supabase sign-in isn't a waifucave account.
    expect((await call("GET", "/v1/devices", { session: await signIn(undefined, { anonymous: true }) })).status).toBe(401);
  });

  test("when the project can't answer, the service says so instead of signing anyone out", async () => {
    const session = await signIn();
    await setAuthDown(true);
    try {
      const down = await call("GET", "/v1/devices", { session });
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ error: "auth_unavailable" });
      expect(down.headers.get("retry-after")).toBe("30");
    } finally {
      await setAuthDown(false);
    }
    expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    // No project configured is the same answer, never a pass.
    expect((await call("GET", "/v1/devices", { session, via: withEnv({ AUTH_URL: "" }) })).status).toBe(503);
    expect((await call("GET", "/v1/devices", { session, via: withEnv({ AUTH_URL: "http://auth.example" }) })).status).toBe(503);
  });

  // On StepLimiters in place of the runtime's bindings: no wall-clock minutes.
  test("a stranger is limited per address before the project is asked", async () => {
    const via = withEnv({ ADDRESS_RATE: new StepLimiter(2) });
    const from = freshAddress();
    const before = await userCalls();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await call("GET", "/v1/devices", { session: `guess-${i}`, address: from, via })).status);
    expect(statuses).toEqual([401, 401, 429]);
    expect(await userCalls()).toBe(before + 2);
  });

  test("an account is limited across its devices and addresses", async () => {
    const via = withEnv({ API_RATE: new StepLimiter(2) });
    const session = await signIn();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await call("GET", "/v1/devices", { session, via })).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect((await call("GET", "/v1/devices", { session: await signIn(), via })).status).toBe(200);
  });
});

describe("devices", () => {
  test("a device registers with its link key's signature, and the account lists it", async () => {
    const session = await signIn();
    const device = await newDevice();
    const before = Date.now();
    const created = await register(session, device, { name: "Studio", kind: "desktop", os: "macos" });
    expect(created.status).toBe(201);
    const { device: record } = (await created.json()) as { device: Record<string, unknown> };
    expect(record).toEqual({ id: device.id, publicKey: device.publicKey, boxKey: device.boxKey, name: "Studio", kind: "desktop", os: "macos", addedAt: expect.any(Number) });
    expect(record.addedAt as number).toBeGreaterThanOrEqual(before);
    expect(await listOf(session)).toEqual([record]);
  });

  test("a newer statement updates the device; one no newer than its last is a replay", async () => {
    const session = await signIn();
    const device = await newDevice();
    const t = Date.now();
    await register(session, device, { t });
    const first = (await listOf(session))[0]!;
    const renamed = await register(session, device, { t: t + 1, name: "Studio 2", kind: "server", os: "linux" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as unknown).toEqual({ device: { ...first, name: "Studio 2", kind: "server", os: "linux" } });
    for (const old of [t + 1, t]) {
      const replay = await register(session, device, { t: old, name: "Old" });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ error: "replay" });
    }
    expect((await listOf(session))[0]!.name).toBe("Studio 2");
  });

  test("refuses an id that isn't the key's, a signature that isn't the key's, a stale statement, and bad fields", async () => {
    const session = await signIn();
    const device = await newDevice();
    const other = await newDevice();
    const refused = async (body: Record<string, unknown>) => {
      const response = await call("POST", "/v1/devices", { session, body });
      return [response.status, ((await response.json()) as { error: string }).error];
    };
    const good = await registration(session, device);
    const withDevice = (patch: Record<string, unknown>) => ({ ...good, device: { ...(good.device as object), ...patch } });

    expect(await refused(withDevice({ id: other.id }))).toEqual([400, "bad_device_id"]);
    expect(await refused(await registration(session, device, { signer: other }))).toEqual([403, "bad_signature"]);
    // A statement for another account doesn't register here.
    expect(await refused(await registration(session, device, { account: "someone-else" }))).toEqual([403, "bad_signature"]);
    // The signature covers the record: the same one with another box key, name, kind or system is refused.
    const otherBox = (await newDevice()).boxKey;
    for (const patch of [{ boxKey: otherBox }, { name: "not studio" }, { kind: "server" }, { os: "linux" }]) {
      expect(await refused(withDevice(patch))).toEqual([403, "bad_signature"]);
    }
    const stale = Date.now() - LIMITS.statementWindowMs - 1000;
    expect(await refused(await registration(session, device, { t: stale }))).toEqual([400, "bad_time"]);
    expect(await refused({ ...good, t: 1.5 })).toEqual([400, "bad_time"]);
    expect(await refused({ ...good, sig: "short" })).toEqual([400, "bad_request"]);
    for (const patch of [
      { kind: "toaster" },
      { os: "beos" },
      { name: "" },
      { name: "   " },
      { name: "line\nbreak" },
      { name: "x".repeat(LIMITS.maxName + 1) },
      { boxKey: "AAAA" },
      { boxKey: device.boxKey + "A" },
      { publicKey: "AAAA" },
      { id: "Not-An-Id" },
    ]) {
      expect(await refused(withDevice(patch))).toEqual([400, expect.stringMatching(/^bad_/)]);
    }
    expect((await call("POST", "/v1/devices", { session, body: "not json" })).status).toBe(400);
    expect(await listOf(session)).toEqual([]);

    // Names count code points: 64 emoji fit. A base64url link key is taken and kept as standard base64.
    const urlKey = btoa(String.fromCharCode(...device.rawPublicKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const record = { ...(good.device as Record<string, string>), publicKey: urlKey, name: "🍀".repeat(64) };
    const signedT = Date.now();
    const body = { device: record, t: signedT, sig: await device.sign(registerStatement(session.account, record as unknown as Parameters<typeof registerStatement>[1], signedT)) };
    const created = await call("POST", "/v1/devices", { session, body });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { device: { publicKey: string } }).device.publicKey).toBe(device.publicKey);
  });

  test("an account's devices are its own", async () => {
    const a = await signIn();
    const b = await signIn();
    const device = await newDevice();
    await register(a, device);
    expect(await listOf(b)).toEqual([]);
    expect((await call("DELETE", `/v1/devices/${device.id}`, { session: b })).status).toBe(404);
    expect((await mintFor(b, device)).status).toBe(403);
    expect((await listOf(a))[0]!.revokedAt).toBeUndefined();
  });

  test("a revoked device stays listed, can't register again and gets no tokens", async () => {
    const session = await signIn();
    const device = await newDevice();
    const kept = await newDevice();
    await register(session, device);
    await register(session, kept, { name: "phone", kind: "phone", os: "" });
    expect((await mintFor(session, device)).status).toBe(200);
    const before = Date.now();
    expect((await call("DELETE", `/v1/devices/${device.id}`, { session })).status).toBe(204);
    const listed = await listOf(session);
    expect(listed.map((d) => d.id).sort()).toEqual([device.id, kept.id].sort());
    const revoked = listed.find((d) => d.id === device.id)!;
    expect(revoked.revokedAt as number).toBeGreaterThanOrEqual(before);
    expect(listed.find((d) => d.id === kept.id)!.revokedAt).toBeUndefined();
    // Again changes nothing; an unknown device is 404, and a malformed id isn't a route.
    expect((await call("DELETE", `/v1/devices/${device.id}`, { session })).status).toBe(204);
    expect((await listOf(session)).find((d) => d.id === device.id)!.revokedAt).toBe(revoked.revokedAt);
    expect((await call("DELETE", `/v1/devices/${(await newDevice()).id}`, { session })).status).toBe(404);
    expect((await call("DELETE", "/v1/devices/NOT_AN_ID", { session })).status).toBe(404);

    const again = await register(session, device);
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ error: "revoked" });
    const minted = await mintFor(session, device);
    expect(minted.status).toBe(403);
    expect(await minted.json()).toEqual({ error: "not_member" });
    expect((await mintFor(session, kept)).status).toBe(200);
  });

  test("an account holds 64 devices that aren't revoked, and forgets the longest-revoked to make room", async () => {
    const session = await signIn();
    const devices = [];
    for (let i = 0; i < LIMITS.maxDevices; i++) {
      const d = await newDevice();
      expect((await register(session, d, { name: `d${i}` })).status).toBe(201);
      devices.push(d);
    }
    const extra = await newDevice();
    const full = await register(session, extra);
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "full" });
    expect((await call("DELETE", `/v1/devices/${devices[0]!.id}`, { session })).status).toBe(204);
    expect((await register(session, extra)).status).toBe(201);

    // At the row cap, the longest-revoked row goes first: fill the account with old revoked rows, then add one more.
    const fillers = await runInDurableObject(env.ACCOUNTS.getByName(session.account), async (_o: AccountDO, state) => {
      const rows = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n;
      const ids: string[] = [];
      for (let i = rows; i < LIMITS.maxRows; i++) {
        const id = `filler${String(i).padStart(26, "a")}`;
        ids.push(id);
        state.storage.sql.exec(
          "INSERT INTO devices (id, public_key, box_key, name, kind, os, added_at, revoked_at, last_t) VALUES (?, 'k', 'b', 'old', 'desktop', NULL, 1, ?, 1)",
          id,
          1000 + i,
        );
      }
      return ids;
    });
    expect((await call("DELETE", `/v1/devices/${devices[1]!.id}`, { session })).status).toBe(204);
    const fresh = await newDevice();
    expect((await register(session, fresh)).status).toBe(201);
    const listed = (await listOf(session)).map((d) => d.id);
    expect(listed).toHaveLength(LIMITS.maxRows);
    expect(listed).toContain(fresh.id);
    expect(listed).not.toContain(fillers[0]);
    expect(listed).toEqual(expect.arrayContaining([...fillers.slice(1), devices[0]!.id, devices[1]!.id]));
  });
});

describe("tokens", () => {
  test("a device mints a token for one service, which that service's check accepts and no other's", async () => {
    const session = await signIn();
    const device = await newDevice();
    await register(session, device);
    const before = Date.now();
    const minted = await mintFor(session, device, { aud: AUDIENCE });
    expect(minted.status).toBe(200);
    const { token, expiresAt } = (await minted.json()) as { token: string; expiresAt: number };
    expect(expiresAt).toBeLessThanOrEqual(before + 300_000 + 1000);
    expect(expiresAt).toBeGreaterThan(before + 290_000);
    expect(await identityOf(token, AUDIENCE)).toEqual({ account: session.account, device: device.id, expiresAt: expiresAt / 1000 });
    expect(await identityOf(token, "push.waifucave.com")).toBeNull();
    const claims = claimsOf(token);
    expect(claims).toMatchObject({ header: { alg: "EdDSA", kid: "test-ed25519", typ: "JWT" }, iss: env.ISSUER, aud: AUDIENCE, sub: session.account, dev: device.id });
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(typeof claims.jti).toBe("string");
  });

  test("a mint's statement counts once per audience, from a listed device's key", async () => {
    const session = await signIn();
    const device = await newDevice();
    await register(session, device);
    const t = Date.now();
    expect((await mintFor(session, device, { t })).status).toBe(200);
    const replay = await mintFor(session, device, { t });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "replay" });
    expect((await mintFor(session, device, { t: t - 1 })).status).toBe(409);
    expect((await mintFor(session, device, { t, aud: "push.waifucave.com" })).status).toBe(200);
    expect((await mintFor(session, device, { t: t + 1 })).status).toBe(200);

    const forged = await mintFor(session, device, { t: t + 2, signer: await newDevice() });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: "bad_signature" });
    // The forged one spent nothing: t + 2 still works.
    expect((await mintFor(session, device, { t: t + 2 })).status).toBe(200);

    // A statement for another account doesn't mint here.
    const elsewhere = await mintFor(session, device, { t: t + 3, account: "someone-else" });
    expect([elsewhere.status, await elsewhere.json()]).toEqual([403, { error: "bad_signature" }]);
    const stranger = await mintFor(session, await newDevice());
    expect([stranger.status, await stranger.json()]).toEqual([403, { error: "not_member" }]);
    const unknown = await mintFor(session, device, { aud: "elsewhere.example" });
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: "bad_audience" }]);
    const stale = await mintFor(session, device, { t: Date.now() - LIMITS.statementWindowMs - 1000 });
    expect([stale.status, await stale.json()]).toEqual([400, { error: "bad_time" }]);
  });

  test("TOKEN_TTL shortens tokens, never past 300 s", async () => {
    const session = await signIn();
    const device = await newDevice();
    await register(session, device);
    const lifetime = async (ttl: string) => {
      const { token } = (await (await mintFor(session, device, { via: withEnv({ TOKEN_TTL: ttl }) })).json()) as { token: string };
      const claims = claimsOf(token);
      return (claims.exp as number) - (claims.iat as number);
    };
    expect(await lifetime("60")).toBe(60);
    expect(await lifetime("900")).toBe(300);
    expect(await lifetime("0")).toBe(300);
  });

  test("the JWKS publishes every signing key's public half", async () => {
    const response = await call("GET", "/.well-known/jwks.json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(keys.map((k) => [k.kid, k.alg, k.use])).toEqual([
      ["test-ed25519", "EdDSA", "sig"],
      ["test-es256", "ES256", "sig"],
    ]);
    for (const key of keys) expect(key.d).toBeUndefined();
  });

  test("without its keys the service refuses, and spends no device's statement", async () => {
    const session = await signIn();
    const device = await newDevice();
    await register(session, device);
    const none = withEnv({ SIGNING_JWKS: undefined, EPHEMERAL_KEYS: undefined });
    expect((await call("GET", "/.well-known/jwks.json", { via: none })).status).toBe(503);
    const t = Date.now();
    const refused = await mintFor(session, device, { t, via: none });
    expect([refused.status, await refused.json()]).toEqual([503, { error: "not_configured" }]);
    expect((await mintFor(session, device, { t })).status).toBe(200);
    // A set with a key that doesn't import is refused whole.
    const broken = withEnv({ SIGNING_JWKS: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "no-private-half" }] }) });
    expect((await call("GET", "/.well-known/jwks.json", { via: broken })).status).toBe(503);
  });

  test("the local profile's keys, made in memory, sign tokens its JWKS checks", async () => {
    const local = withEnv({ SIGNING_JWKS: undefined });
    const session = await signIn();
    const device = await newDevice();
    await register(session, device, { via: local });
    const { token } = (await (await mintFor(session, device, { via: local })).json()) as { token: string };
    expect(claimsOf(token)).toMatchObject({ header: { alg: "EdDSA", kid: expect.stringMatching(/^local-/) } });
    expect(await identityOf(token, AUDIENCE, local)).toMatchObject({ account: session.account, device: device.id });
    // The secret's keys don't check it.
    expect(await identityOf(token, AUDIENCE)).toBeNull();
  });
});

describe("paths and origins", () => {
  test("under a path prefix, only the prefixed paths answer", async () => {
    const via = withEnv({ PATH_PREFIX: "/auth" });
    const session = await signIn();
    expect((await call("GET", "/auth/.well-known/jwks.json", { via })).status).toBe(200);
    expect((await call("GET", "/auth/v1/devices", { session, via })).status).toBe(200);
    expect((await call("GET", "/.well-known/jwks.json", { via })).status).toBe(404);
    expect((await call("GET", "/v1/devices", { session, via })).status).toBe(404);
    expect((await call("GET", "/authx/v1/devices", { session, via })).status).toBe(404);
    expect((await call("GET", "/auth", { session, via })).status).toBe(404);
  });

  test("unknown routes and methods are 404", async () => {
    const session = await signIn();
    for (const [method, path] of [["PUT", "/v1/devices"], ["GET", "/v1/tokens"], ["GET", "/v2/devices"], ["GET", "/v1/devices/x/y"], ["POST", "/dev/token"]] as const) {
      expect((await call(method, path, { session, via: withEnv({ DEV_MINT: undefined }) })).status).toBe(404);
    }
  });
});

describe("the statements", () => {
  test("are lane H's, byte for byte", () => {
    // ["clover-account-v2 register", "acct", "dev", "k", "b", "n", "phone", null, 1793000000123] in deterministic CBOR.
    expect(Buffer.from(registerStatement("acct", { id: "dev", publicKey: "k", boxKey: "b", name: "n", kind: "phone" }, 1793000000123)).toString("hex")).toBe(
      "89" + "781a" + Buffer.from("clover-account-v2 register").toString("hex") + "6461636374" + "63646576" + "616b" + "6162" + "616e" + "6570686f6e65" + "f6" + "1b000001a17720ca7b",
    );
    expect(new TextDecoder().decode(mintStatement("acct", "push.waifucave.com", "dev", 1793000000123))).toBe(
      "clover-account-v1 mint\nacct\npush.waifucave.com\ndev\n1793000000123",
    );
  });
});
