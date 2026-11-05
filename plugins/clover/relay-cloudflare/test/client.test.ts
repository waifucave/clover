import { describe, expect, test } from "bun:test";

import { relay, start, stop } from "../host/index";
import { RelayClient, RelayError } from "../src/client";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

function fakeRelay(handler: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = init.body === undefined || init.body === null ? null : typeof init.body === "string" ? init.body : new Uint8Array(init.body as ArrayBuffer);
    const seen = { url, method: init.method ?? "GET", headers, body };
    calls.push(seen);
    return handler(seen);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("endpoints", () => {
  test("a room URL with a ticket, fetched once and kept until an hour before it expires", async () => {
    let now = 1_000_000;
    let n = 0;
    const relayFake = fakeRelay(() => json({ url: `wss://relay.example/v1/rooms?ticket=v1.${++n}`, expiresAt: now + 24 * 3600_000 }));
    const client = new RelayClient({ origin: async () => "https://relay.example", fetch: relayFake.fetch, device: "laptop", now: () => now });
    expect(await client.endpoints()).toEqual([{ kind: "websocket", url: "wss://relay.example/v1/rooms?ticket=v1.1" }]);
    expect(await client.endpoints()).toEqual([{ kind: "websocket", url: "wss://relay.example/v1/rooms?ticket=v1.1" }]);
    expect(relayFake.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://relay.example/v1/tickets"]);
    now += 23.5 * 3600_000;
    expect((await client.endpoints())[0]!.url).toEndWith("v1.2");
  });

  test("no address set: no endpoints; a plain-http address off this machine is refused", async () => {
    const relayFake = fakeRelay(() => json({}));
    expect(await new RelayClient({ origin: async () => undefined, fetch: relayFake.fetch, device: "d" }).endpoints()).toEqual([]);
    expect(await new RelayClient({ origin: async () => "http://relay.example", fetch: relayFake.fetch, device: "d" }).endpoints()).toEqual([]);
    expect(relayFake.calls).toEqual([]);
  });

  test("a refused key says so, and the next call asks for a new ticket", async () => {
    let refuse = false;
    const relayFake = fakeRelay(() => (refuse ? new Response(null, { status: 401 }) : json({ url: "wss://r/v1/rooms?ticket=t", expiresAt: Date.now() + 86_400_000 })));
    const client = new RelayClient({ origin: async () => "https://r.example", fetch: relayFake.fetch, device: "d" });
    await client.endpoints();
    refuse = true;
    const err = await client.takeMail().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe("unauthorized");
    await expect(client.endpoints()).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("mail", () => {
  test("put sends the sealed bytes and expiry; take decodes; ack goes in batches of 256", async () => {
    const relayFake = fakeRelay((seen) => {
      if (seen.method === "GET") return json({ mail: [{ id: "m1", expiresAt: 5, sealed: "AQID" }] });
      return new Response(null, { status: seen.method === "PUT" ? 201 : 204 });
    });
    const client = new RelayClient({ origin: async () => "https://r.example/", fetch: relayFake.fetch, device: "phone" });
    await client.putMail({ to: "studio", id: "abc", sealed: new Uint8Array([9, 9]), expiresAt: 1234 });
    expect(relayFake.calls[0]).toMatchObject({ method: "PUT", url: "https://r.example/v1/mail/studio/abc", body: new Uint8Array([9, 9]) });
    expect(relayFake.calls[0]!.headers["x-expires-at"]).toBe("1234");
    expect(await client.takeMail({ max: 500 })).toEqual([{ id: "m1", sealed: new Uint8Array([1, 2, 3]) }]);
    expect(relayFake.calls[1]!.url).toBe("https://r.example/v1/mail/phone?max=64");
    await client.ackMail({ ids: Array.from({ length: 300 }, (_, i) => `m${i}`) });
    expect(relayFake.calls.filter((c) => c.url.endsWith("/ack"))).toHaveLength(2);
    await expect(client.putMail({ to: "bad id", id: "x", sealed: new Uint8Array(1), expiresAt: 1 })).rejects.toMatchObject({ code: "bad_request" });
  });

  test("a full mailbox and an oversized piece come back as their codes", async () => {
    let status = 409;
    const client = new RelayClient({ origin: async () => "https://r.example", fetch: fakeRelay(() => new Response(null, { status })).fetch, device: "d" });
    await expect(client.putMail({ to: "x", id: "y", sealed: new Uint8Array(1), expiresAt: 1 })).rejects.toMatchObject({ code: "full" });
    status = 413;
    await expect(client.putMail({ to: "x", id: "y", sealed: new Uint8Array(1), expiresAt: 1 })).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("the host half", () => {
  test("fills the relays entry through the keyed fetch with the plugin's auth entry", async () => {
    const auths: unknown[] = [];
    start({
      net: {
        fetch: async (_url, _init, options) => {
          auths.push(options?.auth);
          return json({ url: "wss://r/v1/rooms?ticket=t", expiresAt: Date.now() + 86_400_000 });
        },
      },
      settings: { get: async <T>() => "https://r.example" as T, watch: () => () => {} },
      device: { id: "laptop" },
    });
    expect(await relay.endpoints()).toEqual({ endpoints: [{ kind: "websocket", url: "wss://r/v1/rooms?ticket=t" }] });
    expect(auths).toEqual(["relay-key"]);
    stop();
    await expect(relay.endpoints()).rejects.toThrow("not running");
  });
});
