// Clover's shared protocol vocabulary (spec revision 17): ids, text, platforms, levels, callers and turn origins.
// Every Clover area file (plugins.ts, approvals.ts, sessions.ts, devices.ts, computers.ts, agents.ts, app.ts,
// browser.ts, usage.ts) builds on these, and so do the plugin SDK and the core's contracts
// (`packages/core/src/contracts/`). Owner: lane B for M0, then the controller, with the protocol's index (plan §7).
//
// The inherited protocol (events.ts, methods.ts, cowork.ts) stays beside this until C1 retires it method by method;
// nothing here changes the inherited wire. Names here never repeat an inherited export (the index exports both).
import { z } from "zod";
import { utf16 } from "./strings";

/** Clover's protocol version, sent in `protocol.hello` both ways (roles.ts). Today's daemon speaks `PROTOCOL_VERSION`
 *  (0). `CLOVER_PROTOCOL_MIN_VERSION` is the oldest a daemon still serves (`helloVersionServed`). */
export const CLOVER_PROTOCOL_VERSION = 1;
export const CLOVER_PROTOCOL_MIN_VERSION = 1;

/** The thirteen lanes of the plan (§4). Every method and event names the lane that implements it. */
export const LANES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"] as const;
export type Lane = (typeof LANES)[number];

// -------------------------------------------------------------------------------------------------
// Ids
// -------------------------------------------------------------------------------------------------

/** A plugin id (spec §5.1): lowercase letters, digits and single hyphens, a letter first, 2–40 characters. So an id
 *  never holds `_` or `.`, and tool names always split cleanly (§6.7). A top-level id equals its folder name. */
export const PLUGIN_ID_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
export const PLUGIN_ID_RE = new RegExp(PLUGIN_ID_PATTERN);
export const PLUGIN_ID_MIN = 2;
export const PLUGIN_ID_MAX = 40;

/** True for a valid top-level plugin id (also the rule for a child's folder name). */
export function isPluginId(s: string): boolean {
  return s.length >= PLUGIN_ID_MIN && s.length <= PLUGIN_ID_MAX && PLUGIN_ID_RE.test(s);
}

/** A child plugin's id is `<parent>/<folder>`, one level deep (§5.1). */
export function isAnyPluginId(s: string): boolean {
  const parts = s.split("/");
  if (parts.length === 1) return isPluginId(s);
  return parts.length === 2 && isPluginId(parts[0]!) && isPluginId(parts[1]!);
}

/** Wherever a plugin id names a file, a folder or an origin, its `/` is written `--`, which no id can contain
 *  (§5.1): `luna/tarot-panel` → `luna--tarot-panel`. */
export function pluginIdToSegment(id: string): string {
  return id.replace("/", "--");
}
export function pluginIdFromSegment(segment: string): string {
  return segment.replace("--", "/");
}

/** The top-level plugin of an id: `luna/tarot-panel` → `luna`. */
export function topPluginIdOf(id: string): string {
  return id.split("/")[0]!;
}

export const TopPluginId = utf16(PLUGIN_ID_MAX, PLUGIN_ID_MIN).regex(PLUGIN_ID_RE);
/** A top-level or child plugin id: `luna`, `luna/tarot-panel`. */
export const ANY_PLUGIN_ID_PATTERN = "^[a-z][a-z0-9]*(-[a-z0-9]+)*(/[a-z][a-z0-9]*(-[a-z0-9]+)*)?$";
export const AnyPluginId = utf16(PLUGIN_ID_MAX * 2 + 1).regex(new RegExp(ANY_PLUGIN_ID_PATTERN))
  .refine(isAnyPluginId, { message: "not a plugin id: each part is 2–40 characters" });
/** A bot's id is its plugin's id (§6.1), a child's included (`pack/luna`). */
export const BotId = AnyPluginId;

/** The plugins we ship (§5.1). No core rule names any other plugin (§5.3). */
export const BUNDLED_ROOT_PLUGIN = "clover";

/** The plugin-host process a host half runs in (§5.2, amended by the owner's answer to S4). `clover`: the bundled
 *  `clover` tree's own, which no third-party worker shares, so none can act as the forwarder, use the account token
 *  or open with the core's key pairs; `shared`: the one every other plugin's host halves share, whose workers aren't
 *  isolated from each other's memory; `own`: a process of the plugin's own (Node or native modules, an adapter that
 *  signs with its secret). The core decides it from the install record, never from what a plugin claims. */
