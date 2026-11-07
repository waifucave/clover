// The `computer` point (spec §9.2; plan §4 J, M3): the cloud computer folders the plugin registry holds, and the
// `computerProviders` handlers that make their VMs, wired into `CloudComputers`.
//
// * A folder is a plugin whose `computer` entry is active. One that is still there but off, or waiting for the user's
//   OK, is held: its VM is left alone, neither changed nor asked about. Only a folder that is gone asks about
//   deleting its VM.
// * A provider is the active `computerProviders` entry with that id; the core calls its handler (an object with
//   `create`, `resize`, `delete` and `status`) through the plugin host, on the main computer, as the core. The handler
//   reaches its cloud only through the keyed fetch, with the user's own credentials.
// * Every change in the registry runs one reconcile after the one in flight, never two at once.
import type { Unsubscribe } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { CloudComputers, CloudFolder, CloudProviderHandler, ReconcileResult } from "./cloud";

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
      resize: (a, ctx) => call("resize", a, ctx?.signal),
      delete: (a, ctx) => call("delete", a, ctx?.signal),
      status: (a, ctx) => call("status", a, ctx?.signal),
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

  /** `active`: whether this computer acts on cloud computers now (the main computer alone); a sync on any other does
   *  nothing. */
  constructor(o: { registry: PluginRegistry; cloud: CloudComputers; active?: () => boolean; log?: (line: string) => void }) {
    this.#active = o.active ?? (() => true);
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
    if (!this.#active()) return Promise.resolve({ created: [], resized: [], deleted: [], declined: [], failed: [] });
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const run = async (): Promise<ReconcileResult> => {
      let last: ReconcileResult = { created: [], resized: [], deleted: [], declined: [], failed: [] };
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

  /** The pair door's check of a VM's token, bound to the device the link authenticated (`PairingTokens.claim`). */
  claim(token: string, device: string): ReturnType<CloudComputers["pairing"]["claim"]> {
    return this.#cloud.pairing.claim(token, device);
  }

  /** Lane H's pairing hands over a VM's token once it paired: the computer it was made for, once. */
  paired(token: string, device?: string): Promise<string | null> {
    return this.#cloud.paired(token, cloudFolders(this.#registry).folders, device);
  }
}
