// The shared source on its own, under Bun (the Workers' suites run it under workerd): the encodings, the HTTP
// helpers and the account-token check, with a key of the test's own.
import { describe, expect, test } from "bun:test";
import { bearerToken, verifyAccountToken } from "../account-token";
import { b64u, concatBytes, equalBytes, fromB64, fromB64u, utf8 } from "../encoding";
import { intVar } from "../http";
import { StepLimiter } from "../testing/step-limiter";

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const { x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", kid: "k1", x, y }] });
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "k1" }) => {
    const signed = `${b64u(utf8(JSON.stringify(header)))}.${b64u(utf8(JSON.stringify(claims)))}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, utf8(signed)));
    return `${signed}.${b64u(sig)}`;
  };
  return { jwks, sign };
}

describe("services/shared", () => {
  test("encodings round-trip", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(equalBytes(fromB64u(b64u(bytes)), bytes)).toBe(true);
    expect(b64u(bytes)).not.toMatch(/[+/=]/);
    expect(equalBytes(fromB64(Buffer.from(bytes).toString("base64")), bytes)).toBe(true);
    expect(equalBytes(concatBytes(utf8("ab"), utf8("c")), utf8("abc"))).toBe(true);
    expect(equalBytes(utf8("a"), utf8("b"))).toBe(false);
  });

  test("intVar takes positive integers only", () => {
    expect(intVar("12", 5)).toBe(12);
    for (const bad of [undefined, "", "0", "-3", "1.5", "x"]) expect(intVar(bad, 5)).toBe(5);
  });

  test("bearerToken reads the Authorization header", () => {
    expect(bearerToken(new Request("http://x", { headers: { authorization: "Bearer a.b.c" } }))).toBe("a.b.c");
    expect(bearerToken(new Request("http://x", { headers: { authorization: "Basic a" } }))).toBeNull();
    expect(bearerToken(new Request("http://x"))).toBeNull();
  });

  test("an account token is accepted only when it is signed, current and for this service", async () => {
    const { jwks, sign } = await signer();
    const now = 1_800_000_000;
    const config = { jwks, issuer: "https://accounts.example.invalid", audience: "push", now };
    const claims = { iss: config.issuer, aud: ["push", "hooks"], sub: "acct-1", dev: "dev_1", iat: now - 10, exp: now + 600 };
    expect(await verifyAccountToken(await sign(claims), config)).toEqual({ account: "acct-1", device: "dev_1", expiresAt: now + 600 });
    expect(await verifyAccountToken(await sign({ ...claims, aud: "hooks" }), config)).toBeNull();
    expect(await verifyAccountToken(await sign({ ...claims, exp: now - 120 }), config)).toBeNull();
    expect(await verifyAccountToken(await sign(claims, { alg: "ES256", kid: "other" }), config)).toBeNull();
    expect(await verifyAccountToken(await sign(claims, { alg: "none", kid: "k1" }), config)).toBeNull();
    const good = await sign(claims);
    expect(await verifyAccountToken(`${good.slice(0, -4)}AAAA`, config)).toBeNull();
  });

  test("the step limiter counts per key until the next window", async () => {
    const l = new StepLimiter(1);
    expect((await l.limit({ key: "a" })).success).toBe(true);
    expect((await l.limit({ key: "a" })).success).toBe(false);
    expect((await l.limit({ key: "b" })).success).toBe(true);
    expect(l.count("a")).toBe(2);
  });
});
