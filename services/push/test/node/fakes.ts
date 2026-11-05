// Local fakes of APNs and the Web Push services, run in Node as the Worker's outbound service: every request
// the Worker makes in tests lands here, and nothing reaches a network. They check requests the way the real
// services would (the provider token, the VAPID header, the encryption) using Node's own crypto, a separate
// implementation from the Worker's WebCrypto code, and record what they got for the tests to read back
// through https://fake.test/__log.
//
// All keys are made here for the run, in memory.

import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
  type ECDH,
  type KeyObject,
} from "node:crypto";

import type { FakeLogEntry } from "../fake-log.ts";

export type { FakeLogEntry };


interface FakeSubscription {
  name: string;
  endpoint: string;
  ecdh: ECDH;
  publicKey: Buffer;
  auth: Buffer;
}

export interface PushFakes {
  outbound(request: Request): Promise<Response>;
  bindings: Record<string, string>;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function verifyEs256(jwt: string, key: KeyObject): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
  if (!ok) return null;
  return {
    header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
  };
}

function rawP256ToKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
}

/** RFC 8291 decryption, with Node's crypto: the browser's side. */
function decryptAes128gcm(body: Buffer, subscription: FakeSubscription): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const senderKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const shared = subscription.ecdh.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), subscription.publicKey, senderKey]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, subscription.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 2) throw new Error("bad padding delimiter");
  return record.subarray(0, end);
}

function pad32(scalar: Buffer): Buffer {
  return scalar.length >= 32 ? scalar : Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
}

