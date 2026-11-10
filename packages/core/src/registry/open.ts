// The registry as the daemon opens it: its records in `<cloverHome>/plugins-state/`, the plugins folder
// `<cloverHome>/plugins/` watched with its settle, the app's bundled plugins, and OK cards through the approval
// broker when there is one.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { registerPluginLoadFolders } from "../runtime-sdk/plugin-load-folders";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { Os } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { SecretStore } from "../contracts/secret-store";
import { codeFieldsFrom } from "./changes";
import { RegistryCore } from "./core";
import { PluginFolders } from "./folders";
import { brokerOkCards, type OkCardBroker } from "./ok-cards";
import { pluginFenceAvailable } from "./plugin-fence";
import { fileRegistryStore } from "./state";

export interface OpenRegistryOptions {
  cloverHome: string;
  os: Os;
  /** The app's read-only plugin folders. */
  bundledDirs?: readonly string[];
  broker?: OkCardBroker;
  /** Holds the key that signs the registry's records (`plugins-state/`), made on first open, and each file's write
   *  counter. Required (#197's check 2): only a test may open the registry unsigned, with `unsigned: true`. */
  secrets?: SecretStore;
  unsigned?: boolean;
  settleMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Called on this computer when the user approves a plugin's OK card here (`brokerOkCards`'s `onApproved`). */
  onOkApproved?: (pluginId: string) => void;
  /** Whether plugin processes here run fenced to their network proxy, which the OK then says (#371's review). Default:
   *  macOS with its sandbox there (the plugin host's own default); the daemon passes false when it runs them unfenced. */
  hostNetworkHeld?: boolean;
  /** Whether plugin processes here run in the plugin fence, which the OK says when they don't (#406's review). Default:
   *  the fence is there (`pluginFenceAvailable`). */
  sandboxed?: boolean;
}

export interface OpenedRegistry {
  registry: RegistryCore;
  folders: PluginFolders;
  close(): void;
}

/** The secret store's item for the key that signs the registry's records. */
export const REGISTRY_MAC_SECRET = { owner: { kind: "core" as const }, name: "plugin-registry:mac" };

/** The secret store's item for each file's write counter. */
export const REGISTRY_COUNTERS_SECRET = { owner: { kind: "core" as const }, name: "plugin-registry:counters" };

/** The key and the write counters, from the secret store; each write's counters are kept there in order. */
export async function registrySigning(secrets: SecretStore): Promise<{ macKey: Uint8Array; counters: Record<string, number>; onCounters: (c: Record<string, number>) => void }> {
  const macKey = await registryMacKey(secrets);
  const held = await secrets.get(REGISTRY_COUNTERS_SECRET);
  let counters: Record<string, number> = {};
  try {
    const parsed = held ? JSON.parse(held.value.reveal()) : {};
    if (parsed && typeof parsed === "object") counters = parsed as Record<string, number>;
  } catch {
    counters = {};
  }
  let chain: Promise<unknown> = Promise.resolve();
  const onCounters = (c: Record<string, number>) => {
    chain = chain.then(() => secrets.set(REGISTRY_COUNTERS_SECRET, JSON.stringify(c), { synced: false })).catch(() => undefined);
  };
  return { macKey, counters, onCounters };
}

/** The key that signs the registry's records: 32 random bytes, kept in the secret store and synced with the list. */
export async function registryMacKey(secrets: SecretStore): Promise<Uint8Array> {
  const held = await secrets.get(REGISTRY_MAC_SECRET);
  if (held) return new Uint8Array(Buffer.from(held.value.reveal(), "base64"));
  const key = randomBytes(32);
  await secrets.set(REGISTRY_MAC_SECRET, key.toString("base64"), { synced: true });
  return new Uint8Array(key);
}

/** Opens the registry, reads every folder once, then watches. */
export async function openPluginRegistry(o: OpenRegistryOptions): Promise<OpenedRegistry> {
  if (!o.secrets && !o.unsigned) throw new ContractError("invalid", "the plugin registry needs the secret store, which holds the key its records are signed with");
  const signing = o.secrets ? await registrySigning(o.secrets) : undefined;
  const store = fileRegistryStore(join(o.cloverHome, "plugins-state"), {
    ...(signing ?? {}),
    onTampered: (file) => o.log?.(`plugins: ${file} was changed outside Clover, so it isn't trusted; plugins ask for their OK again`),
  });
  const hostNetworkHeld = o.hostNetworkHeld ?? (o.os === "macos" && pluginFenceAvailable());
  const sandboxed = o.sandboxed ?? pluginFenceAvailable();
  let folders: PluginFolders | undefined;
  const registry = new RegistryCore({
    catalog: catalogPointDecl,
    store,
    ...(o.now ? { now: o.now } : {}),
    ...(o.broker ? { cards: brokerOkCards(o.broker, (id) => folders!.okText(id, o.os, hostNetworkHeld, sandboxed), o.onOkApproved, o.log) } : {}),
    onOk: (id, hash) => folders?.okGiven(id, hash),
  });
  folders = new PluginFolders({
    core: registry, store, pluginsDir: join(o.cloverHome, "plugins"),
    // A point's code fields from the catalog's declaration, or its declarer's; none at all counts as code whole.
    codeFieldsOf: (point) => codeFieldsFrom(catalogPointDecl(point) ?? registry.points().find((p) => p.name === point)?.decl),
    ...(o.bundledDirs ? { bundledDirs: o.bundledDirs } : {}),
    ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
    ...(o.now ? { now: o.now } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  // Where plugin code loads from, for the fence's `node_modules` denies (#234's check 5, K3): the development folders,
  // read live, and the bundled plugins.
  const unregisterLoadFolders = registerPluginLoadFolders(o.cloverHome, () => [...(o.bundledDirs ?? []), ...folders!.devFolderPaths()]);
  folders.start();
  await folders.scan();
  return { registry, folders, close: () => { unregisterLoadFolders(); folders!.stop(); } };
}
