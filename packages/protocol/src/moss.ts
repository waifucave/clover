// MOSS's protocol index: every area's methods and events in one table, each role's allow list, and the event
// subscription. Written by lane B for M0; after M0 the controller owns it (plan §7), and a lane changes only its own
// area file. The allow lists are derived, never hand-kept: a method names its roles, and `allowedMethods(role)` is
// exactly the methods that name it (spec §3.1, §10: a companion plugin can't widen the remote lists).
import { z } from "zod";
import { ACTIVITY_EVENTS, ACTIVITY_METHODS, isKindFamily, kindCapability } from "./activity";
import { AGENTS_EVENTS, AGENTS_METHODS } from "./agents";
import { APP_EVENTS, APP_METHODS } from "./app";
import { APPROVALS_EVENTS, APPROVALS_METHODS } from "./approvals";
import { BOTS_EVENTS, BOTS_METHODS } from "./bots";
import { BROWSER_EVENTS, BROWSER_METHODS } from "./browser";
import { Ok } from "./common";
import { COMPUTERS_EVENTS, COMPUTERS_METHODS } from "./computers";
import { DEVICES_EVENTS, DEVICES_METHODS } from "./devices";
import { HOST_EVENTS, HOST_METHODS } from "./host";
import { PLUGINS_EVENTS, PLUGINS_METHODS } from "./plugins";
import { RELEASE_EVENTS, RELEASE_METHODS } from "./release";
import { MOSS_ROLES, MossHelloParams, MossHelloResult, type MossRole } from "./roles";
import { defineMethod, type EventSpec, type MethodSpec } from "./rpc";
import { SESSIONS_EVENTS, SESSIONS_METHODS } from "./sessions";
import { SURFACES_EVENTS, SURFACES_METHODS } from "./surfaces";
import { USAGE_EVENTS, USAGE_METHODS } from "./usage";

/** The areas, in the order of plan §3, then the split's (spec revision 19, §13). Each is one file with one owning lane. */
export const MOSS_AREAS = ["plugins", "approvals", "sessions", "devices", "computers", "agents", "app", "browser", "usage", "surfaces", "host", "release", "activity", "bots"] as const;
export type MossArea = (typeof MOSS_AREAS)[number];

export const AREA_OWNERS: Record<MossArea, string> = {
  plugins: "B", approvals: "C", sessions: "D (with A)", devices: "H", computers: "J", agents: "K",
  app: "E (with C, D, G, M)", browser: "L", usage: "D",
  surfaces: "RT", host: "HS", release: "RL", activity: "AF", bots: "BT",
};

const AllRoles = MOSS_ROLES;

/** A base64url nonce (no padding) of 16 to 96 bytes. */
const Base64UrlNonce = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => {
  const bytes = Math.floor((v.length * 3) / 4);
  return v.length % 4 !== 1 && bytes >= 16 && bytes <= 96;
}, "a base64url nonce of 16 to 96 bytes");

/** What `protocol.prove`'s HMAC covers: `moss-daemon-proof\0<nonce>\0<pid>`. */
export function daemonProofInput(nonce: string, pid: number): string {
  return `moss-daemon-proof\0${nonce}\0${pid}`;
}