export const HOST_PROCESSES = ["clover", "shared", "own"] as const;
export const HostProcess = z.enum(HOST_PROCESSES);
export type HostProcess = z.infer<typeof HostProcess>;
export const BUNDLED_BOT_PLUGIN = "alpha";

/** A session: a bot's main conversation, a side thread, a background agent or a coding session (§9.3). */
export const SessionId = utf16(128, 1).regex(/^[A-Za-z0-9._:-]+$/);
/** A device: its Ed25519 public key in the text form the link uses (lane H fixes the exact encoding at H-M1). */
export const DeviceId = z.string().regex(/^[a-z0-9]{16,64}$/);
/** A computer's name in the folder tree (`home/<Computer>/`): letters, digits and hyphens, unique (§9.1). */
export const COMPUTER_NAME_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
export const ComputerName = utf16(63, 1).regex(COMPUTER_NAME_RE);
/** An approval card (§5.5). */
export const CardId = z.string().regex(/^card_[A-Za-z0-9_-]{6,64}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** A plugin tree's hash (§5.1): SHA-256 over the sorted file list, written `sha256:<hex>` (plugin SDK `treeHash`). */
export const TreeHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A path in the folder tree (§9.1): `home/<Computer>/…` or `bots/<bot>/…`, always with `/`. */
export const TreePath = utf16(4096, 1).regex(/^(home|bots)(\/|$)/);
/** Milliseconds since the Unix epoch, in the shared clock's time (§6.4). */
export const Timestamp = z.number().int().nonnegative();
/** A semver version, as plugins and the app carry them. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const SemverVersion = utf16(256).regex(SEMVER_RE);

// -------------------------------------------------------------------------------------------------
// Text, platforms, scope
// -------------------------------------------------------------------------------------------------

/** User-facing text: a string, or translations keyed by language with English required (§5.5, §5.9). */
export const Text = z.union([z.string(), z.object({ en: z.string() }).catchall(z.string())]);
export type Text = z.infer<typeof Text>;

export const Os = z.enum(["macos", "windows", "linux"]);

/** Where a computer's secrets file keeps its key (§8.5, §9.1): Windows' Credential Manager; an unlocked Secret Service
 *  keyring on Linux; on a headless Linux computer with none unlocked, sealed by `systemd-creds --user` (systemd 256 or
 *  later, with the TPM where one exists); otherwise a key file only the user can read, which Settings labels
 *  plaintext. Bash's fence hides the secrets file and any key file from bots on every one (§9.1). */
export const SECRET_KEY_SOURCES = ["credential-manager", "secret-service", "systemd-creds", "key-file"] as const;
export const SecretKeySource = z.enum(SECRET_KEY_SOURCES);
export type SecretKeySource = z.infer<typeof SecretKeySource>;

/** A computer's secret store as Settings shows it (lane C). Never a value. */
export const SecretStoreView = z.object({
  /** The Keychain on macOS; one encrypted file on Windows and Linux; memory in tests. */
  backend: z.enum(["keychain", "encrypted-file", "memory"]),
  keySource: SecretKeySource.optional(),
  /** `systemd-creds` sealed the key with the TPM as well. */
  tpm: z.boolean().optional(),
  /** The label Settings shows when the key sits on disk unsealed (`key-file`): this computer's secrets are as safe as
   *  the user's own account on it. */
  plaintext: z.boolean(),
  /** `locked` only for a desktop store someone can unlock (a locked keyring at the login screen); a headless computer
   *  falls back to `systemd-creds` or the key file and never waits. */
  state: z.enum(["unlocked", "locked"]),
  /** Why it is locked, for Settings. */
  reason: utf16(200).optional(),
});
export type SecretStoreView = z.infer<typeof SecretStoreView>;
export type Os = z.infer<typeof Os>;

/** A device's OS (lane H's ask): a computer's, or a phone's `ios`. `Os` stays the computers' alone, since the fence,
 *  the platforms and the tree are kept per computer OS. */
export const DeviceOs = z.enum([...Os.options, "ios"]);
export type DeviceOs = z.infer<typeof DeviceOs>;

/** Whether a device's OS is one a computer runs (a phone's `ios` never is). */
export const isComputerOs = (os: DeviceOs): os is Os => os !== "ios";
/** The daemon's four targets; no darwin-x64, since macOS 27 is Apple silicon only (§3.1, §4). */
export const Platform = z.enum(["darwin-arm64", "windows-x64", "linux-x64", "linux-arm64"]);
export type Platform = z.infer<typeof Platform>;
/** What a plugin's MCP servers, skills, agent definitions and hooks reach (§5.1). */
export const Scope = z.enum(["bots", "agents", "both"]);
export type Scope = z.infer<typeof Scope>;
/** Where a host half or an entry runs (§5.2): every computer, the main, or the computers the user ticks. */
export const RunsOn = z.enum(["each", "main", "chosen"]);
export type RunsOn = z.infer<typeof RunsOn>;

// -------------------------------------------------------------------------------------------------
// Levels, callers, origins
// -------------------------------------------------------------------------------------------------

/** A computer's (or a routine's) approval level (§9.1): read only, ask, ask for risky actions (the default, today's
 *  `auto` with the reviewer), accept edits, and fully automatic (today's `bypass`). Ordered lowest first. */
/** A total order, strictest first (the controller's ruling on the review's S1): accept-edits is ask-risky plus edits and
 *  moves, so each level allows everything the one before it does. read-only is absolute: no saved rule overrides it. */
export const LEVELS = ["read-only", "ask", "ask-risky", "accept-edits", "automatic"] as const;
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;
export const DEFAULT_LEVEL: Level = "ask-risky";
/** True when `a` grants more than `b` (raising a level is a sealed card, §5.5). */
export function levelAbove(a: Level, b: Level): boolean {
  return LEVELS.indexOf(a) > LEVELS.indexOf(b);
}

/** The kinds of session (§9.3): a bot's main conversation, a side thread (a routine run), a background agent, and a
 *  coding session the user started. */
export const SessionKind = z.enum(["bot", "side-thread", "agent", "coding"]);
export type SessionKind = z.infer<typeof SessionKind>;

/** The client a user acts through. */
export const ClientKind = z.enum(["app", "cli", "ios", "web"]);
export type ClientKind = z.infer<typeof ClientKind>;

/** Who called (§5.4 "The caller"): the user and the client, a bot's or agent's session, a plugin by id, or the core
 *  itself (the routine engine, a hook run, compaction). The caller check (§3.1) decides between `user` and `session`
 *  for a CLI or app connection: a command started by a bot, an agent or a plugin never counts as the user. */
/** The main computer's fencing token (H-M2's review, and its check 2): the lease's scope (an account's, or an
 *  account-less group's), its epoch and its holder. An act one computer asks of another (`peer.call`, a tree call, a
 *  level change) carries the sender's as `fence`, and the receiver judges it against its own lease (`fenceVerdict`),
 *  so a main that lost its lease without knowing can't act through others. */
export const FencingToken = z.object({ scope: utf16(128, 1), epoch: z.number().int().nonnegative(), holder: utf16(64, 1) });
export type FencingToken = z.infer<typeof FencingToken>;

/** What a receiver knows of its own lease, from its own lease events: the scope it belongs to, and the newest epoch
 *  and holder it has seen. */
export interface FenceView {
  scope: string;
  epoch: number;
  holder: string | null;
}

/** `ok`; `stale`: another scope (a receiver takes only its own lease's), an epoch other than its own lease's (older,
 *  or ahead of what its own records say), or the same epoch from another holder (a split takeover, where two computers
 *  each think they won); `missing`: no token, where the receiver has
 *  seen tokens for its scope, so an act without one is refused; `lapsed`: the receiver's own lease has lapsed (no
 *  holder), and with nobody main, nobody acts (#237's ruling). */
export type FenceVerdict = "ok" | "stale" | "missing" | "lapsed";

/** Judges an act's token against the receiver's own lease (`own`, undefined while it has none). The receiver's view
 *  moves only from its own lease records, never from a token (#187's check 2): a token ahead of it is refused until
 *  those records catch up, so a forged far-ahead epoch can't lock the real main out. */
export function fenceVerdict(own: FenceView | undefined, token: FencingToken | undefined, seenForScope: boolean): FenceVerdict {
  // A lapsed lease (a scope, no holder): every act is refused, a token for the lapsed epoch included.
  if (own !== undefined && own.holder === null) return "lapsed";
  if (token === undefined) return seenForScope ? "missing" : "ok";
  if (own === undefined) return "stale"; // a receiver with no lease of its own can't place a token's scope
  if (token.scope !== own.scope) return "stale";
  if (token.epoch !== own.epoch) return "stale";
  if (token.holder !== own.holder) return "stale";
  return "ok";
}

export const Caller = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), client: ClientKind, device: DeviceId.optional() }),
  z.object({ kind: z.literal("session"), sessionId: SessionId, sessionKind: SessionKind, bot: BotId.optional() }),
  z.object({ kind: z.literal("plugin"), pluginId: AnyPluginId }),
  z.object({ kind: z.literal("core") }),
  /** Another computer over the link (§8.2), for one of its sessions: never the user, always fenced, and its writes
   *  judged at the stricter of this computer's level and the call's (review N2). */
  z.object({ kind: z.literal("peer"), device: DeviceId, sessionId: SessionId.optional(), bot: BotId.optional() }),
]);
export type Caller = z.infer<typeof Caller>;

