// This device's links, put together for the daemon to own (lane J's ask): the device key, the registry, the wire (the
// link sidecar, or a test's in-memory one), one `LinkTransport` for every peer, pairing, the handshake directory and
// the dial policy, and the devices area's methods and events. Lane C's daemon starts one of these at boot and closes it
// at shutdown; lane J's computer node takes its `transport` and `registry` (`computerNodeLinks`).
//
// What depends on the account (items 79-81): a device without one publishes to n0's address lookup (the relay URL
// only) and keeps pair credentials at the handshake; a signed-in one does neither.
import type { Clock } from "../contracts/clock";
import type { Unsubscribe } from "../contracts/common";
import type { SecretMeta, SecretStore } from "../contracts/secret-store";
import type { AccountClient } from "../identity/account";
import { BoxKey } from "../identity/box-key";
import { DeviceKey } from "../identity/device-key";
import { retryRevokes, type RevokeOptions } from "../devices/account-devices";
import { FileDeviceRegistry, type FileDeviceRegistryOptions } from "../devices/registry";
import { DialPolicy, type NatMapping } from "./dial-policy";
import type { HandshakeClient } from "./handshake";
import { HandshakeDirectory } from "./handshake-directory";
import { PairingService, type PairingRendezvous } from "./pairing";
import { mountRenameRequests, shareDeviceUpdates } from "./relay";
import { followRegistry, SidecarWire, type SidecarWireOptions } from "./sidecar-wire";
import { CloverLinkTransport, type LinkTransportOptions, type PeerDirectory } from "./transport";
import type { DialTarget, WireEndpoint } from "./wire";

export interface DeviceLinksOptions {
  /** The Clover home: the registry lives in `devices/` there. */
  home: string;
  store: SecretStore;
  clock: Clock;
  self: FileDeviceRegistryOptions["self"];
  /** The wire to use: a test's in-memory endpoint. Without it, the link sidecar is started (`sidecar`). */
  wire?: (key: DeviceKey) => WireEndpoint | Promise<WireEndpoint>;
  /** The sidecar's options. `n0Lookup` defaults to "no account" (item 81); tests set it false so nothing leaves the
   *  machine. */
  sidecar?: Omit<SidecarWireOptions, "key" | "n0Lookup"> & { n0Lookup?: boolean };
  /** Where peers are, in place of the handshake's directory (tests; later the LAN's discovery). */
  directory?: PeerDirectory;
  account?: AccountClient;
  handshake?: HandshakeClient;
  rendezvous?: PairingRendezvous;
  /** The waifucave services a revocation tells (`WAIFUCAVE_DEVICE_SERVICES` in production; none by default). */
  services?: RevokeOptions["services"];
  /** The transport's timings, for tests. */
  transport?: Partial<Omit<LinkTransportOptions, "self" | "wire" | "registry" | "directory" | "clock" | "planner">>;
}

export interface DeviceLinks {
  key: DeviceKey;
  boxKey: BoxKey;
  registry: FileDeviceRegistry;
  wire: WireEndpoint;
  transport: CloverLinkTransport;
  pairing: PairingService;
  directory?: HandshakeDirectory;
  /** Publishes this device's addresses to its pairs and sends pending registrations (call on start and on a network
   *  change). */
  refresh(): Promise<void>;
  /** Where this device is reached, as the sidecar's last net report said (empty on another wire). */
  localAddresses(): { relay?: string; direct: string[] };
  close(): Promise<void>;
}

/** What lane J's `startComputerNode` takes from the links. */
export function computerNodeLinks(l: DeviceLinks): { transport: CloverLinkTransport; devices: FileDeviceRegistry; self: { name: string; device: string } } {
  const self = l.registry.self();
  return { transport: l.transport, devices: l.registry, self: { name: self.computer ?? self.name, device: self.id } };
}

