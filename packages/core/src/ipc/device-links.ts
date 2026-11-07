// The daemon's side of lane H's links (H-M1, #170; plan §4 C M2): this device's links started at boot and closed at
// stop, their methods on Clover connections, the `peer.call` door, and a re-dial on every network change or wake.
//   - The link sidecar (`clover-link`, which lane M ships beside the core) is found beside the daemon's binary (its
//     links resolved), or at `CLOVER_LINK_BIN` in a dev or test build only. Without it the daemon runs with no links,
//     and says so. It runs under the fence (fence/sidecar-spawn.ts): Seatbelt on macOS, bubblewrap on Linux.
//   - The device key and box key live in the contract secret store (`CloverSecretStore`), as device items.
//   - A sensitive device change (add, revoke) made in the user's own terminal goes through; any other is refused until
//     C-M3's approval broker raises its card (the controller's ruling: `refuseUntilBroker`).
//   - `peer.call` runs through the Clover server's `dispatch`. A call that needs the user's signed answer is refused
//     until C-M3's cards render (`renderNothing`), so verifySignedAnswer fails closed.
//   - A paired phone or browser speaks the Clover protocol over its link (H-M2's `mountRemoteClients`, on the Clover
//     server through `mountCloverRemoteClients`, C-M3 item 3) when the daemon passes `clients`.
// Still to come: H-M2's `mountMainChoiceRequests`, `publicTime` and `revokeOptions()`.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { Caller, CloverRole } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import type { SecretStore } from "../contracts/secret-store";
import type { AnswerLedger, CallCardRenderer } from "../contracts/approval-broker";
import { devicesMethods, type CardOpener } from "../devices/rpc";
import { startDeviceLinks, type DeviceLinks, type DeviceLinksOptions } from "../links/node";
import { mountPeerCall } from "../links/peer-call";
import { watchNetwork } from "../platform/network-watch";
import { laneMethodHandlers, type CloverHandler } from "./clover";
import { DIST_BUILD, noteIgnoredEnvOverride } from "../build-kind";
import { bundledLinkBinary } from "../links/sidecar-binary";
import type { SidecarProcess } from "../links/sidecar-wire";
import { fencedSidecarSpawn } from "../fence/sidecar-spawn";
import { mountCloverRemoteClients, type CloverRemoteClientsOptions } from "./link-clients";

/** Until C-M3's broker: no card can be raised, so a change that needs one is refused. */
export const refuseUntilBroker: CardOpener = async () => ({ allowed: Promise.resolve(false) });

/** Until C-M3's sealed cards: no call's card can be rebuilt, so a signed answer never checks out. */
export const renderNothing: CallCardRenderer = () => undefined;

/** Each card id claimed once (C-M3's ledger persists it and expires it with its card). */
export function memoryLedger(): AnswerLedger {
  const seen = new Set<string>();
  return { claim: (id) => (seen.has(id) ? false : (seen.add(id), true)) };
}

/** Where the link sidecar is: beside the daemon's binary, its links resolved first (`bundledLinkBinary`); null when
 *  there's none. The sidecar is handed the device key, so a release build never takes one from the environment:
 *  `CLOVER_LINK_BIN` is for dev and test builds only, and a release build says it ignored it. */
export function linkSidecarBinary(
  env: Record<string, string | undefined> = process.env, execPath = process.execPath, dist: boolean = DIST_BUILD,
  log?: (line: string) => void,
): string | null {
  const named = env.CLOVER_LINK_BIN;
  if (named && !dist) return existsSync(named) ? named : null;
  if (named) noteIgnoredEnvOverride("CLOVER_LINK_BIN", log);
  let beside: string;
  try { beside = bundledLinkBinary(execPath); } catch { return null; }
  return existsSync(beside) ? beside : null;
}

export interface DaemonLinksInput {
  home: string;
  store: SecretStore;
  clock: Clock;
  /** This computer's name in the tree and its kind. */
  self?: DeviceLinksOptions["self"];
  /** Runs a peer's call as that peer, under the role's allow list (`CloverServer.dispatch`). */
  dispatch(method: string, params: unknown, caller: Extract<Caller, { kind: "peer" }>, role: Extract<CloverRole, "remote" | "web">): Promise<unknown>;
  /** The Clover server and its tokens, for paired phones' and browsers' connections over their links. */
  clients?: { server: CloverRemoteClientsOptions["server"]; tokens: CloverRemoteClientsOptions["tokens"] };
  /** The Clover server's lane handlers, filled in once the links are up. */
  handlers: Record<string, CloverHandler>;
  /** Test seams: the wire and where peers are (no sidecar), and the network watch. */
  wire?: DeviceLinksOptions["wire"];
  directory?: DeviceLinksOptions["directory"];
  watch?: typeof watchNetwork;
  binary?: string | null;
  /** Test seam: the sidecar's spawn in place of the fenced one. */
  sidecarSpawn?: (argv: readonly string[]) => SidecarProcess;
  log?(line: string): void;
}

export interface DaemonLinks {
  readonly links: DeviceLinks | null;
  close(): Promise<void>;
}

export async function startDaemonLinks(input: DaemonLinksInput): Promise<DaemonLinks> {
  const log = input.log ?? (() => {});
  const binary = input.binary !== undefined ? input.binary : linkSidecarBinary(process.env, process.execPath, DIST_BUILD, log);
  if (!input.wire && !binary) {
    log("[links] no link sidecar (clover-link) beside the daemon: this computer runs without links to its devices");
    return { links: null, close: async () => {} };
  }
  const links = await startDeviceLinks({
    home: input.home, store: input.store, clock: input.clock,
    self: input.self ?? { name: hostname(), kind: "desktop", os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" },
    // The sidecar under this OS's fence (C-M3 item 4, fence/sidecar-spawn.ts).
    ...(input.wire ? { wire: input.wire } : { sidecar: { binary: binary!, onLog: (l: string) => log(`[clover-link] ${l}`), spawn: input.sidecarSpawn ?? fencedSidecarSpawn({ cloverHome: input.home, onLog: (l: string) => log(`[clover-link] ${l}`) }) } as never }),
    ...(input.directory ? { directory: input.directory } : {}),
  });
  Object.assign(input.handlers, laneMethodHandlers(devicesMethods({
    registry: links.registry, pairing: links.pairing, transport: links.transport, clock: input.clock,
    openCard: refuseUntilBroker, revoke: { store: input.store },
  })));
  const self = links.key.id;
  const offPeer = mountPeerCall(links.transport, {
    computer: () => links.registry.get(self)?.computer ?? self,
    devices: links.registry, ledger: memoryLedger(), render: renderNothing, clock: input.clock,
    dispatch: (method, params, caller, role) => input.dispatch(method, params, caller, role),
  });
  const offClients = input.clients === undefined ? undefined : mountCloverRemoteClients({
    transport: links.transport, registry: links.registry, server: input.clients.server, tokens: input.clients.tokens, log,
  });
  const offNet = (input.watch ?? watchNetwork)((why) => {
    log(`[links] network ${why === "wake" ? "after a wake" : "changed"}: re-dialling`);
    links.transport.networkChanged();
    void links.refresh().catch(() => undefined);
  });
  void links.refresh().catch(() => undefined);
  return {
    links,
    async close() { offNet(); offClients?.(); offPeer(); await links.close(); },
  };
}