/** What started a turn. A card or question from a turn the user's own message did not start is denied after 10
 *  minutes unanswered; one from a turn the user started waits (§5.5, §9.1, the inherited `isHumanTurnOrigin`). */
/** `peer`: a user's message another computer relayed without the sending device's good signature (review N3). It
 *  reaches the session as the user's words, but its turn is not the user's. */
export const TurnOrigin = z.enum(["user", "bot", "routine", "task-notification", "agent", "plugin", "peer"]);
export type TurnOrigin = z.infer<typeof TurnOrigin>;
export function isUserTurn(origin: TurnOrigin): boolean {
  return origin === "user";
}
/** The 10-minute rule (§5.5): how long a card from a turn the user did not start waits. */
export const UNATTENDED_CARD_TIMEOUT_MS = 10 * 60 * 1000;

// -------------------------------------------------------------------------------------------------
// Results shared by every area
// -------------------------------------------------------------------------------------------------

/** What a change returns. A sensitive change (§5.5) ends in a sealed card unless the user makes it in their own
 *  terminal; a change to the core's settings from a layer other than `clover`'s becomes a card too. The card's
 *  answer arrives as `card_resolved` (approvals.ts). */
export const ChangeResult = z.union([
  z.object({ applied: z.literal(true) }),
  z.object({ applied: z.literal(false), card: CardId }),
]);
export type ChangeResult = z.infer<typeof ChangeResult>;