export async function startDeviceLinks(o: DeviceLinksOptions): Promise<DeviceLinks> {
  const key = await DeviceKey.loadOrCreate(o.store);
  const boxKey = await BoxKey.loadOrCreate(o.store);
  const registry = await FileDeviceRegistry.open({
    home: o.home, key, clock: o.clock, self: o.self, syncedSecrets: async (): Promise<SecretMeta[]> => (await o.store.list()).filter((m) => m.synced),
  });
  registry.setBoxKey(key.id, boxKey.publicKeyBase64Url);
  const signedIn = o.account ? (await o.account.accountId()) !== null : false;
  let sidecar: SidecarWire | undefined;
  let wire: WireEndpoint;
  if (o.wire) wire = await o.wire(key);
  else {
    if (!o.sidecar) throw new Error("startDeviceLinks needs a wire or the link sidecar");
    sidecar = await SidecarWire.start({ ...o.sidecar, key, n0Lookup: o.sidecar.n0Lookup ?? !signedIn });
    wire = sidecar;
  }
  const offs: Unsubscribe[] = [];
  if (sidecar) offs.push(followRegistry(sidecar, registry));

  let mapping: NatMapping = "unknown";
  let local: { relay?: string; direct: string[] } = { direct: [] };
  const readNet = async () => {
    if (!sidecar) return;
    const r = await sidecar.settledReport();
    mapping = r.mapping;
    local = { ...(r.relay ? { relay: r.relay } : {}), direct: r.direct };
  };
  await readNet().catch(() => undefined);

  let transport!: CloverLinkTransport;
  const directory = o.handshake
    ? new HandshakeDirectory({
      registry, store: o.store, client: o.handshake, clock: o.clock,
      onDialNow: (peer) => transport.dialNow(peer),
      localAddr: async () => {
        const lan = local.direct.filter(isPrivate);
        const stun = local.direct.filter((a) => !isPrivate(a));
        return { lan, stun, mapping, ...(local.relay ? { relay: local.relay } : {}) };
      },
    })
    : undefined;
  const fallback = (id: string): DialTarget | undefined => {
    const d = registry.get(id);
    if (!d || d.revokedAt !== undefined) return undefined;
    const k = Buffer.from(d.publicKey, "base64");
    return k.length === 32 ? { key: new Uint8Array(k) as DialTarget["key"] } : undefined;
  };
  const peers: PeerDirectory = o.directory ?? { target: async (id) => (directory ? ((await directory.target(id).catch(() => undefined)) ?? fallback(id)) : fallback(id)) };
  const planner = new DialPolicy({ selfMapping: () => mapping, peerMapping: (peer) => directory?.mapping(peer) ?? "unknown" });
  transport = new CloverLinkTransport({ self: key.id, wire, registry, directory: peers, clock: o.clock, planner, ...o.transport });

  let accountHash: string | null = o.account ? await o.account.accountHash() : null;
  if (o.account) offs.push(o.account.watch(() => void o.account!.accountHash().then((h) => (accountHash = h))));
  const pairing = new PairingService({
    self: key, registry, wire, clock: o.clock, store: o.store,
    selfTarget: () => ({ ...(local.relay ? { relay: local.relay } : {}), direct: local.direct.filter((a) => !isPrivate(a)), lan: local.direct.filter(isPrivate) }),
    account: () => accountHash,
    ...(o.handshake ? { handshake: o.handshake } : {}),
    ...(o.rendezvous ? { rendezvous: o.rendezvous } : {}),
  });

  // Peers learn this device's name and answer key over the link, so they can check what its app signs (lane D's relay).
  offs.push(shareDeviceUpdates({ transport, registry, key, clock: o.clock }));
  offs.push(mountRenameRequests(transport, registry));

  // One persistent link per pair (§8.2): every paired computer's link is wanted from the start and from its pairing,
  // so a daemon that restarts dials its computers itself; phones and browsers dial in.
  const keepUp = (id: string) => {
    const d = registry.get(id);
    if (d && d.runsCore && d.revokedAt === undefined && id !== key.id) void transport.connect(id).catch(() => undefined);
  };
  for (const d of registry.list()) keepUp(d.id);
  offs.push(registry.watch((c) => {
    if (c.type === "added") keepUp(c.device.id);
  }));
  // When each device was last seen: as its link comes up, and as it goes down.
  const upNow = new Set<string>();
  offs.push(transport.watch((v) => {
    if (v.up === upNow.has(v.peer)) return;
    if (v.up) upNow.add(v.peer);
    else upNow.delete(v.peer);
    registry.seen(v.peer);
  }));

  const refresh = async () => {
    await readNet().catch(() => undefined);
    await pairing.retryRegistrations().catch(() => undefined);
    // A revocation's steps the services haven't confirmed yet (S5).
    await retryRevokes({
      registry, store: o.store, ...(o.handshake ? { handshake: o.handshake } : {}), ...(o.account ? { account: o.account } : {}),
      ...(o.services ? { services: o.services } : {}),
    }).catch(() => undefined);
    await directory?.publish().catch(() => undefined);
  };
  return {
    key, boxKey, registry, wire, transport, pairing, ...(directory ? { directory } : {}),
    refresh,
    localAddresses: () => ({ ...local, direct: [...local.direct] }),
    async close() {
      for (const off of offs.splice(0)) off();
      await pairing.close();
      await transport.close();
    },
  };
}

function isPrivate(addr: string): boolean {
  const host = addr.startsWith("[") ? addr.slice(1, addr.indexOf("]")) : addr.slice(0, addr.lastIndexOf(":"));
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const h = host.toLowerCase();
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}
