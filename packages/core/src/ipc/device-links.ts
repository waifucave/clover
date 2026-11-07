// The daemon's side of lane H's links (H-M1, #170; plan §4 C M2): this device's links started at boot and closed at
// stop, their methods on Clover connections, the `peer.call` door, and a re-dial on every network change or wake.
//   - The link sidecar (`clover-link`, which lane M ships beside the core) is found beside the daemon's binary, or at
//     `CLOVER_LINK_BIN`. Without it the daemon runs with no links, and says so.
//   - The device key and box key live in the contract secret store (`CloverSecretStore`), as device items.
//   - A sensitive device change (add, revoke) made in the user's own terminal goes through; any other is refused until
//     C-M3's approval broker raises its card (the controller's ruling: `refuseUntilBroker`).
//   - `peer.call` runs through the Clover server's `dispatch`. A call that needs the user's signed answer is refused
//     until C-M3's cards render (`renderNothing`), so verifySignedAnswer fails closed.
// Still to come: the sidecar's spawn under the fence (with C-M2's Bash fence: UDP and its pipes only), and H-M2's
// `mountRemoteClients`, `mountMainChoiceRequests`, `publicTime` and `revokeOptions()` once #184 merges.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Until C-M3's broker: no card can be raised, so a change that needs one is refused. */
export const refuseUntilBroker: CardOpener = async () => ({ allowed: Promise.resolve(false) });

/** Until C-M3's sealed cards: no call's card can be rebuilt, so a signed answer never checks out. */
export const renderNothing: CallCardRenderer = () => undefined;

/** Each card id claimed once (C-M3's ledger persists it and expires it with its card). */
export function memoryLedger(): AnswerLedger {
  const seen = new Set<string>();
  return { claim: (id) => (seen.has(id) ? false : (seen.add(id), true)) };
}

/** Where the link sidecar is: `CLOVER_LINK_BIN`, else beside the daemon's binary; null when there's none. */
export function linkSidecarBinary(env: Record<string, string | undefined> = process.env, execPath = process.execPath): string | null {
  const named = env.CLOVER_LINK_BIN;
  if (named) return existsSync(named) ? named : null;
  const beside = join(dirname(execPath), process.platform === "win32" ? "clover-link.exe" : "clover-link");
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
  /** The Clover server's lane handlers, filled in once the links are up. */
  handlers: Record<string, CloverHandler>;
  /** Test seams: the wire and where peers are (no sidecar), and the network watch. */
  wire?: DeviceLinksOptions["wire"];
  directory?: DeviceLinksOptions["directory"];
  watch?: typeof watchNetwork;
  binary?: string | null;
  log?(line: string): void;
}

export interface DaemonLinks {
  readonly links: DeviceLinks | null;
  close(): Promise<void>;
}

export async function startDaemonLinks(input: DaemonLinksInput): Promise<DaemonLinks> {
  const log = input.log ?? (() => {});
  const binary = input.binary !== undefined ? input.binary : linkSidecarBinary();
  if (!input.wire && !binary) {
    log("[links] no link sidecar (clover-link) beside the daemon: this computer runs without links to its devices");
    return { links: null, close: async () => {} };
  }
  const links = await startDeviceLinks({
    home: input.home, store: input.store, clock: input.clock,
    self: input.self ?? { name: hostname(), kind: "desktop", os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" },
    ...(input.wire ? { wire: input.wire } : { sidecar: { binary: binary!, onLog: (l: string) => log(`[clover-link] ${l}`) } as never }),
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
  const offNet = (input.watch ?? watchNetwork)((why) => {
    log(`[links] network ${why === "wake" ? "after a wake" : "changed"}: re-dialling`);
    links.transport.networkChanged();
    void links.refresh().catch(() => undefined);
  });
  void links.refresh().catch(() => undefined);
  return {
    links,
    async close() { offNet(); offPeer(); await links.close(); },
  };
}
