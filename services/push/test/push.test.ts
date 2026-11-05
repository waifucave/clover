// waifucave push against the local fakes of APNs and Web Push: registering phones and browsers, a
// content-free notify fanned out to each, dead targets removed, and the limits.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { apnsToken, call, device, fakeLog, subscriptions, uniqueAccount } from "./helpers";
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
    const bad = [
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

  it("forgets targets their push service reports gone, and keeps the rest", async () => {
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
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 1, removed: 3, failed: 0 });
    const listed = (await (await call(computer.token, "GET", "/v1/targets")).json()) as { targets: { id: string }[] };
    expect(listed.targets.map((t) => t.id)).toEqual(["live"]);
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
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) statuses.push((await call(token, "POST", "/v1/notify", { badge: i })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("an account's targets are its own", async () => {
    const mine = await device(uniqueAccount(), "phone");
    await call(mine.token, "PUT", "/v1/targets/self", { kind: "apns", token: apnsToken(), env: "production" });
    const other = await device(uniqueAccount(), "computer");
    expect(await (await call(other.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(((await (await call(other.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toEqual([]);
  });
});