export const Ok = z.object({ ok: z.literal(true) });
export const Empty = z.object({});

/** A page cursor (opaque to clients). */
export const Cursor = utf16(512, 1);

/** Error codes Clover adds to JSON-RPC's (the inherited `ERR` keeps its own, jsonrpc.ts). */
export const CLOVER_ERR = {
  /** The role may not call this method (the allow lists, clover.ts). */
  ROLE_REFUSED: -32010,
  /** A plugin caller lacks the capability the method needs (§5.4). */
  CAPABILITY_REFUSED: -32011,
  /** The caller check found no user: a bot, agent or plugin may not do this (§3.1). */
  NOT_THE_USER: -32012,
  /** The computer is off; never hangs (§9.1). */
  COMPUTER_OFFLINE: -32013,
  /** The plugin is stopped, with the reason (§5.1). */
  PLUGIN_STOPPED: -32014,
  /** `call:<plugin-id>` names a plugin that isn't installed (§5.4). */
  NOT_INSTALLED: -32015,
  /** No live connection to the computer running the bot, so the message can't be sent (§6.4). */
  BOT_ASLEEP: -32016,
  /** The fence refuses the path (§9.1). */
  FENCED: -32017,
  /** This device doesn't hold the main computer's lease (§6.4). */
  NOT_MAIN: -32018,
  /** `protocol.hello` named a protocol version older than the daemon serves; `data` is `{ min, max }`. */
  VERSION_REFUSED: -32019,
  /** A plugin-host connection named a plugin that doesn't run in its process (a third-party worker presenting a
   *  `clover/*` id), or made a call only the `clover` process makes (the account token, `keys.*`; S4). */
  PROCESS_REFUSED: -32020,
} as const;
