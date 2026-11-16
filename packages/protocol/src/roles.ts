// MOSS's connection roles and its hello (spec §3.1, §5.5, §9.3, §10). Owner: lane C (roles and tokens, C-M1),
// pinned here by lane B at M0. Every client says hello with its role and proves it with a token; each role has its
// own allow list, which moss.ts derives from the method specs of every area (a method names the roles that may
// call it). On top of the role, the daemon runs the caller check (§3.1): an `app` or `cli` connection counts as the
// user only from outside every sandbox and escape floor, and a `cli` started under a bot's or agent's session acts
// as that session. `protocol.hello`'s result says who the connection counts as.
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, MOSS_PROTOCOL_MIN_VERSION, Caller, DeviceId, HostProcess, SessionId } from "./common";
import { HelloRelease, Release } from "./release";
import { MountList, Surface } from "./surfaces";

export const MOSS_ROLES = [
  /** The MOSS app's main process (Electron). Its `moss` layer changes the core's settings directly (§5.5). */
  "app",
  /** One third-party plugin's UI layer (§5.5), on a connection the app's main process opens for that layer, bound
   *  to the plugin's id by its token. No layer has Node; this is how its plugin API reaches the core. */
  "layer",
  /** The CLI and TUI. The user from their own terminal; a bot's or agent's session from inside one (§3.1). */
  "cli",
  /** A plugin-host process (§5.2), over the pipe it was started with: the bundled `moss` tree's own, the shared one
   *  for every other plugin, or a plugin's own (the owner's answer to S4). Its token binds the connection to that
   *  process (`hostProcess` in the hello), which the core decided from the install record. It speaks only its
   *  channel (`pluginHost.*`): a host half's plugin-API calls go through `pluginHost.api`, whose `pluginId` the host
   *  stamps from its own worker table, and a call naming a plugin that doesn't run in the connection's process is
   *  refused (review S3, S4). */
  "plugin-host",
  /** One ACP agent session's bridge MCP server (§9.3): its tools, `SendMessage` and `Glossary`, nothing else. */
  "bridge",
  /** The iOS app, through its companion plugin, on the core's own link (§10). A companion can't widen this list. */
  "remote",
  /** The web companion (§8.4), with a shorter list than `remote` (spec §14.2 item 5: chat and read-only activity). */
  "web",
  /** Another computer's moss-core over the persistent link (§8.2): sync, the folder tree, tools across computers. */
  "peer",
] as const;
export const MossRole = z.enum(MOSS_ROLES);
export type MossRole = z.infer<typeof MossRole>;

/** Roles that reach the daemon from another device. Everything they may do is on a fixed list (§10). */
export const REMOTE_ROLES: readonly MossRole[] = ["remote", "web", "peer"];
/** Roles whose calls are made for a plugin, so capability checks apply (§5.4). */
export const PLUGIN_ROLES: readonly MossRole[] = ["layer", "plugin-host"];
/** Roles that can count as the user once the caller check passes (§3.1). */
export const USER_ROLES: readonly MossRole[] = ["app", "cli", "remote", "web"];

/** Whether a daemon serves a client's hello at this version (review minor): `MOSS_PROTOCOL_VERSION` or older, down to
 *  `MOSS_PROTOCOL_MIN_VERSION` (common.ts). An older hello is refused with `MOSS_ERR.VERSION_REFUSED` and
 *  `{ min, max }`; a newer client talks at the daemon's version, which the hello's result says. Within a version the
 *  daemon may add events and optional fields, so a client skips an event type it doesn't know
 *  (`decodeMossCoreEvent`); anything else takes a new version. */
export function helloVersionServed(clientVersion: number): boolean {
  return Number.isInteger(clientVersion) && clientVersion >= MOSS_PROTOCOL_MIN_VERSION;
}

/** `protocol.hello`, MOSS's form. The inherited method's name (`METHODS.hello`); C-M1 switches the daemon to it. */
export const MossHelloParams = z.object({
  protocolVersion: z.number().int(),
  role: MossRole,
  token: utf16(4096, 1),
  clientName: utf16(128, 1),
  /** `layer`: the plugin whose layer this is (the token is bound to it). */
  pluginId: AnyPluginId.optional(),
  /** `bridge`: the agent session the bridge serves (the token is bound to it, §9.3). */
  agentSessionId: SessionId.optional(),
  /** `plugin-host`: which plugin-host process this is; the token is bound to it, so a claim that differs is refused. */
  hostProcess: HostProcess.optional(),
  /** `remote`, `web`, `peer`: the device on the other end, which the link also proves. */
  device: DeviceId.optional(),
  /** Client features the daemon may rely on, by name; unknown names are ignored. */
  features: z.array(utf16(64, 1)).max(32).optional(),
  /** `app` only (spec revision 19, G1): which surface this client is, MOSS's window (`moss`), MOSS Code's (`code`) or
   *  the background host (`host`); absent is `code`, today's app. It picks the mount list and grants no method; the
   *  daemon refuses it on another role and refuses a second live `host` (`MOSS_ERR.SURFACE_REFUSED`). */
  surface: Surface.optional(),
  /** The client's release (§3.1 "One release for everything"): an older one than the engine's is refused
   *  (`MOSS_ERR.RELEASE_REFUSED`), a newer one gets the release door only. Absent: not judged. */
  release: Release.optional(),
});
export type MossHelloParams = z.infer<typeof MossHelloParams>;

export const MossHelloResult = z.object({
  ok: z.literal(true),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
  /** Who this connection counts as after the caller check (§3.1). */
  caller: Caller,
  /** This computer's device id. */
  device: DeviceId,
  /** Daemon features, by name; a client asks before relying on one. */
  features: z.array(z.string()),
  /** An `app` hello's surface, as the daemon took it (absent `surface` is `code`), and what it mounts there (§3.4). */
  surface: Surface.optional(),
  mount: MountList.optional(),
  /** When the hello named a release: the engine's, and whether this connection is served (`same`) or has the release door
   *  only (`ahead`). */
  release: HelloRelease.optional(),
});
export type MossHelloResult = z.infer<typeof MossHelloResult>;
