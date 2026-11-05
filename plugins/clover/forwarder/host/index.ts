// The forwarder plugin's host half (clover/forwarder). It starts on each computer (host.start "each"), since
// each computer receives the webhooks of the routines whose files it holds (spec §7).
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   ingress               the handler of this plugin's `webhook.ingress` entry (clover.json)

import { ForwarderClient } from "../src/client";
import { WebhookIngress } from "../src/ingress";
import type { HostApi } from "./api";

export const DEFAULT_ORIGIN = "https://hooks.waifucave.com";
const KEY_SECRET = "forwarder-key";

let client: ForwarderClient | null = null;
let current: WebhookIngress | null = null;

export async function start(api: HostApi): Promise<void> {
  if (client) return;
  const origin = api.env?.CLOVER_HOOKS_ORIGIN ?? DEFAULT_ORIGIN;
  let ingressRef: WebhookIngress | null = null;
  client = new ForwarderClient({
    origin,
    fetch: (url, init) => api.net.fetch(url, init, { auth: "waifucave" }),
    secret: {
      get: async () => (await api.secrets.get(KEY_SECRET)) ?? null,
      set: (value) => api.secrets.set(KEY_SECRET, value),
    },
    ...(api.computer?.name ? { deviceName: api.computer.name } : {}),
    onDelivery: (delivery) => ingressRef?.accept(delivery),
    log: (level, message) => api.log[level](`forwarder: ${message}`),
  });
  ingressRef = new WebhookIngress(client);
  current = ingressRef;
  await client.start();
}

export async function stop(): Promise<void> {
  const running = client;
  client = null;
  current = null;
  await running?.stop();
}

function live(): WebhookIngress {
  if (!current) throw new Error("the forwarder is not running on this computer");
  return current;
}

/** The `webhook.ingress` handler: what the webhook trigger calls (see src/ingress.ts for each call). */
export const ingress = {
  register: (args: Parameters<WebhookIngress["register"]>[0]) => live().register(args),
  unregister: (args: Parameters<WebhookIngress["unregister"]>[0]) => live().unregister(args),
  list: () => live().list(),
  next: (args?: Parameters<WebhookIngress["next"]>[0]) => live().next(args),
  ack: (args: Parameters<WebhookIngress["ack"]>[0]) => live().ack(args),
  drop: (args: Parameters<WebhookIngress["drop"]>[0]) => live().drop(args),
};
