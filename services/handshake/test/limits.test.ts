import { describe, expect, test } from "vitest";

import { addressKey, ipv6Prefix64 } from "../../shared/web";
import { pairStatement, signText } from "../client";
import { StepLimiter } from "../../shared/testing/step-limiter";
import { client, freshAddress, newPairId, ORIGIN, registeredPair, signer, withLimiters, worker } from "./helpers";

async function registration(address: string, via: (request: Request) => Promise<Response>): Promise<number> {
  const pair = newPairId();
  const [a, b] = [await signer(), await signer()];
  const t = Date.now();
  const statement = pairStatement(pair, a.key, b.key, t);
  const body = JSON.stringify({ pair, keys: [a.key, b.key], t, sigs: [await signText(a, statement), await signText(b, statement)] });
  return (await via(new Request(`${ORIGIN}/v1/pairs`, { method: "POST", body, headers: { "cf-connecting-ip": address } }))).status;
}

// The limits run on StepLimiters in place of the runtime's bindings: no wall-clock minutes, no dependence on the
// runner's speed. The numbers deployed are wrangler.jsonc's.
describe("rate limits", () => {
  test("registration: limited per address, IPv6 counted per /64", async () => {
    const register = new StepLimiter(3);
    const via = withLimiters({ REGISTER_RATE: register });
    const statuses: number[] = [];
    // Four addresses in one /64 count as one.
    for (let i = 0; i < 4; i++) statuses.push(await registration(`2001:db8:1234:5678::${(i + 1).toString(16)}`, via));
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect(register.count("2001:db8:1234:5678::/64")).toBe(4);
    // The next /64 has its own budget, as does an IPv4 address.
    expect(await registration("2001:db8:1234:5679::1", via)).toBe(201);
    expect(await registration("203.0.113.9", via)).toBe(201);
    register.nextWindow();
    expect(await registration("2001:db8:1234:5678::9", via)).toBe(201);
  });

  test("addresses as keys", () => {
    const at = (ip: string) => addressKey(new Request("https://x", { headers: { "cf-connecting-ip": ip } }));
    expect(at("203.0.113.9")).toBe("203.0.113.9");
    expect(at("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(at("2001:0db8:0000:0042:abcd::1")).toBe("2001:db8:0:42::/64");
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0");
    expect(ipv6Prefix64("fe80::1%en0")).toBe("fe80:0:0:0");
  });

  test("a member's calls: limited per member and scope, before the object is called", async () => {
    const api = new StepLimiter(4);
    const via = withLimiters({ API_RATE: api, ADDRESS_RATE: new StepLimiter(100) });
    const { pair, a, b } = await registeredPair();
    const c = client(freshAddress(), via);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        await c
          .pair(pair, a)
          .get()
          .then(
            () => 200,
            (e: { status: number }) => e.status,
          ),
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // The other member has its own budget.
    await c.pair(pair, b).get();
    expect(api.count(`pair:${pair}|${a.key}`)).toBe(5);
  });

  test("signed calls per address: a stranger with fresh keys runs out", async () => {
    const via = withLimiters({ ADDRESS_RATE: new StepLimiter(2), API_RATE: new StepLimiter(100) });
    const { pair } = await registeredPair();
    const c = client("198.51.100.77", via);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push(await c.pair(pair, await signer()).get().then(() => 200, (e: { status: number }) => e.status));
    expect(statuses).toEqual([403, 403, 429]);
  });
});

describe("sizes", () => {
  test("a body over 16 KiB is refused before it is read", async () => {
    const { pair, a } = await registeredPair();
    const big = new Uint8Array(16 * 1024 + 1);
    const response = await worker(new Request(`${ORIGIN}/v1/pairs/${pair}/messages`, { method: "POST", body: big, headers: { authorization: `Clover-Sig key=${a.key}, t=${Date.now()}, sig=${"A".repeat(86)}` } }));
    expect(response.status).toBe(413);
  });
});

describe("cross-origin", () => {
  test("the web companion's origin gets CORS; others don't", async () => {
    const allowed = await worker(new Request(`${ORIGIN}/v1/pairs`, { method: "OPTIONS", headers: { origin: "https://clover.test", "access-control-request-method": "POST" } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://clover.test");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("authorization, content-type");

    const denied = await worker(new Request(`${ORIGIN}/v1/pairs`, { method: "OPTIONS", headers: { origin: "https://evil.test" } }));
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const { pair, a, c } = await registeredPair(client());
    await c.pair(pair, a).get();
    const answer = await worker(new Request(`${ORIGIN}/v1/pairs/${pair}`, { headers: { origin: "https://clover.test" } }));
    expect(answer.status).toBe(401);
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://clover.test");
    const other = await worker(new Request(`${ORIGIN}/v1/pairs/${pair}`, { headers: { origin: "https://evil.test" } }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
