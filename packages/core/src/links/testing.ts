// Test support: several devices with real keys, each with its own LinkTransport, joined by the in-memory wire. Each
// device's registry pairs it with the others unless a test says not to; revoking goes through it.
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { DeviceChange, DeviceRecord } from "../contracts/device-registry";
import { DeviceKey } from "../identity/device-key";
import { toBase64 } from "../identity/bytes";
import { generateEd25519 } from "../identity/keys";
import { MemoryNetwork, type MemoryEndpoint } from "./memory-wire";
import { CloverLinkTransport, type DialPlanner, type LinkTransportOptions } from "./transport";
import type { DialTarget } from "./wire";

/** A registry view a transport reads: who is paired, and revocations. */
export class PairedSet {
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #listeners = new Listeners<DeviceChange>();

  add(record: DeviceRecord): void {
    this.#devices.set(record.id, { ...record });
    this.#listeners.emit({ type: "added", device: { ...record } });
  }

  revoke(id: string): void {
    const d = this.#devices.get(id);
    if (!d) throw new ContractError("not_found", id);
    d.revokedAt = Date.now();
    this.#listeners.emit({ type: "revoked", id });
  }

  get(id: string): DeviceRecord | undefined {
    const d = this.#devices.get(id);
    return d ? { ...d } : undefined;
  }

  watch(fn: (c: DeviceChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}

export interface ClusterDevice {
  name: string;
  key: DeviceKey;
  id: string;
  endpoint: MemoryEndpoint;
  paired: PairedSet;
  transport: CloverLinkTransport;
}

export async function makeDeviceKey(): Promise<DeviceKey> {
  return DeviceKey.fromKey(generateEd25519());
}

export function recordFor(key: DeviceKey, name: string): DeviceRecord {
  return { id: key.id, name, kind: "desktop", runsCore: true, computer: name, publicKey: toBase64(key.publicKey), addedAt: 0, addedBy: "terminal" };
}

/** Devices named `names`, each paired with every other one (unless `pairAll` is false), on one memory network. */
export async function makeLinkCluster(
  names: readonly string[],
  opts: { clock: Clock; net?: MemoryNetwork; pairAll?: boolean; planner?: DialPlanner; transport?: Partial<LinkTransportOptions> },
): Promise<{ net: MemoryNetwork; devices: Map<string, ClusterDevice>; pair(a: string, b: string): void; close(): Promise<void> }> {
  const net = opts.net ?? new MemoryNetwork();
  const keys = new Map<string, DeviceKey>();
  for (const n of names) keys.set(n, await makeDeviceKey());
  const devices = new Map<string, ClusterDevice>();
  const byId = new Map<string, DeviceKey>();
  for (const k of keys.values()) byId.set(k.id, k);
  for (const name of names) {
    const key = keys.get(name)!;
    const paired = new PairedSet();
    paired.add({ ...recordFor(key, name), addedBy: "self" });
    const endpoint = net.endpoint(key.publicKey);
    const transport = new CloverLinkTransport({
      self: key.id,
      wire: endpoint,
      registry: paired,
      directory: {
        target(device: string): DialTarget | undefined {
          const k = byId.get(device);
          return k ? { key: k.publicKey, relay: "https://relay.test/" } : undefined;
        },
      },
      clock: opts.clock,
      ...(opts.planner ? { planner: opts.planner } : {}),
      ...opts.transport,
    });
    devices.set(name, { name, key, id: key.id, endpoint, paired, transport });
  }
  const pair = (a: string, b: string) => {
    const da = devices.get(a)!;
    const db = devices.get(b)!;
    da.paired.add(recordFor(db.key, b));
    db.paired.add(recordFor(da.key, a));
  };
  if (opts.pairAll !== false) for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pair(names[i]!, names[j]!);
  return {
    net,
    devices,
    pair,
    async close() {
      for (const d of devices.values()) await d.transport.close();
    },
  };
}
