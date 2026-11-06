// The registry as the daemon opens it: its records in `<cloverHome>/plugins-state/`, the plugins folder
// `<cloverHome>/plugins/` watched with its settle, the app's bundled plugins, and OK cards through the approval
// broker when there is one.
import { join } from "node:path";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { Os } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
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
  settleMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OpenedRegistry {
  registry: RegistryCore;
  folders: PluginFolders;
  close(): void;
}

/** Opens the registry, reads every folder once, then watches. */
export async function openPluginRegistry(o: OpenRegistryOptions): Promise<OpenedRegistry> {
  const store = fileRegistryStore(join(o.cloverHome, "plugins-state"));
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
    ...(o.bundledDirs ? { bundledDirs: o.bundledDirs } : {}),
    ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
    ...(o.now ? { now: o.now } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  folders.start();
  await folders.scan();
  return { registry, folders, close: () => folders!.stop() };
}
