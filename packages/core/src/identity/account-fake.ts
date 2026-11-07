// A stand-in for waifucave's account service (the wire in account.ts, lane H's proposal to lane I), for tests: it
// checks the Supabase access token against a sign-in stack (lane M's stub), keeps each account's devices, and mints
// EdDSA account tokens that lane I's `verifyAccountToken` accepts. Everything is in memory; the signing key is made
// fresh for each run.
import { createPrivateKey, randomUUID, sign as nodeSign } from "node:crypto";
import { fromBase64Url, toBase64Url, utf8 } from "./bytes";
import { generateEd25519, verifyEd25519 } from "./keys";
import { deviceIdFor } from "../contracts/device-registry";
import { mintStatement, registerStatement, type AccountDevice } from "./account";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface FakeAccountService {
  url: string;
  issuer: string;
  /** `{"keys":[...]}`, for `verifyAccountToken`. */
  jwks: string;
  devices(account: string): AccountDevice[];
  /** Mints issued, newest last (audience and device only). */
  readonly mints: { aud: string; dev: string }[];
  stop(): void;
}

export function startFakeAccountService(opts: { authUrl: string; anonKey: string; tokenTtlSeconds?: number }): FakeAccountService {
  const key = generateEd25519();
  const kid = toBase64Url(key.publicKey).slice(0, 12);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(key.seed().reveal(), "base64")]), format: "der", type: "pkcs8" });
  const jwks = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: toBase64Url(key.publicKey), kid, alg: "EdDSA", use: "sig" }] });
  const accounts = new Map<string, AccountDevice[]>();
  const mints: { aud: string; dev: string }[] = [];
  const ttl = Math.min(opts.tokenTtlSeconds ?? 300, 300);
  let issuer = "";

  const user = async (req: Request): Promise<string | undefined> => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return undefined;
    const res = await fetch(`${opts.authUrl}/auth/v1/user`, { headers: { apikey: opts.anonKey, authorization: auth } });
    if (!res.ok) return undefined;
    return ((await res.json()) as { id?: string }).id;
  };
  const fresh = (t: unknown) => typeof t === "number" && Math.abs(t - Date.now()) < 10 * 60_000;
  const sigOk = (publicKeyB64: string, data: Uint8Array, sig: unknown) => {
    const k = Buffer.from(publicKeyB64, "base64");
    const s = typeof sig === "string" ? fromBase64Url(sig) : null;
    return s !== null && verifyEd25519(new Uint8Array(k), data, s);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") return new Response(jwks, { headers: { "content-type": "application/json" } });
      const sub = await user(req);
      if (!sub) return Response.json({ error: "unauthorized" }, { status: 401 });
      const list = accounts.get(sub) ?? [];
      accounts.set(sub, list);
      const parts = url.pathname.split("/").slice(1);
      if (url.pathname === "/v1/devices" && req.method === "GET") return Response.json({ devices: list });
      if (url.pathname === "/v1/devices" && req.method === "POST") {
        const b = (await req.json()) as { device?: AccountDevice; t?: number; sig?: string };
        const d = b.device;
        if (!d || typeof d.id !== "string" || typeof d.publicKey !== "string" || typeof d.boxKey !== "string" || !fresh(b.t)) return Response.json({ error: "bad_request" }, { status: 400 });
        if ((await deviceIdFor(new Uint8Array(Buffer.from(d.publicKey, "base64")))) !== d.id) return Response.json({ error: "bad_request" }, { status: 400 });
        if (typeof d.name !== "string" || typeof d.kind !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
        if (!sigOk(d.publicKey, registerStatement(sub, { id: d.id, publicKey: d.publicKey, boxKey: d.boxKey, name: d.name, kind: d.kind, ...(typeof d.os === "string" ? { os: d.os } : {}) }, b.t!), b.sig)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const existing = list.find((x) => x.id === d.id);
        if (existing?.revokedAt !== undefined) return Response.json({ error: "revoked" }, { status: 403 });
        const record: AccountDevice = { id: d.id, publicKey: d.publicKey, boxKey: d.boxKey, name: d.name, kind: d.kind, ...(d.os ? { os: d.os } : {}), addedAt: existing?.addedAt ?? Date.now() };
        if (existing) Object.assign(existing, record);
        else list.push(record);
        return Response.json({ device: record }, { status: existing ? 200 : 201 });
      }
      if (parts[0] === "v1" && parts[1] === "devices" && parts[2] && req.method === "DELETE") {
        const d = list.find((x) => x.id === decodeURIComponent(parts[2]!));
        if (!d) return Response.json({ error: "not_found" }, { status: 404 });
        d.revokedAt ??= Date.now();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/tokens" && req.method === "POST") {
        const b = (await req.json()) as { aud?: string; dev?: string; t?: number; sig?: string };
        if (typeof b.aud !== "string" || typeof b.dev !== "string" || !fresh(b.t)) return Response.json({ error: "bad_request" }, { status: 400 });
        const d = list.find((x) => x.id === b.dev && x.revokedAt === undefined);
        if (!d) return Response.json({ error: "not_member" }, { status: 403 });
        if (!sigOk(d.publicKey, mintStatement(sub, b.aud, b.dev, b.t!), b.sig)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const iat = Math.floor(Date.now() / 1000);
        const header = toBase64Url(utf8(JSON.stringify({ alg: "EdDSA", kid, typ: "JWT" })));
        const claims = toBase64Url(utf8(JSON.stringify({ iss: issuer, aud: b.aud, sub, dev: b.dev, iat, exp: iat + ttl, jti: randomUUID() })));
        const sig = toBase64Url(nodeSign(null, utf8(`${header}.${claims}`), priv));
        mints.push({ aud: b.aud, dev: b.dev });
        return Response.json({ token: `${header}.${claims}.${sig}`, expiresAt: (iat + ttl) * 1000 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;
  return {
    url: issuer,
    issuer,
    jwks,
    devices: (account) => (accounts.get(account) ?? []).map((d) => ({ ...d })),
    mints,
    stop: () => server.stop(true),
  };
}