export function createPushFakes(config: { apnsKeyId: string; apnsTeamId: string; apnsTopic: string }): PushFakes {
  const apnsKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const vapidPublic = vapid.getPublicKey();

  const subscriptions = new Map<string, FakeSubscription>();
  const endpoints: Record<string, string> = {
    fcm: "https://fcm.googleapis.com/fcm/send/fcm-device-1",
    mozilla: "https://updates.push.services.mozilla.com/wpush/v2/moz-device-1",
    apple: "https://web.push.apple.com/QApple-device-1",
    gone: "https://fcm.googleapis.com/fcm/send/gone-device-1",
  };
  for (const [name, endpoint] of Object.entries(endpoints)) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    subscriptions.set(endpoint, { name, endpoint, ecdh, publicKey: ecdh.getPublicKey(), auth: randomBytes(16) });
  }

  const log: FakeLogEntry[] = [];
  const expiredOnce = new Set<string>();

  async function apns(request: Request, url: URL): Promise<Response> {
    const env = url.hostname === "api.sandbox.push.apple.com" ? "sandbox" : "production";
    const token = url.pathname.replace(/^\/3\/device\//, "");
    const providerToken = (request.headers.get("authorization") ?? "").replace(/^bearer /, "");
    const entry: FakeLogEntry = {
      service: "apns",
      url: url.href,
      status: 0,
      token,
      env,
      topic: request.headers.get("apns-topic") ?? undefined,
      pushType: request.headers.get("apns-push-type") ?? undefined,
      priority: request.headers.get("apns-priority") ?? undefined,
      collapseId: request.headers.get("apns-collapse-id") ?? undefined,
      providerToken,
    };
    log.push(entry);
    const reply = (status: number, reason?: string) => {
      entry.status = status;
      if (reason) entry.error = reason;
      return reason ? json({ reason }, status) : new Response(null, { status: 200, headers: { "apns-id": crypto.randomUUID() } });
    };
    if (request.method !== "POST" || !/^\/3\/device\/[0-9a-f]+$/.test(url.pathname)) return reply(405, "MethodNotAllowed");
    const verified = verifyEs256(providerToken, apnsKey.publicKey);
    if (!verified || verified.header.kid !== config.apnsKeyId || verified.claims.iss !== config.apnsTeamId) return reply(403, "InvalidProviderToken");
    const iat = verified.claims.iat;
    if (typeof iat !== "number" || Math.abs(Date.now() / 1000 - iat) > 3600) return reply(403, "ExpiredProviderToken");
    if (entry.topic !== config.apnsTopic) return reply(400, "DeviceTokenNotForTopic");
    if (entry.pushType !== "alert") return reply(400, "InvalidPushType");
    try {
      entry.payload = JSON.parse(await request.text());
    } catch {
      return reply(400, "PayloadEmpty");
    }
    if (token.startsWith("dead")) return reply(410, "Unregistered");
    if (token.startsWith("bad0")) return reply(400, "BadDeviceToken");
    if (token.startsWith("e1e1") && !expiredOnce.has(token)) {
      expiredOnce.add(token);
      return reply(403, "ExpiredProviderToken");
    }
    return reply(200);
  }

  async function webpush(request: Request, url: URL, subscription: FakeSubscription): Promise<Response> {
    const entry: FakeLogEntry = {
      service: "webpush",
      url: url.href,
      status: 0,
      subscription: subscription.name,
      ttl: request.headers.get("ttl") ?? undefined,
      urgency: request.headers.get("urgency") ?? undefined,
      topicHeader: request.headers.get("topic") ?? undefined,
    };
    log.push(entry);
    const reply = (status: number, error?: string) => {
      entry.status = status;
      if (error) entry.error = error;
      return new Response(null, { status });
    };
    const auth = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
    if (!auth) return reply(401, "no vapid header");
    const k = Buffer.from(auth[2]!, "base64url");
    if (!k.equals(vapidPublic)) return reply(403, "unknown application server key");
    const verified = verifyEs256(auth[1]!, rawP256ToKey(k));
    if (!verified) return reply(403, "bad vapid signature");
    const { aud, exp, sub } = verified.claims as { aud?: string; exp?: number; sub?: string };
    entry.vapidAud = aud;
    entry.vapidSub = sub;
    const now = Date.now() / 1000;
    if (aud !== url.origin || typeof exp !== "number" || exp <= now || exp > now + 24 * 3600) return reply(403, "bad vapid claims");
    if (typeof sub !== "string" || !/^(mailto:|https:)/.test(sub)) return reply(403, "bad vapid subject");
    if (request.headers.get("content-encoding") !== "aes128gcm" || !entry.ttl) return reply(400, "bad headers");
    try {
      entry.decrypted = JSON.parse(decryptAes128gcm(Buffer.from(await request.arrayBuffer()), subscription).toString("utf8"));
    } catch (err) {
      return reply(400, `cannot decrypt: ${(err as Error).message}`);
    }
    if (subscription.name === "gone") return reply(410);
    return reply(201);
  }

  async function outbound(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.host === "fake.test") {
      if (url.pathname === "/__log") return json(log, 200);
      if (url.pathname === "/__reset") {
        log.length = 0;
        return json({ ok: true }, 200);
      }
    }
    if (url.hostname === "api.push.apple.com" || url.hostname === "api.sandbox.push.apple.com") return apns(request, url);
    const subscription = subscriptions.get(url.href);
    if (subscription) return webpush(request, url, subscription);
    log.push({ service: "unexpected", url: url.href, status: 599 });
    return new Response("outbound request refused in tests", { status: 599 });
  }

  const testSubscriptions = Object.fromEntries(
    [...subscriptions.values()].map((s) => [s.name, { endpoint: s.endpoint, keys: { p256dh: s.publicKey.toString("base64url"), auth: s.auth.toString("base64url") } }]),
  );

  return {
    outbound,
    bindings: {
      APNS_PRIVATE_KEY: apnsKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      VAPID_PUBLIC_KEY: vapidPublic.toString("base64url"),
      VAPID_PRIVATE_KEY: pad32(vapid.getPrivateKey()).toString("base64url"),
      TEST_SUBSCRIPTIONS: JSON.stringify(testSubscriptions),
    },
  };
}
