// The Cloudflare relay plugin's host half (clover/relay-cloudflare). It starts on each device that uses the relay
// (host.start "each") and fills its `relays` entry: the link layer asks it where the relay is, and keeps sealed sync
// mail there for a device that is away (spec §8.3). It never touches a link's traffic or holds the relay's key.

import { RelayClient } from "../src/client";
import type { HostApi } from "./api";

let client: RelayClient | null = null;

export function start(api: HostApi): void {
  client = new RelayClient({
    origin: async () => (await api.settings.get<string>("origin")) ?? undefined,
    fetch: (url, init) => api.net.fetch(url, init, { auth: "relay-key" }),
    device: api.device.id,
  });
}

export function stop(): void {
  client = null;
}

function live(): RelayClient {
  if (!client) throw new Error("the Cloudflare relay plugin is not running on this device");
  return client;
}

/** The `relays` entry's handler (lane B's RelayHandler, without `serve`: this relay runs in the user's account). */
export const relay = {
  endpoints: async () => ({ endpoints: await live().endpoints() }),
  putMail: async (args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }) => {
    await live().putMail(args);
    return {};
  },
  takeMail: async (args?: { max?: number }) => ({ mail: await live().takeMail(args ?? {}) }),
  ackMail: async (args: { ids: string[] }) => {
    await live().ackMail(args);
    return {};
  },
};
