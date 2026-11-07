// This device's links, put together for the daemon to own (lane J's ask): the device key, the registry, the wire (the
// link sidecar, or a test's in-memory one), one `LinkTransport` for every peer, pairing, the handshake directories
// (the pairs' and the account's) and what drives them, the dial policy, and the main computer (its lease over the
// account's or the group's record, H-M2), and the bots' memories kept alike on every computer (H-M3). Lane C's daemon
// starts one of these at boot and closes it at shutdown; lane J's computer node takes its `transport`, `registry` and
// `memoryChanged` (`computerNodeLinks`); lane D's bot side reads `main`.
//
// What depends on the account (items 79-81): a device without one publishes to n0's address lookup (the relay URL
// only) and keeps pair credentials at the handshake; a signed-in one does neither. The lookup follows sign-in and
// sign-out while running (m10 of H-M1's review).
import type { Clock } from "../contracts/clock";
import type { Lease, LeaseState } from "../contracts/lease";
import type { Unsubscribe } from "../contracts/common";
import type { SecretMeta, SecretStore } from "../contracts/secret-store";
import type { AccountClient } from "../identity/account";
import { BoxKey } from "../identity/box-key";
import { DeviceKey } from "../identity/device-key";
import { retryRevokes, syncAccountDevices, type RevokeOptions } from "../devices/account-devices";
import { startMainComputer, type MainComputerHandle, type MainComputerOptions, type UpdateRestartGate } from "../lease/main";
import { AccountLeaseScope, GroupLeaseScope, type LeaseScope } from "../lease/scope";
import { SharedClock, type TimeSource } from "../clock/shared-clock";
import { AccountDirectory } from "./account-directory";
import { DirectoryDriver, type DirectoryDriverOptions } from "./directory-driver";
import { FileDeviceRegistry, type FileDeviceRegistryOptions } from "../devices/registry";
import { DialPolicy, type NatMapping } from "./dial-policy";
import { GroupKeeper } from "./group";
import { MemorySync, type MemorySyncOptions } from "../sync/memory";
import type { CardOpener } from "../devices/rpc";
import type { HandshakeClient } from "./handshake";
import { HandshakeDirectory } from "./handshake-directory";
import { PairingService, type PairingCloud, type PairingRendezvous } from "./pairing";
import { mountRenameRequests, shareDeviceUpdates } from "./relay";
import { allowListsOf, followRegistry, SidecarWire, type SidecarWireOptions } from "./sidecar-wire";
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
  /** The sidecar's options. `n0Lookup` defaults to "no account" (item 81) and then follows the account's sign-in;
   *  set, it stays as set (tests set it false so nothing leaves the machine). */
  sidecar?: Omit<SidecarWireOptions, "key" | "n0Lookup" | "allow"> & { n0Lookup?: boolean };
  /** Where peers are, in place of the handshake's directory (tests; later the LAN's discovery). */
  directory?: PeerDirectory;
  account?: AccountClient;
  handshake?: HandshakeClient;
  rendezvous?: PairingRendezvous;
  /** The waifucave services a revocation tells (`WAIFUCAVE_DEVICE_SERVICES` in production; none by default). */
  services?: RevokeOptions["services"];
  /** The main computer (the lease, H-M2): its timings for tests, or false for none (a test of the links alone). */
  mainComputer?: false | Pick<MainComputerOptions, "timings" | "monotonic" | "watchSleep" | "userActive" | "log">;
  /** Public time for the shared clock's reference (`SntpTimeSource` in the daemon); none by default, so tests never
   *  reach the network. */
  publicTime?: TimeSource;
  /** How the directories are driven: false for none (tests that drive them by hand). */
  driver?: false | Pick<DirectoryDriverOptions, "republishMs" | "backoffMs" | "log">;
  /** Asks this device's user (lane C's broker through `brokerCardOpener`), for what the group asks of it: agreeing to
   *  remove a member, moving to a new group. Without it this device agrees to nothing (it never does on its own). */
  openCard?: CardOpener;
  /** Where the links' own notes go (the daemon's log). */
  log?(line: string): void;
  /** The group keeper's card timeout, for tests. */
  groupCardTimeoutMs?: number;
  /** The transport's timings, for tests. */
  transport?: Partial<Omit<LinkTransportOptions, "self" | "wire" | "registry" | "directory" | "clock" | "planner">>;
  /** The bots' memories across computers (sync/memory.ts): on by default; `mailbox` is a relay plugin's mail
   *  (`relayMailbox`), without which memory reaches a computer only over its link. False for none. */
  memory?: false | Pick<MemorySyncOptions, "mailbox" | "mailDelayMs" | "entitled" | "limits">;
  /** The daemon's update gate (`RunningDaemon.updateGate`, lane M's #198): the lease renews just before an update's
   *  restart, so the bots stay here through it (`MainComputerHandle.beforeUpdateRestart`). */
  updateGate?: UpdateRestartGate;
  /** Cloud computers' single-use tokens at the pair door (lane J's `CloudPoint`, which the computer node makes after
   *  the links), read at each use. Without one every token is refused. Join tickets are issued, and tokens taken, only
   *  while this computer runs the bots (the lease's main computer). */
  cloudTokens?: () => Pick<PairingCloud, "claim" | "paired"> | undefined;
}

