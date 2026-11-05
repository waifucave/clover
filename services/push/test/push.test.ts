// waifucave push against the local fakes of APNs and Web Push: registering phones and browsers, a
// content-free notify fanned out to each, dead targets removed, and the limits.

import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, sha256, utf8 } from "../../shared/encoding";
import { REVOCATION_KEEP_MS, type PushDO } from "../src/push-do";
import { apnsToken, call, callWith, device, fakeLog, ORIGIN, subscriptions, uniqueAccount } from "./helpers";
import { StepLimiter } from "../../shared/testing/step-limiter";
import type { FakeLogEntry } from "./fake-log";

async function since(before: number): Promise<FakeLogEntry[]> {
  return (await fakeLog()).slice(before);
}

async function logLength(): Promise<number> {
  return (await fakeLog()).length;
}

describe("targets", () => {
  it("serves the VAPID public key browsers subscribe with", async () => {
    const response = await call(null, "GET", "/v1/vapid");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  it("needs a token for this service", async () => {
    expect((await call(null, "GET", "/v1/targets")).status).toBe(401);
    const { token } = await device(uniqueAccount(), "phone");
    expect((await call(token, "GET", "/v1/targets")).status).toBe(200);
    const { accountToken } = await import("./helpers");
    const forHooks = await accountToken({ account: "a", device: "d", aud: "hooks.waifucave.com" });
    expect((await call(forHooks, "GET", "/v1/targets")).status).toBe(401);
  });

  it("registers a phone and browsers, and lists them without their tokens or endpoints", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const browser = await device(account, "firefox");
    const token = apnsToken();
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token, env: "production" })).status).toBe(204);
    expect((await call(browser.token, "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.mozilla })).status).toBe(204);
    const listed = (await (await call(phone.token, "GET", "/v1/targets")).json()) as { targets: Record<string, unknown>[] };
    expect(listed.targets.map(({ added: _added, ...rest }) => rest)).toEqual([
      { id: "phone", kind: "apns", env: "production" },
      { id: "firefox", kind: "webpush", host: "updates.push.services.mozilla.com" },
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain("moz-device-1");
  });

  it("refuses targets that are malformed or point at a host that is not a push service", async () => {
    const { token } = await device(uniqueAccount(), "phone");
    // 65 bytes that start like an uncompressed P-256 key but are not a point on the curve.
    const offCurve = btoa(String.fromCharCode(4, ...new Array(64).fill(7))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = [
      { kind: "webpush", endpoint: subscriptions.fcm.endpoint, keys: { p256dh: offCurve, auth: subscriptions.fcm.keys.auth } },
      { kind: "apns", token: "xyz", env: "production" },
      { kind: "apns", token: apnsToken(), env: "staging" },
      { kind: "webpush", endpoint: "https://evil.example/push", keys: subscriptions.fcm.keys },
      { kind: "webpush", endpoint: "http://fcm.googleapis.com/fcm/send/x", keys: subscriptions.fcm.keys },
      { kind: "webpush", endpoint: subscriptions.fcm.endpoint, keys: { p256dh: "AAAA", auth: subscriptions.fcm.keys.auth } },
      { kind: "sms", number: "123" },
    ];
    for (const body of bad) expect((await call(token, "PUT", "/v1/targets/self", body)).status).toBe(400);
  });

  it("caps the targets per account, and removes one on request", async () => {
    const account = uniqueAccount();
    const devices = await Promise.all(Array.from({ length: 6 }, (_, i) => device(account, `phone${i}`)));
    for (const d of devices.slice(0, 5)) {
      expect((await call(d.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" })).status).toBe(204);
    }
    const over = await call(devices[5]!.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" });
    expect(over.status).toBe(409);
    expect((await call(devices[5]!.token, "DELETE", "/v1/targets/phone0")).status).toBe(204);
    expect((await call(devices[5]!.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" })).status).toBe(204);
    // Removing phone0's target did not revoke phone0: it can register again once there is room.
    expect((await call(devices[1]!.token, "DELETE", "/v1/targets/self")).status).toBe(204);
    expect((await call(devices[0]!.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" })).status).toBe(204);
  });

  it("removing another device's target only stops pushes to it: that device can register again", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const browser = await device(account, "browser");
    expect((await call(browser.token, "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.fcm })).status).toBe(204);
    expect((await call(phone.token, "DELETE", "/v1/targets/browser")).status).toBe(204);
    expect(((await (await call(phone.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toEqual([]);
    expect((await call(browser.token, "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.fcm })).status).toBe(204);
  });

  it("revoking a device (what the account service calls) takes its target, and it can neither register nor notify", async () => {
    const account = uniqueAccount();
    const kept = await device(account, "kept-phone");
    const lost = await device(account, "lost-phone");
    expect((await call(lost.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" })).status).toBe(204);
    expect((await call(kept.token, "DELETE", "/v1/devices/lost-phone")).status).toBe(204);
    expect(((await (await call(kept.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toEqual([]);
    expect((await call(lost.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" })).status).toBe(403);
    expect((await call(lost.token, "POST", "/v1/notify", { badge: 1 })).status).toBe(403);
    expect((await call(lost.token, "GET", "/v1/targets")).status).toBe(403);
    // Any id: a device revoked before it ever registered stays out too.
    expect((await call(kept.token, "DELETE", "/v1/devices/never-seen")).status).toBe(204);
    const never = await device(account, "never-seen");
    expect((await call(never.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" })).status).toBe(403);
  });

  it("prunes revocations by age, once every token issued before them has expired, not by count", async () => {
    const account = uniqueAccount();
    const admin = await device(account, "admin-phone");
    const object = env.PUSH.getByName(b64u(await sha256(utf8(`push-account|${account}`))));
    expect((await call(admin.token, "GET", "/v1/targets")).status).toBe(200); // the object now belongs to the account
    const now = Date.now();
    await runInDurableObject(object, (_i: PushDO, state) => {
      state.storage.sql.exec("INSERT INTO revoked (id, at) VALUES ('long-ago', ?), ('lately', ?)", now - REVOCATION_KEEP_MS - 1, now - 3600_000);
    });
    const back = await device(account, "long-ago");
    expect((await call(back.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" })).status).toBe(204);
    const recent = await device(account, "lately");
    expect((await call(recent.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "sandbox" })).status).toBe(403);
    expect((await call(admin.token, "DELETE", "/v1/devices/fresh")).status).toBe(204);
    const left = await runInDurableObject(object, (_i: PushDO, state) =>
      state.storage.sql.exec<{ id: string }>("SELECT id FROM revoked ORDER BY id").toArray().map((row) => row.id),
    );
    expect(left).toEqual(["fresh", "lately"]);
  });

  it("rate-limits listing, removing targets and revoking, per account", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const api = new StepLimiter(6);
    const limited = callWith({ API_RATE: api, NOTIFY_RATE: new StepLimiter(100) });
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) statuses.push((await limited(phone.token, "GET", "/v1/targets")).status);
    for (let i = 0; i < 2; i++) statuses.push((await limited(phone.token, "DELETE", `/v1/targets/gone-${i}`)).status);
    for (let i = 0; i < 3; i++) statuses.push((await limited(phone.token, "DELETE", `/v1/devices/gone-${i}`)).status);
    expect(statuses.slice(0, 6).every((s) => s === 200 || s === 204)).toBe(true);
    expect(statuses[6]).toBe(429);
    // Another account has its own budget.
    const other = await device(uniqueAccount(), "phone");
    expect((await limited(other.token, "GET", "/v1/targets")).status).toBe(200);
    api.nextWindow();
    expect((await limited(phone.token, "GET", "/v1/targets")).status).toBe(200);
  });
});

describe("notify", () => {
  it("sends only a count: APNs gets a fixed alert and a badge, browsers an encrypted {n}", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const token = apnsToken();
    await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token, env: "production" });
    for (const [name, subscription] of Object.entries({ fcm: subscriptions.fcm, apple: subscriptions.apple })) {
      const browser = await device(account, `browser-${name}`);
      await call(browser.token, "PUT", "/v1/targets/self", { kind: "webpush", ...subscription });
    }
    const computer = await device(account, "main-computer");
    const before = await logLength();
    const response = await call(computer.token, "POST", "/v1/notify", { badge: 3, title: "Alpha", body: "the secret plan" });
    expect(await response.json()).toEqual({ sent: 3, removed: 0, failed: 0 });

    const entries = await since(before);
    expect(entries.every((e) => e.service !== "unexpected")).toBe(true);
    const apns = entries.find((e) => e.service === "apns")!;
    expect(apns).toMatchObject({
      status: 200,
      token,
      env: "production",
      topic: env.APNS_TOPIC,
      pushType: "alert",
      priority: "10",
      collapseId: "clover-updates",
    });
    expect(apns.payload).toEqual({
      aps: { alert: { "loc-key": "CLOVER_UPDATES", "loc-args": ["3"] }, badge: 3, sound: "default", "mutable-content": 1, "thread-id": "clover" },
    });
    const web = entries.filter((e) => e.service === "webpush");
    expect(web.map((e) => e.subscription).sort()).toEqual(["apple", "fcm"]);
    for (const entry of web) {
      expect(entry).toMatchObject({ status: 201, decrypted: { n: 3 }, ttl: "86400", urgency: "normal", topicHeader: "clover-updates" });
      expect(entry.vapidAud).toBe(new URL(entry.url).origin);
      expect(entry.vapidSub).toBe(env.VAPID_SUBJECT);
    }
    // Content never leaves: not to Apple, not to the browsers' push services.
    expect(JSON.stringify(entries)).not.toContain("secret plan");
    expect(JSON.stringify(entries)).not.toContain("Alpha");
  });

  it("forgets targets their push service reports gone at once, and a 'bad token' only after three in a row", async () => {
    const account = uniqueAccount();
    const targets = [
      ["live", { kind: "apns", token: apnsToken(), env: "production" }],
      ["unregistered", { kind: "apns", token: apnsToken("dead"), env: "production" }],
      ["bad-token", { kind: "apns", token: apnsToken("bad0"), env: "sandbox" }],
      ["old-browser", { kind: "webpush", ...subscriptions.gone }],
    ] as const;
    for (const [id, body] of targets) {
      const d = await device(account, id);
      expect((await call(d.token, "PUT", "/v1/targets/self", body)).status).toBe(204);
    }
    const computer = await device(account, "main");
    const ids = async () => ((await (await call(computer.token, "GET", "/v1/targets")).json()) as { targets: { id: string }[] }).targets.map((t) => t.id);
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 1, removed: 2, failed: 1 });
    expect(await ids()).toEqual(["live", "bad-token"]);
    // A wrong topic or a sandbox mix-up at our end looks the same as a bad token: it takes three in a row.
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 2 })).json()).toEqual({ sent: 1, removed: 0, failed: 1 });
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 3 })).json()).toEqual({ sent: 1, removed: 1, failed: 0 });
    expect(await ids()).toEqual(["live"]);
  });

  it("a phone that registers again starts its bad-token count over", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken("bad0"), env: "sandbox" })).status).toBe(204);
    for (let i = 0; i < 2; i++) await call(phone.token, "POST", "/v1/notify", { badge: i + 1 });
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken("bad0"), env: "production" })).status).toBe(204);
    expect(await (await call(phone.token, "POST", "/v1/notify", { badge: 3 })).json()).toEqual({ sent: 0, removed: 0, failed: 1 });
  });

  it("gives up on a push service that does not answer, and still sends to the others", async () => {
    const account = uniqueAccount();
    const slow = await device(account, "slow-phone");
    const fine = await device(account, "phone");
    await call(slow.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken("51ee"), env: "production" });
    await call(fine.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" });
    const started = Date.now();
    expect(await (await call(fine.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 1, removed: 0, failed: 1 });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("stamps provider tokens on a shared 40-minute boundary, so every Worker instance agrees", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const token = apnsToken();
    await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token, env: "production" });
    const before = await logLength();
    await call(phone.token, "POST", "/v1/notify", { badge: 1 });
    const sent = (await since(before)).find((e) => e.token === token)!;
    const claims = JSON.parse(atob(sent.providerToken!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { iat: number };
    expect(claims.iat % 2400).toBe(0);
    expect(Date.now() / 1000 - claims.iat).toBeLessThan(2400 + 5);
  });

  it("retries once with a fresh provider token when APNs says it expired", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone");
    const token = apnsToken("e1e1");
    await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token, env: "production" });
    const before = await logLength();
    expect(await (await call(phone.token, "POST", "/v1/notify", { badge: 2 })).json()).toEqual({ sent: 1, removed: 0, failed: 0 });
    const tries = (await since(before)).filter((e) => e.token === token);
    expect(tries.map((e) => e.status)).toEqual([403, 200]);
    expect(tries[0]!.providerToken).not.toBe(tries[1]!.providerToken);
  });

  it("clears the badge quietly with a count of zero, and uses the sandbox for development builds", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "dev-phone");
    const token = apnsToken();
    await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", token, env: "sandbox" });
    const before = await logLength();
    await call(phone.token, "POST", "/v1/notify", { badge: 0 });
    const entry = (await since(before)).find((e) => e.token === token)!;
    expect(entry.url.startsWith("https://api.sandbox.push.apple.com/3/device/")).toBe(true);
    expect(entry.payload).toEqual({ aps: { badge: 0 } });
    expect(entry.priority).toBe("5");
  });

  it("refuses a count that is not a small whole number", async () => {
    const { token } = await device(uniqueAccount(), "computer");
    for (const badge of [-1, 1.5, "3", 100_000, null]) {
      expect((await call(token, "POST", "/v1/notify", { badge })).status).toBe(400);
    }
  });

  it("rate-limits an account's notifies", async () => {
    const { token } = await device(uniqueAccount(), "computer");
    const limited = callWith({ NOTIFY_RATE: new StepLimiter(3), API_RATE: new StepLimiter(100) });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await limited(token, "POST", "/v1/notify", { badge: i })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("an account's targets are its own", async () => {
    const mine = await device(uniqueAccount(), "phone");
    await call(mine.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" });
    const other = await device(uniqueAccount(), "computer");
    expect(await (await call(other.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(((await (await call(other.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toEqual([]);
  });
});

describe("the web companion's origin", () => {
  it("gets CORS on preflights and answers; other origins don't", async () => {
    const preflight = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/targets/self`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8790", "access-control-request-method": "PUT" } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    const answer = await exports.default.fetch(new Request(`${ORIGIN}/v1/vapid`, { headers: { origin: "http://127.0.0.1:8790" } }));
    expect(answer.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
    const other = await exports.default.fetch(new Request(`${ORIGIN}/v1/vapid`, { headers: { origin: "https://elsewhere.test" } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
