// The daemon's side of lane H's links (H-M1, #170; plan §4 C M2; the daemon integration lane): this device's links
// started at boot and closed at stop, their methods on Clover connections, the `peer.call` door, and a re-dial on every
// network change or wake.
//   - The link sidecar (`clover-link`, which lane M ships beside the core) is the one beside the daemon's own binary,
//     with its links resolved (`bundledLinkBinary`), never one an environment variable or the PATH names: the sidecar
//     is handed the device key. Without it the daemon runs with no links, and says so.
//   - The device key and box key live in the contract secret store (`CloverSecretStore`), as device items.
//   - The handshake (`https://handshake.waifucave.com`, or the dev/test build's `CLOVER_HANDSHAKE_URL`) finds peers and
//     keeps the main computer's lease on the group's record; public time servers set the shared clock's reference.
//   - The waifucave account and short codes' rendezvous come from lane I's settings (`waifucaveAccount`: the
//     environment in dev and test builds only, `<clover home>/account.json`, then production's). The daemon never
//     passes `distBuild` or an environment of its own: the compile-time build kind decides.
//   - A sensitive device change (add, revoke, the main computer) made in the user's own terminal goes through; any
//     other opens a card through `openCard`, which refuses until C-M3's approval broker raises it (the controller's
//     ruling: `refuseUntilBroker`; C-M3 passes `brokerCardOpener(broker)`).
//   - The main computer (H-M2): `main.*`, another computer's request to make this one main (`mountMainChoiceRequests`),
//     the pair's hand-over (`handOver`), and the lease renewed just before an update's restart (`updateGate`).
//   - `peer.call` runs through the Clover server's `dispatch`. A call that needs the user's signed answer is refused
//     until C-M3's cards render (`renderNothing`), so verifySignedAnswer fails closed.
// Still to come: the sidecar's spawn under the fence (with C-M2's Bash fence: UDP and its pipes only), H-M2's
// `mountRemoteClients` (lane I's phone over the link), and the devices area's events (`devicesEvents`), once the Clover server sends `core.event`s.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { Caller, CloverRole } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import type { SecretStore } from "../contracts/secret-store";
import type { AnswerLedger, CallCardRenderer } from "../contracts/approval-broker";
import { SntpTimeSource } from "../clock/shared-clock";
import { waifucaveAccount, type WaifucaveAccount } from "../identity/account-config";
import { devicesMethods, mountMainChoiceRequests, type CardOpener } from "../devices/rpc";
import type { UpdateRestartGate } from "../lease/main";
import { HandshakeClient } from "../links/handshake";
import { startDeviceLinks, type DeviceLinks, type DeviceLinksOptions } from "../links/node";
import { bundledLinkBinary } from "../links/sidecar-binary";
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

/** This computer's device name by default: its host name without the domain (`studio.local` is `studio`), with no
 *  control characters, cut to the registry's 63 characters; `Computer` when nothing is left. A host name the registry
 *  can't take as it is (a CI runner's long generated one) must never keep the links from starting. */
export function defaultDeviceName(host: string): string {
  const first = host.split(".")[0] ?? "";
  const clean = [...first.replace(/[\u0000-\u001f\u007f]/gu, "").trim()].slice(0, 63).join("").trim();
  return clean.length > 0 ? clean : "Computer";
}

/** The link sidecar beside the daemon's own binary (its links resolved, `bundledLinkBinary`); null when there's none
 *  (a daemon run from source, whose executable is Bun). Never one an environment variable or the PATH names. */
export function linkSidecarBinary(execPath = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  let beside: string;
  try {
    beside = bundledLinkBinary(execPath, platform);
  } catch {
    return null;
  }
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
  /** Opens a sensitive change's card (lane C's broker, `brokerCardOpener`); `refuseUntilBroker` until C-M3. */
  openCard?: CardOpener;
  /** The daemon's update gate (`RunningDaemon.updateGate`, lane M): the lease renews just before an update's restart. */
  updateGate?: UpdateRestartGate;
  /** The handshake: at the account settings' `handshakeUrl` (production's unless a dev or test build overrides it) by
   *  default; a test's local stand-in, or null for none. */
  handshake?: HandshakeClient | null;
  /** The account and short codes' rendezvous: `waifucaveAccount`'s by default; a test's own, or null for neither (signed
   *  out, no short codes). Only with the default handshake: the rendezvous lives at the handshake, so a test that
   *  passes its own handshake (or none) passes its own account and rendezvous too, or has neither. */
  account?: Pick<WaifucaveAccount, "account" | "rendezvous"> | null;
  /** Public time for the shared clock's reference: SNTP by default; null for none (tests never reach the network). */
  publicTime?: DeviceLinksOptions["publicTime"] | null;
  /** The main computer's timings and clocks, for tests. */
  mainComputer?: DeviceLinksOptions["mainComputer"];
  /** Test seams: the wire and where peers are (no sidecar), the directories' driver, and the network watch. */
  wire?: DeviceLinksOptions["wire"];
  directory?: DeviceLinksOptions["directory"];
  driver?: DeviceLinksOptions["driver"];
  watch?: typeof watchNetwork;
  binary?: string | null;
  /** The sidecar's network for tests: no relay, loopback only, nothing published (`n0Lookup: false`). */
  sidecar?: Pick<NonNullable<DeviceLinksOptions["sidecar"]>, "relay" | "bind" | "n0Lookup">;
  log?(line: string): void;
}

