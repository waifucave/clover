// The waifucave push plugin's host half (clover/push). Its `notifiers` entry runs on the main computer, or the
// takeover computer while the main is offline (spec §5.2); the core starts it when it is first needed.
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   notifier              the handler of this plugin's `notifiers` entry (clover.json)

import { PushNotifier, type Notification } from "../src/notifier";
import type { HostApi } from "./api";

export const DEFAULT_ORIGIN = "https://push.waifucave.com";

let current: PushNotifier | null = null;

export async function start(api: HostApi): Promise<void> {
  if (current) return;
  const storage = api.storage;
  current = new PushNotifier({
    origin: api.env?.CLOVER_PUSH_ORIGIN ?? DEFAULT_ORIGIN,
    fetch: (url, init) => api.net.fetch(url, init, { auth: "waifucave" }),
    ...(storage
      ? {
          store: {
            get: async () => {
              const value = await storage.get("unseen");
              return typeof value === "number" ? value : null;
            },
            set: (count: number) => storage.set("unseen", count),
          },
        }
      : {}),
    log: (level, message) => api.log[level](`push: ${message}`),
  });
}

export async function stop(): Promise<void> {
  current?.stop();
  current = null;
}

function live(): PushNotifier {
  if (!current) throw new Error("waifucave push is not running on this computer");
  return current;
}

/** The `notifiers` handler: the core calls notify when something happens for the user, clear when they catch up. */
export const notifier = {
  notify: (notification?: Notification) => live().notify(notification),
  clear: () => live().clear(),
};
