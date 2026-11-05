// One computer's part of the folder tree, put together (plan §4 J, M1): the computer registry, the hello over the link,
// this computer's holder and the service that serves it to the others, the tree that routes every call to the
// computer holding its files, and the tool layer the runtime calls. The daemon builds one of these once it has a
// link (lane H's `LinkTransport`); tests build several on the fake link, each on its own temp home.
import { join } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { AnswerDevices, AnswerLedger, CallCardRenderer } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import type { DeviceRegistry } from "../contracts/device-registry";
import type { Fence } from "../contracts/fence";
import type { LinkTransport } from "../contracts/link-transport";
import { LocalHolder, type Holder } from "../tree/holder";
import { hostOs } from "../tree/names";
import { RemoteHolder } from "../tree/remote";
import { ensureTreeRoot } from "../tree/root";
import { TreeService, type ToolExecutor } from "../tree/service";
import { TreeTools } from "../tree/tools";
import { CoreTree } from "../tree/tree";
import { FolderWatches } from "../tree/watch";
import { ComputerPeers } from "./peers";
import { CoreComputerRegistry, type SelfStateStore } from "./registry";
import { FileSelfStateStore, selfStatePath } from "./store";

export interface ComputerNodeOptions {
  clock: Pick<Clock, "now">;
  transport: LinkTransport;
  /** This computer: its name in the tree and its device id (the link's). */
  self: { name: string; device: string; os?: Os; hasDisplay?: boolean; agents?: string[] };
  /** The user's home folder: `home/<this computer>/`. */
  home: string;
  /** The Clover home: the bots' folders (`bots/`) and this computer's own entry (`levels/computer.json`). */
  cloverHome: string;
  fence?: Pick<Fence, "check">;
  /** The paired devices (lane H); without it a hello introduces its computer (tests). */
  devices?: DeviceRegistry;
  /** What checks a signed answer here: the paired devices, the ledger of card ids used, this computer's own cards. */
  answers?: { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer };
  /** The bots this computer runs (lane D). */
  bots?: () => string[];
  /** Bash here, for this computer's own calls and the others' `tool.run` (lanes A and C). */
  executor?: ToolExecutor;
  store?: SelfStateStore;
  /** This computer's tree folder (`defaultTreeRoot()`), made and kept: `home/<this computer>` links to the home
   *  folder, `bots/` to the bots' folder. Left out, no folder is made (tests). */
  treeRoot?: string;
  log?: (line: string) => void;
}

export interface ComputerNode {
  registry: CoreComputerRegistry;
  peers: ComputerPeers;
  holder: LocalHolder;
  service: TreeService;
  tree: CoreTree;
  tools: TreeTools;
  /** Settles once the tree folder is made (at once without `treeRoot`). */
  treeRootReady(): Promise<void>;
  close(): void;
}

export function startComputerNode(o: ComputerNodeOptions): ComputerNode {
  const os = o.self.os ?? hostOs();
  const registry = new CoreComputerRegistry({
    clock: o.clock,
    self: { name: o.self.name, device: o.self.device, os, hasDisplay: o.self.hasDisplay ?? true, agents: o.self.agents ?? [] },
    store: o.store ?? new FileSelfStateStore(selfStatePath(o.cloverHome)),
    ...(o.answers ? { devices: o.answers.devices, ledger: o.answers.ledger, render: o.answers.render } : {}),
  });
  const botsRoot = join(o.cloverHome, "bots");
  const bots = o.bots ?? (() => []);
  const peers = new ComputerPeers({
    registry, transport: o.transport, roots: () => ({ home: o.home, botsRoot, os, bots: bots() }),
    ...(o.devices ? { devices: o.devices } : {}), ...(o.log ? { log: o.log } : {}),
  });
  const holder = new LocalHolder({
    clock: o.clock,
    name: () => registry.self().name,
    aliases: () => registry.self().aliases,
    home: o.home,
    botsRoot,
    runsBot: (bot) => bots().includes(bot),
    os,
    level: () => registry.self().level,
    watches: new FolderWatches(),
    ...(o.fence ? { fence: o.fence } : {}),
    ...(o.answers ? { answers: o.answers } : {}),
  });
  const mayCall = o.devices
    ? (device: string) => {
      const d = o.devices!.get(device);
      return d !== undefined && d.revokedAt === undefined && d.runsCore;
    }
    : undefined;
  const service = new TreeService({
    transport: o.transport, holder, clock: o.clock, level: () => registry.self().level,
    ...(mayCall ? { mayCall } : {}), ...(o.answers ? { answers: o.answers } : {}), ...(o.executor ? { tools: o.executor } : {}),
  });
  const remotes = new Map<string, RemoteHolder>();
  const holderFor = (name: string): Holder => {
    const c = registry.get(name);
    if (!c) throw new ContractError("not_found", `no computer ${name}`);
    if (c.name === registry.self().name) return holder;
    let r = remotes.get(c.device);
    if (!r) {
      const device = c.device;
      r = new RemoteHolder({ transport: o.transport, device, computer: () => registry.byDevice(device)?.name ?? device });
      remotes.set(device, r);
    }
    return r;
  };
  const directory = peers.directory();
  const tree = new CoreTree({ directory, holder: holderFor, botComputer: (bot) => peers.botComputer(bot) });
  const tools = new TreeTools({
    tree, directory, transport: o.transport,
    deviceOf: (name) => registry.get(name)?.device,
    ...(o.executor ? { local: { holder, executor: o.executor } } : {}),
  });
  let rootReady: Promise<void> = Promise.resolve();
  let offRoot = () => {};
  if (o.treeRoot !== undefined) {
    const root = o.treeRoot;
    const make = () => {
      rootReady = rootReady.then(() => ensureTreeRoot({ root, self: registry.self().name, home: o.home, botsRoot, os }))
        .catch((e) => o.log?.(`tree: the tree folder at ${root} can't be made: ${(e as Error).message}`));
    };
    make();
    let name = registry.self().name;
    // A rename moves this computer's own link in the tree folder.
    offRoot = registry.watch((change) => {
      if (change.type !== "computer" || change.computer.device !== o.self.device || change.computer.name === name) return;
      name = change.computer.name;
      make();
    });
  }
  return {
    registry, peers, holder, service, tree, tools,
    treeRootReady: () => rootReady,
    close: () => {
      offRoot();
      tools.close();
      service.close();
      for (const r of remotes.values()) r.close();
      holder.watches.close();
      peers.close();
    },
  };
}