export interface DaemonLinks {
  readonly links: DeviceLinks | null;
  /** `pair.quit{handOver}`: the bots go to another computer (`main.handOver`); nothing without a main computer. */
  handOver(): Promise<void>;
  close(): Promise<void>;
}

export async function startDaemonLinks(input: DaemonLinksInput): Promise<DaemonLinks> {
  const log = input.log ?? (() => {});
  const binary = input.binary !== undefined ? input.binary : linkSidecarBinary();
  if (!input.wire && !binary) {
    log("[links] no link sidecar (clover-link) beside the daemon: this computer runs without links to its devices");
    return { links: null, handOver: async () => {}, close: async () => {} };
  }
  const settings = input.handshake === undefined
    ? await waifucaveAccount({ home: input.home, store: input.store, clock: input.clock, log })
    : undefined;
  const account = input.account === undefined ? settings : input.account ?? undefined;
  const handshake = input.handshake === undefined
    ? new HandshakeClient({ baseUrl: settings!.handshakeUrl, clock: input.clock })
    : input.handshake ?? undefined;
  const publicTime = input.publicTime === undefined ? new SntpTimeSource() : input.publicTime ?? undefined;
  const openCard = input.openCard ?? refuseUntilBroker;
  const sidecar: NonNullable<DeviceLinksOptions["sidecar"]> = { ...(input.sidecar ?? {}), binary: binary!, onLog: (l: string) => log(`[clover-link] ${l}`) };
  const links = await startDeviceLinks({
    home: input.home, store: input.store, clock: input.clock,
    self: input.self ?? { name: defaultDeviceName(hostname()), kind: "desktop", os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux" },
    ...(input.wire ? { wire: input.wire } : { sidecar }),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(handshake ? { handshake } : {}),
    ...(account?.account ? { account: account.account } : {}),
    ...(account?.rendezvous ? { rendezvous: account.rendezvous } : {}),
    ...(publicTime ? { publicTime } : {}),
    ...(input.mainComputer !== undefined ? { mainComputer: input.mainComputer } : {}),
    ...(input.driver !== undefined ? { driver: input.driver } : {}),
    ...(input.updateGate ? { updateGate: input.updateGate } : {}),
    openCard,
    log,
  });
  const offs: Array<() => void> = [];
  try {
    Object.assign(input.handlers, laneMethodHandlers(devicesMethods({
      registry: links.registry, pairing: links.pairing, transport: links.transport, clock: links.clock, openCard,
      revoke: links.revokeOptions(), ...(links.main ? { main: links.main } : {}),
    })));
    if (links.main) offs.push(mountMainChoiceRequests({ transport: links.transport, registry: links.registry, main: links.main, openCard }));
    const self = links.key.id;
    offs.push(mountPeerCall(links.transport, {
      computer: () => links.registry.get(self)?.computer ?? self,
      devices: links.registry, ledger: memoryLedger(), render: renderNothing, clock: input.clock,
      dispatch: (method, params, caller, role) => input.dispatch(method, params, caller, role),
    }));
    offs.push((input.watch ?? watchNetwork)((why) => {
      log(`[links] network ${why === "wake" ? "after a wake" : "changed"}: re-dialling`);
      void links.networkChanged().catch(() => undefined);
    }));
  } catch (err) {
    for (const off of offs.splice(0).reverse()) off();
    await links.close();
    throw err;
  }
  void links.refresh().catch(() => undefined);
  return {
    links,
    handOver: async () => {
      if (links.main) await links.main.coordinator.handOver();
    },
    async close() {
      for (const off of offs.splice(0).reverse()) off();
      await links.close();
    },
  };
}
