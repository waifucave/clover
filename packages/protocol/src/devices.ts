// Clover protocol area: devices and links (spec §6.4, §8). Owner: lane H (identity, devices, links, sync, the
// lease and the shared clock). Pinned by lane B at M0; spike S1 chose iroh (lane H's report of November 5).
//
// Every paired device has its own Ed25519 key, and each pair keeps one persistent encrypted link (§8.2). The main
// computer holds a short lease renewed through the waifucave handshake; another computer takes over only after it
// lapses (§6.4). Peer methods run daemon to daemon over that link; a peer acts for the user who called on its own
// computer, under the same allow lists (`peer.call`).
import { z } from "zod";
import {
  Caller, ChangeResult, ComputerName, DeviceId, Empty, Ok, Os, SessionId, Text, Timestamp,
} from "./common";
import { CloverRole } from "./roles";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { UserMessageInput } from "./sessions";

export const DeviceKind = z.enum(["desktop", "server", "cloud", "phone", "browser"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** How a link reaches its peer (§8.2): the same LAN, direct over the internet, or through a relay plugin. */
export const LinkPath = z.enum(["lan", "direct", "relay"]);
export type LinkPath = z.infer<typeof LinkPath>;

export const LinkView = z.object({
  peer: DeviceId,
  up: z.boolean(),
  path: LinkPath.optional(),
  /** The relay plugin carrying it, when `path` is `relay`. */
  relay: z.string().max(128).optional(),
  rttMs: z.number().nonnegative().optional(),
  since: Timestamp.optional(),
});
export type LinkView = z.infer<typeof LinkView>;

export const DeviceView = z.object({
  id: DeviceId,
  name: z.string().min(1).max(63),
  kind: DeviceKind,
  os: Os.optional(),
  /** Runs clover-core, so it is a computer in the tree (§9.1) and can take over (§6.4). */
  runsCore: z.boolean(),
  /** Its folder-tree name, for a device that runs clover-core. */
  computer: ComputerName.optional(),
  hasDisplay: z.boolean().optional(),
  online: z.boolean(),
  link: LinkView.optional(),
  isThis: z.boolean(),
  isMain: z.boolean(),
  addedAt: Timestamp,
  lastSeenAt: Timestamp.optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** The main computer's lease (§6.4). Events carry its `epoch`; a main that can't renew stops starting turns, tool
 *  calls and memory writes before `expiresAt`, with a margin for clock error. */
export const LeaseView = z.object({
  /** The computer the user chose, or that was chosen automatically (§6.4). */
  main: DeviceId.nullable(),
  holder: DeviceId.nullable(),
  epoch: z.number().int().nonnegative(),
  expiresAt: Timestamp.nullable(),
  /** The one device that refreshes rotating logins (§8.5). */
  refresher: DeviceId.nullable(),
  state: z.enum(["held", "lapsed", "unreachable", "handing-over"]),
});
export type LeaseView = z.infer<typeof LeaseView>;

/** The shared clock on this device (§6.4): its offset from the reference, measured over the link. */
export const ClockView = z.object({
  reference: z.union([DeviceId, z.literal("public")]),
  offsetMs: z.number(),
  accuracyMs: z.number().nonnegative(),
  synced: z.boolean(),
});
export type ClockView = z.infer<typeof ClockView>;

export const AccountView = z.object({
  signedIn: z.boolean(),
  provider: z.enum(["email", "discord", "google"]).optional(),
  user: z.object({ id: z.string().max(128), email: z.string().max(320).optional(), name: z.string().max(200).optional() }).optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** No-account pairing (§8.1): a code or QR, plus Winter's 4-word check. */
export const PairingView = z.object({
  pairingId: z.string().min(1).max(128),
  code: z.string().min(1).max(64).optional(),
  /** What the QR encodes. */
  qr: z.string().max(4096).optional(),
  words: z.array(z.string().max(32)).length(4).optional(),
  expiresAt: Timestamp,
});

/** An append-only stream two devices replicate (§8.5): `transcript:<session>`, `memory:<bot>`, `plugins`,
 *  `credentials`, `settings`, `routines`, `usage`. Lane H settles the streams and their payloads at H-M3. */
export const SyncStream = z.string().min(1).max(256).regex(/^[a-z][a-z-]*(:[A-Za-z0-9._:/-]+)?$/);
export const SyncEntry = z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  ts: Timestamp,
  device: DeviceId,
  /** End-to-end encrypted where the stream holds secrets (credentials). */
  payload: z.unknown(),
});
export type SyncEntry = z.infer<typeof SyncEntry>;

export const DEVICES_METHODS = {
  deviceList: defineMethod({
    name: "device.list", owner: "H", roles: ["app", "cli", "remote"],
    params: Empty, result: z.object({ devices: z.array(DeviceView) }),
    doc: "Every paired device, phones and browsers included, with its link.",
  }),
  deviceRename: defineMethod({
    name: "device.rename", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "core",
    params: z.object({ id: DeviceId, name: z.string().min(1).max(63) }), result: ChangeResult,
    doc: "Renames a device; a computer keeps its old tree name as an alias (§9.1).",
  }),
  deviceRevoke: defineMethod({
    name: "device.revoke", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "sensitive",
    params: z.object({ id: DeviceId }), result: ChangeResult,
    doc: "Revokes a device: its links are cut at once and a guided rotation of synced keys starts (§8.1).",
  }),
  devicePairBegin: defineMethod({
    name: "device.pair.begin", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: PairingView,
    doc: "Shows a pairing code and QR for a device to join, without an account (§8.1).",
  }),
  devicePairJoin: defineMethod({
    name: "device.pair.join", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ code: z.string().min(1).max(4096) }), result: PairingView,
    doc: "Joins another device's pairing by its code or QR payload; both then show the same four words.",
  }),
  devicePairConfirm: defineMethod({
    name: "device.pair.confirm", owner: "H", roles: ["app", "cli"], userOnly: true, change: "sensitive",
    params: z.object({ pairingId: z.string().min(1).max(128), words: z.array(z.string().max(32)).length(4) }),
    result: ChangeResult,
    doc: "Confirms the four words; adding a device is a sealed card unless made in the user's own terminal.",
  }),
  devicePairCancel: defineMethod({
    name: "device.pair.cancel", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ pairingId: z.string().min(1).max(128) }), result: Ok,
    doc: "Cancels a pairing.",
  }),
  accountStatus: defineMethod({
    name: "account.status", owner: "H", roles: ["app", "cli", "remote"],
    params: Empty, result: AccountView,
    doc: "The waifucave account this computer is signed in with, if any (§8.1).",
  }),
  accountSignIn: defineMethod({
    name: "account.signIn", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: z.object({ provider: z.enum(["email", "discord", "google"]) }),
    result: z.object({ url: z.string().url() }),
    doc: "Starts a sign-in; the client opens the URL. Signing in is enough to add a device (§8.1).",
  }),
  accountSignOut: defineMethod({
    name: "account.signOut", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: Ok,
    doc: "Signs this computer out of the account.",
  }),
  mainGet: defineMethod({
    name: "main.get", owner: "H", roles: ["app", "cli", "remote", "web"],
    params: Empty, result: z.object({ lease: LeaseView }),
    doc: "The main computer, the lease's holder and epoch, and the refresher.",
  }),
  mainSet: defineMethod({
    name: "main.set", owner: "H", roles: ["app", "cli", "remote"], userOnly: true, change: "sensitive",
    params: z.object({ device: DeviceId }), result: ChangeResult,
    doc: "Chooses the main computer; a new cloud computer becomes main only after the user confirms (§6.4).",
  }),
  mainHandOver: defineMethod({
    name: "main.handOver", owner: "H", roles: ["app", "cli"], userOnly: true,
    params: Empty, result: z.object({ to: DeviceId.nullable() }),
    doc: "Releases the lease now so another computer takes the bots (Hand over and quit, a laptop's sleep; §3.1, §6.4).",
  }),
  clockStatus: defineMethod({
    name: "clock.status", owner: "H", roles: ["app", "cli"],
    params: Empty, result: ClockView,
    doc: "This device's shared-clock offset and accuracy (§6.4).",
  }),
  linkList: defineMethod({
    name: "link.list", owner: "H", roles: ["app", "cli"],
    params: Empty, result: z.object({ links: z.array(LinkView) }),
    doc: "This computer's links and their paths.",
  }),

  // Daemon to daemon, over the link.
  peerHello: defineMethod({
    name: "peer.hello", owner: "H", roles: ["peer"],
    params: z.object({ protocolVersion: z.number().int(), device: DeviceId, epoch: z.number().int().nonnegative(), features: z.array(z.string().max(64)).max(64) }),
    result: z.object({ protocolVersion: z.number().int(), device: DeviceId, epoch: z.number().int().nonnegative(), features: z.array(z.string().max(64)) }),
    doc: "Opens a link's session: links negotiate a protocol version and support one release back (§14.2 item 22).",
  }),
  peerCall: defineMethod({
    name: "peer.call", owner: "H", roles: ["peer"],
    params: z.object({
      method: z.string().min(1).max(128),
      params: z.unknown(),
      /** Who called on the peer's own computer, after its caller check, and through which role. The receiving daemon
       *  applies that role's allow list, as if the caller were connected to it. */
      as: Caller,
      role: CloverRole,
    }),
    result: z.object({ result: z.unknown() }),
    doc: "Runs a method on this computer for a caller on another one: a message to a bot that thinks here, a card's answer.",
  }),
  peerSessionDeliver: defineMethod({
    name: "peer.session.send", owner: "D", roles: ["peer"],
    params: z.object({ id: SessionId, message: UserMessageInput, device: DeviceId, sentAt: Timestamp }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "A user's message from another device, already stamped in shared time, for a bot that thinks here (§6.4).",
  }),
  syncHeads: defineMethod({
    name: "sync.heads", owner: "H", roles: ["peer"],
    params: z.object({ streams: z.array(SyncStream).max(10_000).optional() }),
    result: z.object({ heads: z.record(z.string(), z.object({ seq: z.number().int().nonnegative(), epoch: z.number().int().nonnegative() })) }),
    doc: "The last entry of each stream this computer holds.",
  }),
  syncPull: defineMethod({
    name: "sync.pull", owner: "H", roles: ["peer"],
    params: z.object({ stream: SyncStream, after: z.number().int().min(-1), limit: z.number().int().min(1).max(10_000) }),
    result: z.object({ entries: z.array(SyncEntry), more: z.boolean() }),
    doc: "Entries of a stream after a seq.",
  }),
  syncPush: defineMethod({
    name: "sync.push", owner: "H", roles: ["peer"],
    params: z.object({ stream: SyncStream, base: z.number().int().min(-1), entries: z.array(SyncEntry).max(10_000) }),
    result: z.union([z.object({ ok: z.literal(true), head: z.number().int() }), z.object({ ok: z.literal(false), reason: z.enum(["stale_base", "not_writer", "refused"]) })]),
    doc: "Appends entries; a stale base is refused, as Winter's phone sync refuses one (`ipc/sync.ts`).",
  }),
} as const;

export const DeviceChangedEvent = coreEvent("device_changed", { device: DeviceView });
export const DeviceRemovedEvent = coreEvent("device_removed", { id: DeviceId, revoked: z.boolean() });
export const LeaseChangedEvent = coreEvent("lease_changed", { lease: LeaseView });
export const LinkChangedEvent = coreEvent("link_changed", { link: LinkView });
export const PairingChangedEvent = coreEvent("pairing_changed", {
  pairingId: z.string().min(1).max(128),
  step: z.enum(["waiting", "words", "card", "done", "failed", "expired"]),
  words: z.array(z.string().max(32)).length(4).optional(),
  reason: Text.optional(),
});
export const AccountChangedEvent = coreEvent("account_changed", { account: AccountView });

export const DEVICES_EVENTS = {
  deviceChanged: defineEvent({
    type: "device_changed", owner: "H", roles: ["app", "cli", "remote"], schema: DeviceChangedEvent,
    fixture: {
      type: "device_changed", ts: 1781270000000,
      device: { id: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", name: "Laptop1", kind: "desktop", os: "macos", runsCore: true, computer: "Laptop1", hasDisplay: true, online: true, link: { peer: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", up: true, path: "lan", rttMs: 2.4 }, isThis: false, isMain: false, addedAt: 1781200000000 },
    },
    doc: "A device was added or changed, or came online or went offline.",
  }),
  deviceRemoved: defineEvent({
    type: "device_removed", owner: "H", roles: ["app", "cli", "remote"], schema: DeviceRemovedEvent,
    fixture: { type: "device_removed", ts: 1781270000000, id: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", revoked: true },
    doc: "A device was revoked or removed.",
  }),
  leaseChanged: defineEvent({
    type: "lease_changed", owner: "H", roles: ["app", "cli", "remote", "web"], schema: LeaseChangedEvent,
    fixture: { type: "lease_changed", ts: 1781270000000, lease: { main: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", holder: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", epoch: 4, expiresAt: 1781270030000, refresher: "m4p0studio7c2d9e1f3a5b7c9d1e3f5a", state: "held" } },
    doc: "The main computer, the lease's holder, its epoch or the refresher changed.",
  }),
  linkChanged: defineEvent({
    type: "link_changed", owner: "H", roles: ["app", "cli"], schema: LinkChangedEvent,
    fixture: { type: "link_changed", ts: 1781270000000, link: { peer: "k3x9a7mq2c4d8e1f5g6h0j2k4m6n8p0r", up: true, path: "relay", relay: "clover/relay-n0", rttMs: 48 } },
    doc: "A link came up, went down or changed path.",
  }),
  pairingChanged: defineEvent({
    type: "pairing_changed", owner: "H", roles: ["app", "cli"], schema: PairingChangedEvent,
    fixture: { type: "pairing_changed", ts: 1781270000000, pairingId: "pair_1", step: "words", words: ["maple", "orbit", "velvet", "canyon"] },
    doc: "A pairing moved on.",
  }),
  accountChanged: defineEvent({
    type: "account_changed", owner: "H", roles: ["app", "cli", "remote"], schema: AccountChangedEvent,
    fixture: { type: "account_changed", ts: 1781270000000, account: { signedIn: true, provider: "discord", user: { id: "u_1", name: "me" } } },
    doc: "The account was signed in or out.",
  }),
} as const;
