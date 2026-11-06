// The registry as the daemon opens it: its records in `<cloverHome>/plugins-state/`, the plugins folder
// `<cloverHome>/plugins/` watched with its settle, the app's bundled plugins, and OK cards through the approval
// broker when there is one.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { Os } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { SecretStore } from "../contracts/secret-store";
import { codeFieldsFrom } from "./changes";
import { RegistryCore } from "./core";
import { PluginFolders } from "./folders";
import { brokerOkCards } from "./ok-cards";
import { fileRegistryStore } from "./state";

export interface OpenRegistryOptions {
  cloverHome: string;
  os: Os;
  /** The app's read-only plugin folders. */
  bundledDirs?: readonly string[];
  broker?: ApprovalBroker;
  /** Holds the key that signs the registry's records (`plugins-state/`), made on first open. */
  secrets?: SecretStore;
  settleMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OpenedRegistry {
  registry: RegistryCore;
  folders: PluginFolders;
  close(): void;
}

/** The secret store's item for the key that signs the registry's records. */
export const REGISTRY_MAC_SECRET = { owner: { kind: "core" as const }, name: "plugin-registry:mac" };

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
  const macKey = o.secrets ? await registryMacKey(o.secrets) : undefined;
  const store = fileRegistryStore(join(o.cloverHome, "plugins-state"), {
    ...(macKey ? { macKey } : {}),
    onTampered: (file) => o.log?.(`plugins: ${file} was changed outside Clover, so it isn't trusted; plugins ask for their OK again`),
  });
  let folders: PluginFolders | undefined;
  const registry = new RegistryCore({
    catalog: catalogPointDecl,
    store,
    ...(o.now ? { now: o.now } : {}),
    ...(o.broker ? { cards: brokerOkCards(o.broker, (id) => folders!.okText(id, o.os)) } : {}),
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
  folders.start();
  await folders.scan();
  return { registry, folders, close: () => folders!.stop() };
}
