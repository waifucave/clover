// One computer's part of the folder tree, put together (plan §4 J, M1): the computer registry, the hello over the link,
// this computer's holder and the service that serves it to the others, the tree that routes every call to the
// computer holding its files, and the tool layer the runtime calls. The daemon builds one of these once it has a
// link (lane H's `LinkTransport`); tests build several on the fake link, each on its own temp home.
import { mkdirSync } from "node:fs";
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
import { serveTransfer, transferAsking } from "../tree/transfer";
import { BulkSlots, TreeService, type ToolExecutor } from "../tree/service";
import { TreeTools } from "../tree/tools";
import type { AnswerAsker, PeerReviewer } from "../tree/judge";
import { LocalTerminals, serveTerminals, TerminalRouter, type ShellLauncher } from "../tree/terminals";
import { CoreTree } from "../tree/tree";
import { FolderWatches } from "../tree/watch";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { CloudComputers, FileCloudStateStore, type CloudCard } from "./cloud";
import { CloudPoint, pluginProviders } from "./cloud-point";
import { HoldRouter, serveHolds } from "./holds";
import { McpRouter, mirror, serveMirror, type McpCaller, type McpFields, type McpInstaller, type McpServerPlacement } from "./mcp";
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
  fence?: Pick<Fence, "check" | "fencedSet">;
  /** The paired devices (lane H): the computers in the tree and the only devices served (review minor 1). */
  devices: DeviceRegistry;
  /** What checks a signed answer here: the paired devices, the ledger of card ids used, this computer's own cards. */
  answers?: { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer };
  /** The bots this computer runs (lane D). */
  bots?: () => string[];
  /** Which computer runs a bot, from lane D's registry (review S2). Left out, the computers' hellos say, and a bot
   *  two computers claim is refused. */
  botPlacement?: (bot: string) => string | undefined;
  /** Bash here, for this computer's own calls and the others' `tool.run` (lanes A and C). */
  executor?: ToolExecutor;
  store?: SelfStateStore;
  /** This computer's tree folder (`defaultTreeRoot()`), made and kept: `home/<this computer>` links to the home
   *  folder, `bots/` to the bots' folder. Left out, no folder is made (tests). */
  treeRoot?: string;
  /** The calling computer's side of R1: shows the user another computer's card and gives back their signed answer
   *  (lanes B and C's broker). Without it, a call another computer's level asks about is refused. */
  askUser?: AnswerAsker;
  /** This computer's reviewer for another computer's calls at `ask-risky` (R1; lane C's). */
  reviewer?: PeerReviewer;
  /** MCP across computers (lanes B and D's host): where each server runs, the fields the session's prompt gave its
   *  tools, this computer's host, a session's scratch folder, and how a mirrored server installs here. */
  mcp?: {
    placement: (server: string) => McpServerPlacement | undefined;
    fields: (server: string, session: string) => McpFields;
    call: McpCaller;
    scratch: (session: string) => string;
    install?: McpInstaller;
  };
  /** The terminal panel's shells here (R4): how a shell starts, and the card for a paste of several lines. */
  terminals?: { launch?: ShellLauncher; confirmPaste?: (text: string, terminalId: string) => Promise<boolean> };
  /** Cloud computers (§9.2): the plugin registry's `computer` folders and `computerProviders` handlers, run on the
   *  main computer only. `confirm` shows the user a card (lane C's broker); `userData` is the official image's
   *  cloud-init (`image.ts`, with lane H's join ticket and lane M's release pins); `makeMain` is lane H's election. */
  cloud?: {
    plugins: PluginRegistry;
    host: PluginHost;
    confirm: (card: CloudCard) => Promise<boolean>;
    userData: (o: { name: string; token: string }) => string;
    makeMain?: (name: string) => Promise<void>;
  };
  log?: (line: string) => void;
}

export interface ComputerNode {
  registry: CoreComputerRegistry;
  peers: ComputerPeers;
  holder: LocalHolder;
  service: TreeService;
  tree: CoreTree;
  tools: TreeTools;
  terminals: TerminalRouter;
  /** The per-computer bulk slots for other computers' file calls and transfers here (check 2's N3). */
  bulk: BulkSlots;
  /** Holds on any computer's screen, kept by that computer (review minor 4). */
  holds: HoldRouter;
  /** How many terminals run on this computer, its own and the others'. */
  terminalCount(): number;
  /** Where each MCP call runs (with `mcp`). */
  mcp: McpRouter | undefined;
  /** Mirror: installs a local server on other computers, with the user's answer for each. */
  mirror(server: string, config: unknown, computers: readonly string[], session?: string): ReturnType<typeof mirror>;
  /** Settles once the tree folder is made (at once without `treeRoot`). */
  treeRootReady(): Promise<void>;
  /** Cloud computers (with `cloud`): kept in line with their folders while this computer is the main one. */
  cloud: CloudPoint | undefined;
  close(): void;
}

