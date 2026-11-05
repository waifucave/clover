// Clover's connection roles and its hello (spec §3.1, §5.5, §9.3, §10). Owner: lane C (roles and tokens, C-M1),
// pinned here by lane B at M0. Every client says hello with its role and proves it with a token; each role has its
// own allow list, which clover.ts derives from the method specs of every area (a method names the roles that may
// call it). On top of the role, the daemon runs the caller check (§3.1): an `app` or `cli` connection counts as the
// user only from outside every sandbox and escape floor, and a `cli` started under a bot's or agent's session acts
// as that session. `protocol.hello`'s result says who the connection counts as.
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, CLOVER_PROTOCOL_MIN_VERSION, Caller, DeviceId, SessionId } from "./common";

export const CLOVER_ROLES = [
  /** The Clover app's main process (Electron). Its `clover` layer changes the core's settings directly (§5.5). */
  "app",
  /** One third-party plugin's UI layer (§5.5), on a connection the app's main process opens for that layer, bound
   *  to the plugin's id by its token. No layer has Node; this is how its plugin API reaches the core. */
  "layer",
  /** The CLI and TUI. The user from their own terminal; a bot's or agent's session from inside one (§3.1). */
  "cli",
  /** The plugin host (§5.2), over the pipe it was started with. It speaks only its channel (`pluginHost.*`): a host
   *  half's plugin-API calls go through `pluginHost.api`, whose `pluginId` the host stamps from its own worker table,
   *  so the daemon knows which plugin each call is for (review S3). */
  "plugin-host",
  /** One ACP agent session's bridge MCP server (§9.3): its tools, `SendMessage` and `Glossary`, nothing else. */
  "bridge",
  /** The iOS app, through its companion plugin, on the core's own link (§10). A companion can't widen this list. */
  "remote",
  /** The web companion (§8.4), with a shorter list than `remote` (spec §14.2 item 5: chat and read-only activity). */
  "web",
  /** Another computer's clover-core over the persistent link (§8.2): sync, the folder tree, tools across computers. */
  "peer",
] as const;
export const CloverRole = z.enum(CLOVER_ROLES);
export type CloverRole = z.infer<typeof CloverRole>;

/** Roles that reach the daemon from another device. Everything they may do is on a fixed list (§10). */
export const REMOTE_ROLES: readonly CloverRole[] = ["remote", "web", "peer"];
/** Roles whose calls are made for a plugin, so capability checks apply (§5.4). */
export const PLUGIN_ROLES: readonly CloverRole[] = ["layer", "plugin-host"];
/** Roles that can count as the user once the caller check passes (§3.1). */
export const USER_ROLES: readonly CloverRole[] = ["app", "cli", "remote", "web"];

/** Whether a daemon serves a client's hello at this version (review minor): `CLOVER_PROTOCOL_VERSION` or older, down to
 *  `CLOVER_PROTOCOL_MIN_VERSION` (common.ts). An older hello is refused with `CLOVER_ERR.VERSION_REFUSED` and
 *  `{ min, max }`; a newer client talks at the daemon's version, which the hello's result says. Within a version the
 *  daemon may add events and optional fields, so a client skips an event type it doesn't know
 *  (`decodeCloverCoreEvent`); anything else takes a new version. */
export function helloVersionServed(clientVersion: number): boolean {
  return Number.isInteger(clientVersion) && clientVersion >= CLOVER_PROTOCOL_MIN_VERSION;
}

/** `protocol.hello`, Clover's form. The inherited method's name (`METHODS.hello`); C-M1 switches the daemon to it. */
export const CloverHelloParams = z.object({
  protocolVersion: z.number().int(),
  role: CloverRole,
  token: utf16(4096, 1),
  clientName: utf16(128, 1),
  /** `layer`: the plugin whose layer this is (the token is bound to it). */
  pluginId: AnyPluginId.optional(),
  /** `bridge`: the agent session the bridge serves (the token is bound to it, §9.3). */
  agentSessionId: SessionId.optional(),
  /** `remote`, `web`, `peer`: the device on the other end, which the link also proves. */
  device: DeviceId.optional(),
  /** Client features the daemon may rely on, by name; unknown names are ignored. */
  features: z.array(utf16(64, 1)).max(32).optional(),
});
export type CloverHelloParams = z.infer<typeof CloverHelloParams>;

export const CloverHelloResult = z.object({
  ok: z.literal(true),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
  /** Who this connection counts as after the caller check (§3.1). */
  caller: Caller,
  /** This computer's device id. */
  device: DeviceId,
  /** Daemon features, by name; a client asks before relying on one. */
  features: z.array(z.string()),
});
export type CloverHelloResult = z.infer<typeof CloverHelloResult>;
