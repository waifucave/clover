import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { clearJwksCache, verifyAccountTokenFrom } from "../../shared/jwks";

const ORIGIN = "https://accounts.test";
const worker = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${ORIGIN}${path}`, init));

describe("the local sign-in stand-in", () => {
  test("serves a JWKS whose key checks the tokens it mints, as the services check them by URL", async () => {
    const jwks = (await (await worker("/.well-known/jwks.json")).json()) as { keys: { kid: string; kty: string; d?: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(jwks.keys[0]!.d).toBeUndefined();

    const minted = await worker("/dev/token", { method: "POST", body: JSON.stringify({ account: "acct-1", device: "studio", aud: "handshake.waifucave.com" }) });
    const { token } = (await minted.json()) as { token: string };
    clearJwksCache();
    const fetcher = ((input: RequestInfo | URL) => worker(new URL(String(input)).pathname)) as typeof fetch;
    const identity = await verifyAccountTokenFrom(
      token,
      { ACCOUNT_ISSUER: env.ISSUER, ACCOUNT_JWKS_URL: `${ORIGIN}/.well-known/jwks.json` },
      "handshake.waifucave.com",
      fetcher,
    );
    expect(identity).toMatchObject({ account: "acct-1", device: "studio" });
    expect(await verifyAccountTokenFrom(token, { ACCOUNT_ISSUER: env.ISSUER, ACCOUNT_JWKS_URL: `${ORIGIN}/.well-known/jwks.json` }, "push.waifucave.com", fetcher)).toBeNull();
  });

  test("refuses malformed mint requests", async () => {
    const bad = await worker("/dev/token", { method: "POST", body: JSON.stringify({ account: "a", device: "has space", aud: "x" }) });
    expect(bad.status).toBe(400);
    expect((await worker("/dev/token", { method: "POST", body: JSON.stringify({ account: "a", device: "d", aud: "x", ttl: 90_000 }) })).status).toBe(400);
    expect((await worker("/nothing")).status).toBe(404);
  });
});
