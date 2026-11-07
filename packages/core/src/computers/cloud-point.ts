// The `computer` point (spec §9.2; plan §4 J, M3): the cloud computer folders the plugin registry holds, and the
// `computerProviders` handlers that make their VMs, wired into `CloudComputers`.
//
// * A folder is a plugin whose `computer` entry is active. One that is still there but off, or waiting for the user's
//   OK, is held: its VM is left alone, neither changed nor asked about. Only a folder that is gone asks about
//   deleting its VM.
// * A provider is the active `computerProviders` entry with that id; the core calls its handler (an object with
//   `create`, `resize`, `delete` and `status`) through the plugin host, on the main computer, as the core. The handler
//   reaches its cloud only through the keyed fetch, with the user's own credentials.
// * Every change in the registry, and every change of the lease, runs one reconcile after the one in flight, never two
//   at once. Only the lease's holder acts (lane H's lease, not the registry's main flag: #254's review, B1).
import { isContractError, type Unsubscribe } from "../contracts/common";
import type { Lease } from "../contracts/lease";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { CloudAuthority, CloudComputers, CloudFolder, CloudPairingDoor, CloudProviderHandler, ReconcileResult } from "./cloud";

/** Lane H's lease as the cloud's authority: this device acts while it can and holds the lease, and its tenure is the
 *  lease's scope and epoch, so a change started under one epoch never finishes under another. */
export function leaseAuthority(lease: Lease): CloudAuthority {
  return {
    canAct: () => lease.canAct(),
    tenure: () => {
      const s = lease.state();
      return s.holder === lease.self ? `${s.scope ?? "-"}:${s.epoch}` : undefined;
    },
  };
}

const none = (): ReconcileResult => ({ created: [], adopted: [], resized: [], deleted: [], repaired: [], declined: [], failed: [], duplicates: [] });

/** How long a provider call may take: a VM's create or resize waits for the cloud's own actions. */
export const PROVIDER_CALL_TIMEOUT_MS = 10 * 60_000;

interface ComputerValue {
  provider: string;
  name: string;
  size: string;
  region: string;
  image?: string;
  makeMain?: "ask" | "no";
  onRemove?: "ask" | "keep";
}

/** The folders there are now, and the folders that are there but off or waiting (`held`). */
export function cloudFolders(registry: PluginRegistry): { folders: CloudFolder[]; held: Set<string> } {
  const folders: CloudFolder[] = [];
  const active = new Set<string>();
  for (const c of registry.entries("computer")) {
    if (c.state !== "active") continue;
    const v = c.value as ComputerValue;
    active.add(c.pluginId);
    folders.push({
      folder: c.pluginId, provider: v.provider, name: v.name, size: v.size, region: v.region,
      ...(v.image ? { image: v.image } : {}), ...(v.makeMain ? { makeMain: v.makeMain } : {}), ...(v.onRemove ? { onRemove: v.onRemove } : {}),
    });
  }
  // Any plugin still listed that isn't an active folder: off, waiting, refused or stopped. Its folder is there.
  const held = new Set(registry.list().map((r) => r.id).filter((id) => !active.has(id)));
  return { folders, held };
}

/** The ids of the active `computerProviders` entries. */
export function providerIds(registry: PluginRegistry): string[] {
  return registry.entries("computerProviders").flatMap((c) => (c.state === "active" && c.entryId ? [c.entryId] : []));
}

/** The active `computerProviders` handler with that id, called through the plugin host. */
export function pluginProviders(registry: PluginRegistry, host: PluginHost): (id: string) => CloudProviderHandler | undefined {
  return (id) => {
    const entry = registry.entries("computerProviders").find((c) => c.state === "active" && c.entryId === id);
    if (!entry) return undefined;
    const { pluginId } = entry;
    const handler = (entry.value as { handler: string }).handler;
    const call = <R>(method: keyof CloudProviderHandler, args: unknown, signal?: AbortSignal) =>
      host.invoke<R>({ pluginId, handler, method, args, caller: { kind: "core" }, timeoutMs: PROVIDER_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return {
      create: (a, ctx) => call("create", a, ctx?.signal),
      list: (a, ctx) => call("list", a, ctx?.signal),
      resize: (a, ctx) => call("resize", a, ctx?.signal),
      delete: (a, ctx) => call("delete", a, ctx?.signal),
      status: (a, ctx) => call("status", a, ctx?.signal),
      // A provider without `paired` (Hetzner, whose user-data stays): the plugin host has no such handler; fine.
      paired: (a, ctx) => call<void>("paired", a, ctx?.signal).catch((e: unknown) => {
        if (isContractError(e, "not_installed") && /has no handler/.test((e as Error).message)) return;
        throw e;
      }),
    };
  };
}

/** Keeps `CloudComputers` in line with the registry: one reconcile at a time, and one more after it when anything
 *  changed meanwhile. */
export class CloudPoint {
  readonly #registry: PluginRegistry;
  readonly #cloud: CloudComputers;
  readonly #log: ((line: string) => void) | undefined;
  readonly #active: () => boolean;
  #running: Promise<ReconcileResult> | undefined;
  #again = false;

  /** `active`: whether this computer acts on cloud computers now (the lease's holder alone); a sync on any other does
   *  nothing. `CloudComputers` checks its own authority again around every card and provider call. */
  constructor(o: { registry: PluginRegistry; cloud: CloudComputers; active: () => boolean; log?: (line: string) => void }) {
    this.#active = o.active;
    this.#registry = o.registry;
    this.#cloud = o.cloud;
    this.#log = o.log;
  }

  /** Watches the registry; the first sync runs at once. */
  start(): Unsubscribe {
    const off = this.#registry.watch(() => void this.sync());
    void this.sync();
    return off;
  }

  /** One reconcile, after the one in flight (and only one more, however many changes came meanwhile). */
  sync(): Promise<ReconcileResult> {
    if (!this.#active()) return Promise.resolve(none());
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const run = async (): Promise<ReconcileResult> => {
      let last = none();
      do {
        this.#again = false;
        if (!this.#active()) break;
        const { folders, held } = cloudFolders(this.#registry);
        last = await this.#cloud.reconcile(folders, held);
        for (const f of last.failed) this.#log?.(`cloud computer ${f.name} not changed: ${f.reason}`);
      } while (this.#again);
      return last;
    };
    const p = run().finally(() => {
      this.#running = undefined;
    });
    this.#running = p;
    return p;
  }

  /** What lane H's authenticated pairing door calls when a device presents a cloud computer's token. */
  door(): CloudPairingDoor {
    return this.#cloud.door(() => cloudFolders(this.#registry).folders);
  }
}