/** The fenced items that are folders (lane C's layout names files and folders alike). */
const FENCED_FOLDER_KINDS = new Set(["settings", "levels", "saved-rules", "connector-permissions", "trust", "user-layers", "plugin-oks", "plugin-data", "run-folder"]);

/** Makes Clover's fenced folders under its home if they aren't there yet, and the folders that hold its fenced files,
 *  so a name in another case finds them on disk (review B1: the folded fence is the guard; this is the second). */
export function makeFencedFolders(cloverHome: string, fence: Pick<Fence, "fencedSet">): void {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const home = norm(cloverHome);
  for (const item of fence.fencedSet()) {
    const p = norm(item.path);
    if (!p.startsWith(`${home}/`)) continue;
    const rest = p.slice(home.length + 1).split("/");
    const folder = FENCED_FOLDER_KINDS.has(item.kind) ? rest : rest.slice(0, -1);
    if (folder.length === 0) continue;
    mkdirSync(join(cloverHome, ...folder), { recursive: true, mode: 0o700 });
  }
}

export function startComputerNode(o: ComputerNodeOptions): ComputerNode {
  const os = o.self.os ?? hostOs();
  if (o.fence) makeFencedFolders(o.cloverHome, o.fence);
  const registry = new CoreComputerRegistry({
    clock: o.clock,
    self: { name: o.self.name, device: o.self.device, os, hasDisplay: o.self.hasDisplay ?? true, agents: o.self.agents ?? [] },
    store: o.store ?? new FileSelfStateStore(selfStatePath(o.cloverHome)),
    ...(o.answers ? { devices: o.answers.devices, ledger: o.answers.ledger, render: o.answers.render } : {}),
  });
  const botsRoot = join(o.cloverHome, "bots");
  const bots = o.bots ?? (() => []);
  const peers = new ComputerPeers({
    registry, transport: o.transport, roots: () => ({ home: o.home, botsRoot, os, bots: bots() }), devices: o.devices,
    ...(o.botPlacement ? { placement: o.botPlacement } : {}), ...(o.log ? { log: o.log } : {}),
    ...(o.answers ? { render: o.answers.render } : {}), ...(o.askUser ? { ask: o.askUser } : {}),
  });
  const holder = new LocalHolder({
    clock: o.clock,
    name: () => registry.self().name,
    aliases: () => registry.self().aliases,
    home: o.home,
    botsRoot,
    cloverHome: o.cloverHome,
    runsBot: (bot) => bots().includes(bot),
    os,
    level: () => registry.self().level,
    watches: new FolderWatches(),
    ...(o.reviewer ? { reviewer: o.reviewer } : {}),
    ...(o.fence ? { fence: o.fence } : {}),
    ...(o.answers ? { answers: o.answers } : {}),
  });
  const mayCall = (device: string) => {
    const d = o.devices.get(device);
    return d !== undefined && d.revokedAt === undefined && d.runsCore;
  };
  // One set of per-computer bulk slots for the tree service and the direct path (check 2's N3).
  const bulk = new BulkSlots();
  const service = new TreeService({
    bulk,
    transport: o.transport, holder, clock: o.clock, level: () => registry.self().level, mayCall,
    ...(o.answers ? { answers: o.answers } : {}), ...(o.executor ? { tools: o.executor } : {}),
    ...(o.reviewer ? { reviewer: o.reviewer } : {}),
    ...(o.mcp ? { mcp: (call: Parameters<McpRouter["serveHere"]>[0]) => mcpRouter!.serveHere(call) } : {}),
  });
  const offHolds = serveHolds({ transport: o.transport, registry, mayCall });
  const holds = new HoldRouter({ registry, transport: o.transport });
  const offMirror = serveMirror({
    transport: o.transport, self: () => registry.self().name, mayCall, clock: o.clock,
    ...(o.mcp?.install ? { install: o.mcp.install } : {}), ...(o.answers ? { answers: o.answers } : {}),
  });
  const localTerminals = new LocalTerminals(o.terminals ?? {});
  const offTerminals = serveTerminals({
    transport: o.transport, holder, terminals: localTerminals, level: () => registry.self().level, clock: o.clock, mayCall,
    ...(o.answers ? { answers: o.answers } : {}),
  });
  const remotes = new Map<string, RemoteHolder>();
  const holderFor = (name: string): Holder => {
    const c = registry.get(name);
    if (!c) throw new ContractError("not_found", `no computer ${name}`);
    if (c.name === registry.self().name) return holder;
    let r = remotes.get(c.device);
    if (!r) {
      const device = c.device;
      r = new RemoteHolder({ transport: o.transport, device, computer: () => registry.byDevice(device)?.name ?? device, ...(o.askUser ? { ask: o.askUser } : {}) });
      remotes.set(device, r);
    }
    return r;
  };
  const directory = peers.directory();
  const where = (name: string) => {
    const c = registry.get(name);
    if (!c) throw new ContractError("not_found", `no computer ${name}`);
    return { computer: c.name, device: c.name === registry.self().name ? null : c.device };
  };
  // The direct path (edit J8, review S1): this computer as the destination or the source of a move or copy.
  const xfer = serveTransfer({ transport: o.transport, holder, mayCall, bulk, deviceFor: (path) => where(tree.resolve(path).computer) });
  const tree: CoreTree = new CoreTree({
    directory, holder: holderFor, botComputer: (bot) => peers.botComputer(bot),
    transfer: ({ from, to, move, source, destination, call }) => {
      const session = call.as.kind === "session" || call.as.kind === "peer" ? call.as.sessionId : undefined;
      // R1: asks the user up front for each holder whose level needs their answer, then sends the call once.
      return transferAsking({
        transport: o.transport, holder, receiveHere: xfer.receiveHere, as: call.as,
        source: where(source), destination: where(destination),
        params: {
          from, to, move, level: call.level ?? registry.self().level,
          ...(session === undefined ? {} : { session }),
          ...(call.answer ? { answer: call.answer } : {}),
        },
        ...(o.askUser ? { ask: o.askUser } : {}),
      });
    },
  });
  const tools = new TreeTools({
    tree, directory, transport: o.transport,
    deviceOf: (name) => registry.get(name)?.device,
    ...(o.executor ? { local: { holder, executor: o.executor } } : {}),
    ...(o.askUser ? { ask: o.askUser } : {}),
  });
  const mcpRouter: McpRouter | undefined = o.mcp
    ? new McpRouter({
      tree, holder, directory, transport: o.transport, deviceOf: (name) => registry.get(name)?.device,
      placement: o.mcp.placement, fields: o.mcp.fields, call: o.mcp.call, scratch: o.mcp.scratch,
      ...(o.askUser ? { ask: o.askUser } : {}),
    })
    : undefined;
  const terminals = new TerminalRouter({
    transport: o.transport,
    self: () => registry.self().name,
    local: { holder, terminals: localTerminals, level: () => registry.self().level },
    computer: (name) => {
      const c = registry.get(name);
      return c ? { computer: c.name, device: c.device, online: c.state === "online", level: c.level } : undefined;
    },
    ...(o.askUser ? { ask: o.askUser } : {}),
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
  // Cloud computers: the main computer alone makes, resizes and deletes VMs, so two computers never act on one folder.
  let cloud: CloudPoint | undefined;
  let offCloud: (() => void) | undefined;
  let offMain = () => {};
  if (o.cloud) {
    const c = o.cloud;
    const vms = new CloudComputers({
      clock: o.clock, store: new FileCloudStateStore(o.cloverHome), provider: pluginProviders(c.plugins, c.host),
      confirm: c.confirm, userData: c.userData, ...(c.makeMain ? { makeMain: c.makeMain } : {}), ...(o.log ? { log: o.log } : {}),
    });
    const point = new CloudPoint({ registry: c.plugins, cloud: vms, active: () => registry.self().isMain, ...(o.log ? { log: o.log } : {}) });
    cloud = point;
    const follow = () => {
      const main = registry.self().isMain;
      if (main && !offCloud) offCloud = point.start();
      else if (!main && offCloud) {
        offCloud();
        offCloud = undefined;
      }
    };
    follow();
    offMain = registry.watch(follow);
  }
  return {
    registry, peers, holder, service, tree, tools, terminals, holds, bulk, mcp: mcpRouter, cloud,
    terminalCount: () => localTerminals.count,
    mirror: (server, config, computers, session) => mirror({
      transport: o.transport, directory, deviceOf: (name) => registry.get(name)?.device, server, config, computers,
      ...(session ? { session } : {}), ...(o.askUser ? { ask: o.askUser } : {}),
    }),
    treeRootReady: () => rootReady,
    close: () => {
      offMain();
      offCloud?.();
      offRoot();
      terminals.dispose();
      offMirror();
      offHolds();
      offTerminals();
      localTerminals.closeAll();
      tools.close();
      xfer.close();
      service.close();
      for (const r of remotes.values()) r.close();
      holder.watches.close();
      peers.close();
    },
  };
}
