// The waifucave push notifier: one push per burst, only a count, retries for passing failures, and the count
// kept in the synced store.

import { describe, expect, test } from "bun:test";

import { PushNotifier, type Clock } from "../src/notifier";

class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    this.id += 1;
    this.timers.set(this.id, { at: this.t + ms, fn });
    return this.id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Response statuses in order; 0 is a network error, -1 a request that never answers, -2 "no account". */
function setup(responses: number[] = [], stored?: number) {
  const clock = new FakeClock();
  const requests: { url: string; body: string; method: string }[] = [];
  const logs: string[] = [];
  let saved = stored;
  const notifier = new PushNotifier({
    origin: "https://push.test",
    fetch: async (url, init = {}) => {
      requests.push({ url, body: String(init.body), method: init.method ?? "GET" });
      const status = responses.shift() ?? 200;
      if (status === 0) throw new Error("network down");
      if (status === -2) throw Object.assign(new Error("no waifucave account is signed in"), { code: "no_account" });
      if (status === -1) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        });
      }
      return new Response(status === 200 ? '{"sent":1,"removed":0,"failed":0}' : "{}", { status });
    },
    store: { get: async () => saved, set: async (n) => void (saved = n) },
    clock,
    log: (level, message) => logs.push(`${level}: ${message}`),
    requestTimeoutMs: 30,
  });
  return { clock, requests, notifier, logs, saved: () => saved };
}

describe("waifucave push notifier", () => {
  test("a burst of notifications becomes one push of the count, after a short wait", async () => {
    const t = setup();
    await t.notifier.notify({ title: "Alpha", body: "the secret plan" });
    await t.notifier.notify({ title: "Alpha", body: "more" });
    await t.notifier.notify({ kind: "approval" });
    expect(t.requests).toHaveLength(0);
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ url: "https://push.test/v1/notify", method: "POST", body: '{"badge":3}' }]);
  });

  test("sends nothing but the count", async () => {
    const t = setup();
    await t.notifier.notify({ title: "Alpha replied", body: "deploy the thing", bot: "alpha", session: "s1" });
    await t.clock.advance(2_000);
    expect(JSON.parse(t.requests[0]!.body)).toEqual({ badge: 1 });
  });

  test("takes the core's own count when it has one", async () => {
    const t = setup();
    await t.notifier.notify({ unseen: 7 });
    await t.clock.advance(2_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":7}']);
  });

  test("clearing sends a zero promptly; an unchanged count is not sent again", async () => {
    const t = setup();
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await t.notifier.clear();
    await t.clock.advance(0);
    await t.notifier.clear();
    await t.clock.advance(5_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":1}', '{"badge":0}']);
  });

  test("retries a passing failure with backoff, then gives up until the next notification", async () => {
    const t = setup([503, 0, 429, 503, 503]);
    await t.notifier.notify();
    await t.clock.advance(2_000); // 503
    await t.clock.advance(5_000); // network error
    await t.clock.advance(10_000); // 429
    await t.clock.advance(20_000); // 503
    await t.clock.advance(40_000); // 503: the fifth try
    expect(t.requests).toHaveLength(5);
    await t.clock.advance(600_000);
    expect(t.requests).toHaveLength(5);
    expect(t.logs.some((l) => l.includes("gave up"))).toBe(true);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests.at(-1)!.body).toBe('{"badge":2}');
  });

  test("does not retry a refusal", async () => {
    const t = setup([401]);
    await t.notifier.notify();
    await t.clock.advance(300_000);
    expect(t.requests).toHaveLength(1);
    expect(t.logs.some((l) => l.startsWith("error"))).toBe(true);
  });

  test("keeps the count in the store across restarts", async () => {
    const first = setup([], 4);
    await first.notifier.notify();
    expect(first.saved()).toBe(5);
    const again = setup([], first.saved());
    await again.notifier.notify();
    await again.clock.advance(2_000);
    expect(again.requests[0]!.body).toBe('{"badge":6}');
  });

  test("abandons a push that never answers, and is not stuck: the retry goes out", async () => {
    const t = setup([-1]);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await new Promise((r) => setTimeout(r, 80)); // the request's own timeout runs on real time
    await t.clock.advance(5_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":1}', '{"badge":1}']);
  });

  test("with no account signed in it neither sends nor retries, and says so once", async () => {
    const t = setup([-2, -2]);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await t.clock.advance(600_000);
    expect(t.requests).toHaveLength(1);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests).toHaveLength(2);
    expect(t.logs.filter((l) => l.includes("no waifucave account"))).toHaveLength(1);
    expect(t.saved()).toBe(2);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests.at(-1)!.body).toBe('{"badge":3}');
  });

  test("stop cancels a pending push", async () => {
    const t = setup();
    await t.notifier.notify();
    t.notifier.stop();
    await t.clock.advance(10_000);
    expect(t.requests).toHaveLength(0);
  });
});
