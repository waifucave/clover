// The account service end to end, on wrangler's local runtime, against lane M's sign-in stub (a GoTrue stand-in):
// a password sign-in at the stub, then lane H's wire over real sockets, with ids made by lane B's `deviceIdFor` and
// tokens checked by the services' own `verifyAccountToken`. And the production profile, read from wrangler.jsonc.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SignInStub, startSignInStub } from "@waifucave/clover-test-harness/signin-stub";
import ts from "typescript";

import { verifyAccountToken } from "../../../shared/account-token";
import { deviceIdFor, mintStatement, registerStatement } from "../../src/wire";
import { type AccountServiceHarness, harnessReady, startAccountService } from "./harness";

const servicesDir = join(dirname(import.meta.path), "../../..");
const coreContracts = join(dirname(fileURLToPath(import.meta.resolve("@waifucave/clover-core"))), "contracts");
const laneB = (await import(join(coreContracts, "device-registry.ts"))) as { deviceIdFor(publicKey: Uint8Array): Promise<string> };
const laneH = (await import(join(coreContracts, "../identity/account.ts"))) as {
  registerStatement(account: string, d: { id: string; publicKey: string; boxKey: string; name: string; kind: string; os?: string }, t: number): Uint8Array;
  mintStatement: ((account: string, audience: string, device: string, t: number) => Uint8Array) | ((audience: string, device: string, t: number) => Uint8Array);
};
/** Lane H's mint names the account from H-M2 (ba83cab8a) on; main's core before it doesn't. */
const laneHMintNamesAccount = laneH.mintStatement.length === 4;

function device() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  return {
    raw,
    publicKey: Buffer.from(raw).toString("base64"),
    boxKey: Buffer.from(generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(12)).toString("base64url"),
    sign: (data: Uint8Array) => sign(null, data, privateKey).toString("base64url"),
  };
}

describe("ids", () => {
  test("are lane B's deviceIdFor, for any key", async () => {
    for (let i = 0; i < 50; i++) {
      const { raw } = device();
      expect(await deviceIdFor(raw)).toBe(await laneB.deviceIdFor(raw));
    }
  });
});