export interface DeviceLinks {
  key: DeviceKey;
  boxKey: BoxKey;
  registry: FileDeviceRegistry;
  wire: WireEndpoint;
  transport: CloverLinkTransport;
  pairing: PairingService;
  directory?: HandshakeDirectory;
  accountDirectory?: AccountDirectory;
  driver?: DirectoryDriver;
  /** The main computer: the lease, the main choice and the coordinator (absent when `mainComputer: false`). */
  main?: MainComputerHandle;
  /** The account-less devices' group: merges, voters, recovery (absent without a handshake). */
  groups?: GroupKeeper;
  /** The bots' memories across computers (absent with `memory: false`). */
  memory?: MemorySync;
  /** What a revocation needs (devices.revoke, `revokeDevice`), with the group's quorum removal. */
  revokeOptions(): RevokeOptions;
  /** The shared clock (§6.4): the lease's holder is the reference. What every stamp a message carries reads. */
  clock: SharedClock;
  /** Publishes this device's addresses to its pairs and the account, and sends pending registrations and revocations
   *  (the driver calls it at start, on a timer and on network changes). */
  refresh(): Promise<void>;
  /** The OS reported a network change or a wake: re-read the net report, publish, and re-dial every link. */
  networkChanged(): Promise<void>;
  /** Where this device is reached, as the sidecar's last net report said (empty on another wire). */
  localAddresses(): { relay?: string; direct: string[] };
  close(): Promise<void>;
}

/** What lane J's `startComputerNode` takes from the links, to pass straight through: with `memoryChanged`, the
 *  holder's hook for a change in a bot's memory on disk (J-M3), which the memory sync sends on; and `lease`, this
 *  computer's lease, whose fencing token goes on every act it asks of another computer and judges every act asked of
 *  it (J-M3's `lease` option, required since lane J's #237: `null` with no main computer here, "no group yet"). */
export function computerNodeLinks(l: DeviceLinks): {
  transport: CloverLinkTransport; devices: FileDeviceRegistry; self: { name: string; device: string }; memoryChanged?: (bot: string, rel: string) => void;
  lease: Lease | null;
} {
  const self = l.registry.self();
  const memory = l.memory;
  return {
    transport: l.transport, devices: l.registry, self: { name: self.computer ?? self.name, device: self.id },
    ...(memory ? { memoryChanged: (bot: string, rel: string) => memory.changed(bot, rel) } : {}),
    lease: l.main ? fencingLease(l.main.lease) : null,
  };
}

/** The lease as a fencing token's source (`fencingTokenOf` reads `scope`, `epoch` and `holder`), a whole `Lease`:
 *  its state with the record it is on (the account's, or the group's), and no scope for a lease held locally with no
 *  record, which then carries no token. Everything else is the lease's own. */
