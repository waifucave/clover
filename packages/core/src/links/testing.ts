// Test support: several devices with real keys and real registries (`FileDeviceRegistry` in temp homes), each with
// its own LinkTransport, joined by the in-memory wire. Each device's registry pairs it with the others unless a test
// says not to; revoking goes through the registry, as it does in the core.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../contracts/clock";
import type { DeviceRecord } from "../contracts/device-registry";
import { FileDeviceRegistry } from "../devices/registry";
import { DeviceKey } from "../identity/device-key";
import { generateEd25519 } from "../identity/keys";
import { MemoryNetwork, type MemoryEndpoint } from "./memory-wire";
import { CloverLinkTransport, type DialPlanner, type LinkTransportOptions } from "./transport";
import type { DialTarget } from "./wire";

export interface ClusterDevice {
  name: string;
  key: DeviceKey;
  id: string;
  endpoint: MemoryEndpoint;
  registry: FileDeviceRegistry;
  transport: CloverLinkTransport;
}

export async function makeDeviceKey(): Promise<DeviceKey> {
  return DeviceKey.fromKey(generateEd25519());
}

export function recordFor(key: DeviceKey, name: string): Omit<DeviceRecord, "addedAt" | "addedBy" | "revokedAt"> {
  return { id: key.id, name, kind: "desktop", runsCore: true, computer: name, publicKey: key.publicKeyBase64 };
}

/** Devices named `names`, each paired with every other one (unless `pairAll` is false), on one memory network. */
export async function makeLinkCluster(
  names: readonly string[],
  opts: { clock: Clock; net?: MemoryNetwork; pairAll?: boolean; planner?: DialPlanner; transport?: Partial<LinkTransportOptions> },
): Promise<{ net: MemoryNetwork; devices: Map<string, ClusterDevice>; pair(a: string, b: string): Promise<void>; close(): Promise<void> }> {
  const net = opts.net ?? new MemoryNetwork();
  const keys = new Map<string, DeviceKey>();
  for (const n of names) keys.set(n, await makeDeviceKey());
  const devices = new Map<string, ClusterDevice>();
  const byId = new Map<string, DeviceKey>();
  for (const k of keys.values()) byId.set(k.id, k);
  for (const name of names) {
    const key = keys.get(name)!;
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "clover-h-cluster-")), key, clock: opts.clock, self: { name } });
    const endpoint = net.endpoint(key.publicKey);
    const transport = new CloverLinkTransport({
      self: key.id,
      wire: endpoint,
      registry,
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
    devices.set(name, { name, key, id: key.id, endpoint, registry, transport });
  }
  const pair = async (a: string, b: string) => {
    const da = devices.get(a)!;
    const db = devices.get(b)!;
    await da.registry.add(recordFor(db.key, b), { via: "terminal" });
    await db.registry.add(recordFor(da.key, a), { via: "terminal" });
  };
  if (opts.pairAll !== false) for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) await pair(names[i]!, names[j]!);
  return {
    net,
    devices,
    pair,
    async close() {
      for (const d of devices.values()) await d.transport.close();
    },
  };
}