/** Methods every connection has, whatever its area. */
export const CORE_METHODS = {
  hello: defineMethod({
    name: "protocol.hello", owner: "C", roles: AllRoles,
    params: MossHelloParams, result: MossHelloResult,
    doc: "The first call on every connection: the role, its token, and who the connection counts as (§3.1).",
  }),
  /** Before its hello, on its own connection, the app asks the daemon to prove it is this run's (lane C's S3): `proof`
   *  is base64url HMAC-SHA256 under the run's app token over `daemonProofInput(nonce, pid)`, and `pid` the client's
   *  pid as the daemon sees it on that connection. The app checks both (`checkDaemonProof`). */
  prove: defineMethod({
    name: "protocol.prove", owner: "C", roles: ["app"],
    params: z.object({ nonce: Base64UrlNonce }),
    result: z.object({ proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/), pid: z.number().int().positive() }),
    doc: "The daemon proves it holds this run's app token, before the app's hello.",
  }),
  eventsSubscribe: defineMethod({
    name: "events.subscribe", owner: "C", roles: ["app", "cli", "layer", "remote", "web", "peer"],
    params: z.object({ areas: z.array(z.enum(MOSS_AREAS)).min(1).max(MOSS_AREAS.length) }), result: Ok,
    doc: "Receive the `core.event`s of these areas that this role may receive.",
  }),
  eventsUnsubscribe: defineMethod({
    name: "events.unsubscribe", owner: "C", roles: ["app", "cli", "layer", "remote", "web", "peer"],
    params: z.object({ areas: z.array(z.enum(MOSS_AREAS)).min(1).max(MOSS_AREAS.length) }), result: Ok,
    doc: "Stop receiving these areas' events.",
  }),
} as const;

export const AREA_METHODS = {
  plugins: PLUGINS_METHODS,
  approvals: APPROVALS_METHODS,
  sessions: SESSIONS_METHODS,
  devices: DEVICES_METHODS,
  computers: COMPUTERS_METHODS,
  agents: AGENTS_METHODS,
  app: APP_METHODS,
  browser: BROWSER_METHODS,
  usage: USAGE_METHODS,
  surfaces: SURFACES_METHODS,
  host: HOST_METHODS,
  release: RELEASE_METHODS,
  activity: ACTIVITY_METHODS,
  bots: BOTS_METHODS,
} as const satisfies Record<MossArea, Record<string, MethodSpec>>;

export const AREA_EVENTS = {
  plugins: PLUGINS_EVENTS,
  approvals: APPROVALS_EVENTS,
  sessions: SESSIONS_EVENTS,
  devices: DEVICES_EVENTS,
  computers: COMPUTERS_EVENTS,
  agents: AGENTS_EVENTS,
  app: APP_EVENTS,
  browser: BROWSER_EVENTS,
  usage: USAGE_EVENTS,
  surfaces: SURFACES_EVENTS,
  host: HOST_EVENTS,
  release: RELEASE_EVENTS,
  activity: ACTIVITY_EVENTS,
  bots: BOTS_EVENTS,
} as const satisfies Record<MossArea, Record<string, EventSpec>>;

/** Every MOSS method, by wire name. */
export const MOSS_METHODS: ReadonlyMap<string, MethodSpec & { area: MossArea | "core" }> = (() => {
  const all = new Map<string, MethodSpec & { area: MossArea | "core" }>();
  const add = (area: MossArea | "core", spec: MethodSpec) => {
    if (all.has(spec.name)) throw new Error(`duplicate MOSS method ${spec.name}`);
    all.set(spec.name, { ...spec, area });
  };
  for (const spec of Object.values(CORE_METHODS)) add("core", spec);
  for (const area of MOSS_AREAS) for (const spec of Object.values(AREA_METHODS[area])) add(area, spec);
  return all;
})();

/** Every MOSS event, by `type`. */
export const MOSS_EVENTS: ReadonlyMap<string, EventSpec & { area: MossArea }> = (() => {
  const all = new Map<string, EventSpec & { area: MossArea }>();
  for (const area of MOSS_AREAS) {
    for (const spec of Object.values(AREA_EVENTS[area])) {
      if (all.has(spec.type)) throw new Error(`duplicate MOSS event ${spec.type}`);
      all.set(spec.type, { ...spec, area });
    }
  }
  return all;
})();

/** The methods a role may call. A request outside its list is refused before dispatch (`MOSS_ERR.ROLE_REFUSED`). */
export function allowedMethods(role: MossRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of MOSS_METHODS.values()) if (spec.direction === "to-daemon" && spec.roles.includes(role)) out.add(spec.name);
  return out;
}

/** The requests the daemon may send to a client of this role (the app's tabs, the plugin host's workers). */
export function daemonRequestsTo(role: MossRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of MOSS_METHODS.values()) if (spec.direction === "from-daemon" && spec.roles.includes(role)) out.add(spec.name);
  return out;
}