export function fencingLease(lease: MainComputerHandle["lease"]): Lease {
  const scoped = (s: LeaseState): LeaseState => (lease.hasScope() ? { ...s, scope: lease.scopeId() } : s);
  return {
    self: lease.self,
    state: () => scoped(lease.state()),
    canAct: () => lease.canAct(),
    acquire: async (opts) => scoped(await lease.acquire(opts)),
    renew: async () => scoped(await lease.renew()),
    release: () => lease.release(),
    wake: () => lease.wake(),
    watch: (fn) => lease.watch((s) => fn(scoped(s))),
  };
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
    sidecar = await SidecarWire.start({ ...o.sidecar, key, n0Lookup: o.sidecar.n0Lookup ?? !signedIn, allow: allowListsOf(registry) });
    wire = sidecar;
  }
  const offs: Unsubscribe[] = [];
  if (sidecar) offs.push(followRegistry(sidecar, registry));
  // Signing in or out switches the n0 lookup on the running sidecar (m10).
  if (sidecar && o.account && o.sidecar?.n0Lookup === undefined) {
    const s = sidecar;
    offs.push(o.account.watch((v) => s.setN0Lookup(!v.signedIn)));
  }

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
  let main: MainComputerHandle | undefined;
  const accountDirectory = o.handshake && o.account
    ? new AccountDirectory({
      registry, account: o.account, client: o.handshake, boxKey, clock: o.clock,
      onDialNow: (peer) => transport.dialNow(peer),
      onLease: (l) => {
        if (main && scopeNow?.id === "account") main.lease.observe({ holder: l.holder, holderRaw: l.holder, epoch: l.epoch, expiresAt: l.expiresAt });
      },
      onPresence: (device, online) => {
        if (online) transport.dialNow(device);
      },
      localAddr: async () => {
        const lan = local.direct.filter(isPrivate);
        const stun = local.direct.filter((a) => !isPrivate(a));
        return { lan, stun, mapping, ...(local.relay ? { relay: local.relay } : {}) };
      },
    })
    : undefined;
  // A device of the account is found through the account channel, an account-less peer through its pair's; either
  // way the key alone is the fallback, which n0's lookup resolves for account-less devices.
  const target = async (id: string): Promise<DialTarget | undefined> => {
    if (accountDirectory?.covers(id)) return (await accountDirectory.target(id).catch(() => undefined)) ?? fallback(id);
    if (directory) return (await directory.target(id).catch(() => undefined)) ?? fallback(id);
    return fallback(id);
  };
  const peers: PeerDirectory = o.directory ?? { target };
  const planner = new DialPolicy({
    selfMapping: () => mapping,
    peerMapping: (peer) => (accountDirectory?.covers(peer) ? accountDirectory.mapping(peer) : (directory?.mapping(peer) ?? "unknown")),
  });
  transport = new CloverLinkTransport({
    self: key.id, wire, registry, directory: peers, clock: o.clock, planner,
    // The hello carries the newest lease epoch this device has seen; a newer one from a peer makes it read the record.
    epoch: () => main?.lease.highestEpoch() ?? 0,
    epochScope: () => (main?.lease.hasScope() ? main.lease.scopeId() : undefined),
    onPeerEpoch: (peer, epoch, scope) => main?.coordinator.peerEpoch(epoch, scope, peer),
    ...o.transport,
  });

  let accountHash: string | null = o.account ? await o.account.accountHash() : null;
  if (o.account) offs.push(o.account.watch(() => void o.account!.accountHash().then((h) => (accountHash = h))));
  const pairing = new PairingService({
    self: key, registry, wire, clock: o.clock, store: o.store,
    selfTarget: () => ({ ...(local.relay ? { relay: local.relay } : {}), direct: local.direct.filter((a) => !isPrivate(a)), lan: local.direct.filter(isPrivate) }),
    account: () => accountHash,
    ...(o.handshake ? { handshake: o.handshake } : {}),
    ...(o.rendezvous ? { rendezvous: o.rendezvous } : {}),
    // A merge in a confirmed pairing (R18): the old group's computers are asked to follow, each by its card.
    onMerged: (old, via) => groups?.merged(old, via),
    // Cloud computers (§9.2): the main computer is the lease's holder while it may act; a computer with no lease here
    // is its own main.
    cloud: {
      isMain: () => (main ? main.lease.state().holder === key.id && main.lease.canAct() : true),
      claim: (token, device) => o.cloudTokens?.()?.claim(token, device) ?? { refused: "unknown" },
      paired: async (token, device) => o.cloudTokens?.()?.paired(token, device),
    },
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

  // The lease's scope: the account's record while signed in, else the group's, else none (a lone computer is its own
  // main, lease.ts). It follows sign-in and sign-out, and a group made at pairing.
  let scopeNow: LeaseScope | undefined;
  const resolveScope = async (): Promise<void> => {
    let next: LeaseScope | undefined;
    if (o.handshake && o.account && (await o.account.accountId()) !== null) next = scopeNow?.id === "account" ? scopeNow : new AccountLeaseScope({ client: o.handshake, account: o.account });
    else if (o.handshake && registry.group()) {
      const id = `group:${registry.group()!.id}`;
      next = scopeNow?.id === id ? scopeNow : await GroupLeaseScope.open({ client: o.handshake, registry, store: o.store });
    }
    if (next?.id !== scopeNow?.id) {
      scopeNow = next;
      main?.scopeChanged();
    }
  };
  await resolveScope().catch(() => undefined);
  if (o.mainComputer !== false) {
    main = startMainComputer({
      home: o.home, self: key.id, registry, transport, clock: o.clock, scope: () => scopeNow,
      ...(o.mainComputer ?? {}),
    });
  }

  const sharedClock = new SharedClock({
    self: key.id, base: o.clock, transport, reference: () => main?.lease.state().holder ?? null,
    ...(o.publicTime ? { publicTime: o.publicTime } : {}),
  });
  let lastHolder: string | null | undefined;
  if (main) {
    offs.push(main.lease.watch((st) => {
      if (st.holder === lastHolder) return;
      lastHolder = st.holder;
      sharedClock.referenceChanged();
    }));
  }
  sharedClock.start();
  // An update's restart keeps the lease: it renews just before, and the new daemon renews the same epoch.
  if (main && o.updateGate) {
    const m = main;
    offs.push(o.updateGate.beforeRestart(() => m.beforeUpdateRestart()));
  }

  // The group: members' keys over the links, merges (R18), quorum removals and recovery, fresh signatures.
  const groups = o.handshake
    ? new GroupKeeper({
      registry, store: o.store, handshake: o.handshake, transport, clock: o.clock,
      signedIn: async () => (o.account ? (await o.account.accountId()) !== null : false),
      ...(o.openCard ? { openCard: o.openCard } : {}),
      ...(o.groupCardTimeoutMs !== undefined ? { cardTimeoutMs: o.groupCardTimeoutMs } : {}),
      beforeLeave: async (group) => {
        if (main && scopeNow?.id === `group:${group}` && main.lease.state().holder === key.id) await main.lease.release();
      },
      onChanged: () => void resolveScope().catch(() => undefined),
      ...(o.log ? { log: o.log } : {}),
    })
    : undefined;

  // The bots' memories (H-M3): versions signed with this device's link key, mail opened with its box key, stamped
  // with the shared clock.
  // TODO(B-M2, lane B's plugin host): the daemon passes the relay plugin's mail here, as
  // `memory: { mailbox: relayMailbox(<the relay plugin's putMail/takeMail/ackMail handlers>) }` (sync/mailbox.ts).
  // Until it does, memory reaches a computer that is off only over its link once it is back.
  const memory = o.memory === false ? undefined : await MemorySync.start({
    home: o.home, self: key.id, key, boxKey, store: o.store, transport, registry, now: () => sharedClock.now(),
    ...(o.memory ?? {}), ...(o.log ? { log: o.log } : {}),
  });

  const revokeOptions = (): RevokeOptions => ({
    registry, store: o.store, ...(o.handshake ? { handshake: o.handshake } : {}), ...(o.account ? { account: o.account } : {}),
    ...(o.services ? { services: o.services } : {}),
    ...(groups ? { removeGroupMember: (group: string, member: string, device?: string) => groups.removeMember(group, member, device) } : {}),
  });
  const refresh = async () => {
    await readNet().catch(() => undefined);
    await pairing.retryRegistrations().catch(() => undefined);
    await groups?.refresh().catch(() => undefined);
    // A revocation's steps the services haven't confirmed yet (S5).
    await retryRevokes(revokeOptions()).catch(() => undefined);
    await resolveScope().catch(() => undefined);
    // Memory mail for this computer, kept while it was off (the driver calls this at start and on a timer).
    await memory?.takeMail().catch(() => undefined);
  };
  const driver = o.driver === false ? undefined : new DirectoryDriver({
    registry, ...(directory ? { pairs: directory } : {}), ...(accountDirectory ? { account: accountDirectory } : {}),
    signedIn: async () => (o.account ? (await o.account.accountId()) !== null : false),
    ...(o.account ? { syncAccount: async () => void (await syncAccountDevices({ registry, account: o.account!, device: key, boxKey })) } : {}),
    refresh,
    ...(o.driver ?? {}),
  });
  if (o.account) {
    // Signing in or out moves the lease to the account's record or back to the group's, and the account's devices in.
    offs.push(o.account.watch(() => void (driver ? driver.refresh() : resolveScope())));
  }
  // A pairing that finished registered its pair (and maybe made a group): publish to it, open its socket, and move
  // the lease onto the group's record.
  offs.push(pairing.watch((c) => {
    if (c.type === "changed" && c.pairing.status === "paired") void (driver ? driver.paired() : resolveScope());
  }));
  driver?.start();
  const networkChanged = async () => {
    transport.networkChanged();
    if (driver) await driver.networkChanged();
    else await refresh();
  };
  // A restarted sidecar (§8.3) binds afresh, maybe on another port: as after a network change, read the net report
  // again, publish to the pairs and the account, and re-dial.
  if (sidecar) offs.push(sidecar.onRestart(() => void networkChanged().catch(() => undefined)));
  return {
    key, boxKey, registry, wire, transport, pairing, ...(directory ? { directory } : {}),
    ...(accountDirectory ? { accountDirectory } : {}), ...(driver ? { driver } : {}), ...(main ? { main } : {}), clock: sharedClock,
    ...(groups ? { groups } : {}), ...(memory ? { memory } : {}), revokeOptions,
    async refresh() {
      if (driver) await driver.refresh();
      else {
        await refresh();
        await directory?.publish().catch(() => undefined);
      }
    },
    networkChanged,
    localAddresses: () => ({ ...local, direct: [...local.direct] }),
    async close() {
      driver?.close();
      groups?.close();
      memory?.close();
      main?.close();
      sharedClock.close();
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
