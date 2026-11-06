// The relay plugin's client (clover/relay-cloudflare) against this Worker: the keyed fetch is played by a fetch that
// adds the relay key, as the core would from the plugin's `auth` entry.

import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { RelayClient } from "@waifucave/clover-plugin-relay-cloudflare/client";

const keyedFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.RELAY_KEY}`);
  headers.set("cf-connecting-ip", "192.0.2.77");
  return exports.default.fetch(new Request(url, { ...init, headers }));
};

describe("the relay plugin against the relay", () => {
  test("its endpoint opens a room; mail goes from one device to another", async () => {
    const laptop = new RelayClient({ origin: async () => "https://relay.test", fetch: keyedFetch, device: "laptop" });
    const studio = new RelayClient({ origin: async () => "https://relay.test", fetch: keyedFetch, device: "studio" });
    const [endpoint] = await laptop.endpoints();
    expect(endpoint?.kind).toBe("websocket");
    const opened = await exports.default.fetch(
      new Request(`${endpoint!.url.replace(/^ws/, "http")}&room=plugin-room-0000001&peer=laptop`, { headers: { upgrade: "websocket" } }),
    );
    expect(opened.status).toBe(101);
    opened.webSocket!.accept();
    opened.webSocket!.close(1000, "done");

    const sealed = crypto.getRandomValues(new Uint8Array(512));
    await laptop.putMail({ to: "studio", id: "sync-1", sealed, expiresAt: Date.now() + 60_000 });
    const mail = await studio.takeMail();
    expect(mail).toEqual([{ id: "sync-1", sealed }]);
    await studio.ackMail({ ids: ["sync-1"] });
    expect(await studio.takeMail()).toEqual([]);
  });
});
