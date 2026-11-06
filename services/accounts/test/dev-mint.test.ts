// The local profile as the emulators' sign-in stand-in: keys made in memory, and a mint without a sign-in that the
// services check exactly as production's tokens, by JWKS URL. Production has neither (test/node/e2e.test.ts reads
// its profile).

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { clearJwksCache, verifyAccountTokenFrom } from "../../shared/jwks";
import { call, jwksFetcher, ORIGIN, withEnv } from "./helpers";

const local = withEnv({ SIGNING_JWKS: undefined });

describe("the local profile's mint", () => {
  test("serves a JWKS whose key checks the tokens it mints, as the services check them by URL", async () => {
    const jwks = (await (await call("GET", "/.well-known/jwks.json", { via: local })).json()) as { keys: { kid: string; kty: string; d?: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(jwks.keys[0]!.d).toBeUndefined();

    const minted = await call("POST", "/dev/token", { via: local, body: { account: "acct-1", device: "studio", aud: "handshake.waifucave.com" } });
    const { token } = (await minted.json()) as { token: string };
    clearJwksCache();
    const config = { ACCOUNT_ISSUER: env.ISSUER, ACCOUNT_JWKS_URL: `${ORIGIN}/.well-known/jwks.json` };
    expect(await verifyAccountTokenFrom(token, config, "handshake.waifucave.com", jwksFetcher(local))).toMatchObject({ account: "acct-1", device: "studio" });
    expect(await verifyAccountTokenFrom(token, config, "push.waifucave.com", jwksFetcher(local))).toBeNull();
  });

  test("refuses malformed mint requests", async () => {
    expect((await call("POST", "/dev/token", { via: local, body: { account: "a", device: "has space", aud: "x" } })).status).toBe(400);
    expect((await call("POST", "/dev/token", { via: local, body: { account: "a", device: "d", aud: "x", ttl: 301 } })).status).toBe(400);
    expect((await call("GET", "/nothing", { via: local })).status).toBe(404);
  });

  test("is closed beside real keys: with SIGNING_JWKS set, even in the local profile", async () => {
    // The test environment has SIGNING_JWKS, EPHEMERAL_KEYS and DEV_MINT all set.
    expect((await call("POST", "/dev/token", { body: { account: "a", device: "d", aud: "handshake.waifucave.com" } })).status).toBe(404);
    const noMemoryKeys = withEnv({ SIGNING_JWKS: undefined, EPHEMERAL_KEYS: undefined });
    expect((await call("POST", "/dev/token", { via: noMemoryKeys, body: { account: "a", device: "d", aud: "handshake.waifucave.com" } })).status).toBe(404);
  });

  test("is closed without DEV_MINT", async () => {
    const closed = withEnv({ SIGNING_JWKS: undefined, DEV_MINT: undefined });
    expect((await call("POST", "/dev/token", { via: closed, body: { account: "a", device: "d", aud: "handshake.waifucave.com" } })).status).toBe(404);
  });
});