describe.skipIf(!harnessReady())("against lane M's sign-in stub", () => {
  let stub: SignInStub;
  let service: AccountServiceHarness;

  beforeAll(async () => {
    stub = startSignInStub();
    service = await startAccountService({ authUrl: stub.url, anonKey: stub.anonKey });
  }, 90_000);

  afterAll(async () => {
    await service?.stop();
    stub?.stop();
  });

  async function signedIn(): Promise<{ access: string; account: string }> {
    const email = `e2e-${crypto.randomUUID()}@example.test`;
    const password = crypto.randomUUID();
    stub.addUser({ email, password });
    const response = await fetch(`${stub.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: stub.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const session = (await response.json()) as { access_token: string; user: { id: string } };
    return { access: session.access_token, account: session.user.id };
  }

  const api = (method: string, path: string, access: string, body?: unknown) =>
    fetch(`${service.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${access}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("signs in, registers, lists, mints a token the services accept, and revokes", async () => {
    const { access, account } = await signedIn();
    const d = device();
    const id = await laneB.deviceIdFor(d.raw);
    const t = Date.now();
    const record = { id, publicKey: d.publicKey, boxKey: d.boxKey, name: "Studio", kind: "desktop", os: "macos" };
    // Signed over lane H's own statement (the core's identity/account.ts), so the service checks what H signs.
    const registered = await api("POST", "/v1/devices", access, { device: record, t, sig: d.sign(laneH.registerStatement(account, record, t)) });
    expect(registered.status).toBe(201);
    const { devices } = (await (await api("GET", "/v1/devices", access)).json()) as { devices: { id: string; publicKey: string; boxKey: string }[] };
    expect(devices).toEqual([expect.objectContaining({ id, publicKey: d.publicKey, boxKey: d.boxKey })]);

    const audience = "push.waifucave.com";
    const mintT = Date.now();
    const minted = await api("POST", "/v1/tokens", access, { aud: audience, dev: id, t: mintT, sig: d.sign(mintStatement(account, audience, id, mintT)) });
    expect(minted.status).toBe(200);
    const { token, expiresAt } = (await minted.json()) as { token: string; expiresAt: number };
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
    // Checked offline against the JWKS the service publishes, as push would.
    const served = await (await fetch(`${service.url}/.well-known/jwks.json`)).text();
    expect(JSON.parse(served)).toEqual(JSON.parse(service.jwks));
    expect(await verifyAccountToken(token, { jwks: served, issuer: service.issuer, audience })).toMatchObject({ account, device: id });
    expect(await verifyAccountToken(token, { jwks: served, issuer: service.issuer, audience: "hooks.waifucave.com" })).toBeNull();

    expect((await api("DELETE", `/v1/devices/${id}`, access)).status).toBe(204);
    const again = Date.now();
    expect((await api("POST", "/v1/tokens", access, { aud: audience, dev: id, t: again, sig: d.sign(mintStatement(account, audience, id, again)) })).status).toBe(403);
  });

  test("refuses what the stub refuses", async () => {
    expect((await api("GET", "/v1/devices", "not-a-session")).status).toBe(401);
    const { access } = await signedIn();
    // The same token with its signature broken. The FIRST signature character carries six real signature bits and is
    // swapped for a different one, so the signature always differs. The old edit overwrote the last two characters
    // with "xx": a base64url HMAC ends in a character with unused padding bits, which decode to the same bytes, so the
    // "broken" token was in fact the real one about once in a thousand runs and answered 200.
    const [head, payload, signature] = access.split(".") as [string, string, string];
    const broken = `${head}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(broken).not.toBe(access);
    expect((await api("GET", "/v1/devices", broken)).status).toBe(401);
    expect((await api("GET", "/v1/devices", access)).status).toBe(200);
  });
});

describe("the production profile", () => {
  const profile = (service: string): { name: string; vars: Record<string, string>; durable_objects?: { bindings: { name: string }[] }; services?: { binding: string; service: string }[] } => {
    const path = join(servicesDir, service, "wrangler.jsonc");
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    if (parsed.error) throw new Error(`${service}/wrangler.jsonc doesn't parse`);
    return (parsed.config as { env: { production: ReturnType<typeof profile> } }).env.production;
  };

  test("has no mint without a sign-in, and makes no keys of its own", () => {
    const { vars, durable_objects } = profile("accounts");
    expect(vars.DEV_MINT).toBeUndefined();
    expect(vars.EPHEMERAL_KEYS).toBeUndefined();
    expect(vars.SIGNING_JWKS).toBeUndefined();
    expect(vars.ISSUER).toBe("https://waifucave.com/auth");
    expect(vars.PATH_PREFIX).toBe("/auth");
    expect(durable_objects?.bindings.map((b) => b.name).sort()).toEqual(["ACCOUNTS", "KEYS"]);
  });

  test("is where the other services look for its tokens' issuer and keys, through a service binding", () => {
    const accounts = profile("accounts");
    const { ISSUER } = accounts.vars;
    for (const service of ["forwarder", "push", "handshake"]) {
      const { vars, services } = profile(service);
      expect([service, vars.ACCOUNT_ISSUER, vars.ACCOUNT_JWKS_URL, vars.ACCOUNT_JWKS]).toEqual([service, ISSUER, `${ISSUER}/.well-known/jwks.json`, undefined]);
      expect([service, services]).toEqual([service, [{ binding: "ACCOUNT_SERVICE", service: accounts.name }]]);
    }
  });
});

describe("the registration statement", () => {
  test("is lane H's, byte for byte, with and without os", () => {
    const base = { id: "a".repeat(32), publicKey: "k+/=", boxKey: "b-_", name: "Studio é 🍀 \ud800", kind: "phone" };
    for (const d of [base, { ...base, kind: "desktop", os: "macos" }]) {
      for (const t of [0, 23, 24, 255, 65_536, 1_793_000_000_123]) {
        expect(Buffer.from(registerStatement("acct-1", d, t)).toString("hex")).toBe(Buffer.from(laneH.registerStatement("acct-1", d, t)).toString("hex"));
      }
    }
  });
});

describe("the mint statement", () => {
  // Runs once lane H's H-M2 is on main; until then main's core signs the older mint without the account, which this
  // service refuses (the mint names the account, as agreed with H).
  test.skipIf(!laneHMintNamesAccount)("is lane H's, byte for byte", () => {
    const h = laneH.mintStatement as (account: string, audience: string, device: string, t: number) => Uint8Array;
    for (const aud of ["push.waifucave.com", "handshake.waifucave.com", "hooks.waifucave.com"]) {
      for (const t of [0, 1_793_000_000_123]) {
        expect(Buffer.from(mintStatement("acct-1", aud, "a".repeat(32), t)).toString("hex")).toBe(Buffer.from(h("acct-1", aud, "a".repeat(32), t)).toString("hex"));
      }
    }
  });
});