/** The events a role may receive. */
export function allowedEvents(role: MossRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of MOSS_EVENTS.values()) if (spec.roles.includes(role)) out.add(spec.type);
  return out;
}

/** The allow lists a `peer.call` may name: a paired computer reaches what a remote client may, never more (§8.5). */
export const PEER_CALL_ROLES = ["remote", "web"] as const;

/** What a receiving daemon does with a `peer.call` (lane H's door, B1 of the review):
 *  * `refused`: the role isn't a remote one, the method isn't on that role's list, it is a peer method itself, or it is
 *    `noSessions` and the call isn't the user's on the calling computer (`as.kind` other than `user`);
 *  * `needs-answer`: the method is `userOnly` or a `change`, so it runs only with the user's signed answer bound to
 *    this call (`SignedCardAnswer`, `CallBinding`), which the receiver verifies itself;
 *  * `allowed`: it runs as the peer device the link authenticated, never as the user's own terminal, and never past
 *    the fence. */
export function peerCallVerdict(method: string, role: string, as?: { kind: string }): "refused" | "needs-answer" | "allowed" {
  if (!(PEER_CALL_ROLES as readonly string[]).includes(role) || method.startsWith("peer.")) return "refused";
  const spec = MOSS_METHODS.get(method);
  if (!spec || !allowedMethods(role as MossRole).has(method)) return "refused";
  // What only the user may read is read for the user alone (`noSessions`): never for a session, a plugin or the core of
  // the calling computer.
  if (spec.noSessions && as?.kind !== "user") return "refused";
  return spec.userOnly || spec.change !== undefined ? "needs-answer" : "allowed";
}

/** Whether a plugin caller with these capabilities may call a method (§5.4): plugin roles need the method's
 *  capability; `call:*` means `call:<the target's top-level id>`, checked against the command's plugin; a family by kind
 *  (`activity.read.*`, `picture.read.*`, spec revision 19 §3.6) means that family's capability for the kind of data the
 *  call reaches, `target` (`sessions` or `bots`), and is refused without one. */
export function pluginMayCall(method: MethodSpec, capabilities: readonly string[], target?: string): boolean {
  if (method.capability === undefined) return true;
  if (method.capability === "call:*") {
    if (target === undefined) return false;
    return capabilities.includes(`call:${target.split("/")[0]}`);
  }
  if (isKindFamily(method.capability)) {
    if (target !== "sessions" && target !== "bots") return false;
    return capabilities.includes(kindCapability(method.capability, target));
  }
  return capabilities.includes(method.capability);
}

/** Every MOSS `core` event as one union. It refuses a type it doesn't know, so a client decodes with
 *  `decodeMossCoreEvent`, which skips one: the daemon may add events within a protocol version. */
export const MossCoreEvent = z.discriminatedUnion(
  "type",
  [...MOSS_EVENTS.values()].filter((e) => e.scope === "core").map((e) => e.schema) as unknown as [
    z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[],
  ],
);
export type MossCoreEvent = z.infer<typeof MossCoreEvent>;

/** A `core.event` as a client reads it: `event` when its type is known and it parses, `skip` with the type when the
 *  type is one this client doesn't know (a newer daemon's), `invalid` when a known type doesn't parse. */
export function decodeMossCoreEvent(raw: unknown):
  | { kind: "event"; event: MossCoreEvent }
  | { kind: "skip"; type: string }
  | { kind: "invalid"; type?: string; error: string } {
  const type = typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string" ? (raw as { type: string }).type : undefined;
  if (type === undefined) return { kind: "invalid", error: "an event has a string `type`" };
  const spec = MOSS_EVENTS.get(type);
  if (!spec || spec.scope !== "core") return { kind: "skip", type };
  const parsed = MossCoreEvent.safeParse(raw);
  return parsed.success ? { kind: "event", event: parsed.data } : { kind: "invalid", type, error: parsed.error.message };
}
