// Clover's protocol index: every area's methods and events in one table, each role's allow list, and the event
// subscription. Written by lane B for M0; after M0 the controller owns it (plan §7), and a lane changes only its own
// area file. The allow lists are derived, never hand-kept: a method names its roles, and `allowedMethods(role)` is
// exactly the methods that name it (spec §3.1, §10: a companion plugin can't widen the remote lists).
import { z } from "zod";
import { AGENTS_EVENTS, AGENTS_METHODS } from "./agents";
import { APP_EVENTS, APP_METHODS } from "./app";
import { APPROVALS_EVENTS, APPROVALS_METHODS } from "./approvals";
import { BROWSER_EVENTS, BROWSER_METHODS } from "./browser";
import { Ok } from "./common";
import { COMPUTERS_EVENTS, COMPUTERS_METHODS } from "./computers";
import { DEVICES_EVENTS, DEVICES_METHODS } from "./devices";
import { PLUGINS_EVENTS, PLUGINS_METHODS } from "./plugins";
import { CLOVER_ROLES, CloverHelloParams, CloverHelloResult, type CloverRole } from "./roles";
import { defineMethod, type EventSpec, type MethodSpec } from "./rpc";
import { SESSIONS_EVENTS, SESSIONS_METHODS } from "./sessions";
import { USAGE_EVENTS, USAGE_METHODS } from "./usage";

/** The areas, in the order of plan §3. Each is one file with one owning lane. */
export const CLOVER_AREAS = ["plugins", "approvals", "sessions", "devices", "computers", "agents", "app", "browser", "usage"] as const;
export type CloverArea = (typeof CLOVER_AREAS)[number];

export const AREA_OWNERS: Record<CloverArea, string> = {
  plugins: "B", approvals: "C", sessions: "D (with A)", devices: "H", computers: "J", agents: "K",
  app: "E (with C, D, G, M)", browser: "L", usage: "D",
};

const AllRoles = CLOVER_ROLES;

/** Methods every connection has, whatever its area. */
export const CORE_METHODS = {
  hello: defineMethod({
    name: "protocol.hello", owner: "C", roles: AllRoles,
    params: CloverHelloParams, result: CloverHelloResult,
    doc: "The first call on every connection: the role, its token, and who the connection counts as (§3.1).",
  }),
  eventsSubscribe: defineMethod({
    name: "events.subscribe", owner: "C", roles: ["app", "cli", "layer", "remote", "web", "peer"],
    params: z.object({ areas: z.array(z.enum(CLOVER_AREAS)).min(1).max(CLOVER_AREAS.length) }), result: Ok,
    doc: "Receive the `core.event`s of these areas that this role may receive.",
  }),
  eventsUnsubscribe: defineMethod({
    name: "events.unsubscribe", owner: "C", roles: ["app", "cli", "layer", "remote", "web", "peer"],
    params: z.object({ areas: z.array(z.enum(CLOVER_AREAS)).min(1).max(CLOVER_AREAS.length) }), result: Ok,
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
} as const satisfies Record<CloverArea, Record<string, MethodSpec>>;

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
} as const satisfies Record<CloverArea, Record<string, EventSpec>>;

/** Every Clover method, by wire name. */
export const CLOVER_METHODS: ReadonlyMap<string, MethodSpec & { area: CloverArea | "core" }> = (() => {
  const all = new Map<string, MethodSpec & { area: CloverArea | "core" }>();
  const add = (area: CloverArea | "core", spec: MethodSpec) => {
    if (all.has(spec.name)) throw new Error(`duplicate Clover method ${spec.name}`);
    all.set(spec.name, { ...spec, area });
  };
  for (const spec of Object.values(CORE_METHODS)) add("core", spec);
  for (const area of CLOVER_AREAS) for (const spec of Object.values(AREA_METHODS[area])) add(area, spec);
  return all;
})();

/** Every Clover event, by `type`. */
export const CLOVER_EVENTS: ReadonlyMap<string, EventSpec & { area: CloverArea }> = (() => {
  const all = new Map<string, EventSpec & { area: CloverArea }>();
  for (const area of CLOVER_AREAS) {
    for (const spec of Object.values(AREA_EVENTS[area])) {
      if (all.has(spec.type)) throw new Error(`duplicate Clover event ${spec.type}`);
      all.set(spec.type, { ...spec, area });
    }
  }
  return all;
})();

/** The methods a role may call. A request outside its list is refused before dispatch (`CLOVER_ERR.ROLE_REFUSED`). */
export function allowedMethods(role: CloverRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of CLOVER_METHODS.values()) if (spec.direction === "to-daemon" && spec.roles.includes(role)) out.add(spec.name);
  return out;
}

/** The requests the daemon may send to a client of this role (the app's tabs, the plugin host's workers). */
export function daemonRequestsTo(role: CloverRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of CLOVER_METHODS.values()) if (spec.direction === "from-daemon" && spec.roles.includes(role)) out.add(spec.name);
  return out;
}

/** The events a role may receive. */
export function allowedEvents(role: CloverRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of CLOVER_EVENTS.values()) if (spec.roles.includes(role)) out.add(spec.type);
  return out;
}

/** The allow lists a `peer.call` may name: a paired computer reaches what a remote client may, never more (§8.5). */
export const PEER_CALL_ROLES = ["remote", "web"] as const;

/** What a receiving daemon does with a `peer.call` (lane H's door, B1 of the review):
 *  * `refused`: the role isn't a remote one, the method isn't on that role's list, or it is a peer method itself;
 *  * `needs-answer`: the method is `userOnly` or a `change`, so it runs only with the user's signed answer bound to
 *    this call (`SignedCardAnswer`, `CallBinding`), which the receiver verifies itself;
 *  * `allowed`: it runs as the peer device the link authenticated, never as the user's own terminal, and never past
 *    the fence. */
export function peerCallVerdict(method: string, role: string): "refused" | "needs-answer" | "allowed" {
  if (!(PEER_CALL_ROLES as readonly string[]).includes(role) || method.startsWith("peer.")) return "refused";
  const spec = CLOVER_METHODS.get(method);
  if (!spec || !allowedMethods(role as CloverRole).has(method)) return "refused";
  return spec.userOnly || spec.change !== undefined ? "needs-answer" : "allowed";
}

/** Whether a plugin caller with these capabilities may call a method (§5.4): plugin roles need the method's
 *  capability; `call:*` means `call:<the target's top-level id>`, checked against the command's plugin. */
export function pluginMayCall(method: MethodSpec, capabilities: readonly string[], target?: string): boolean {
  if (method.capability === undefined) return true;
  if (method.capability === "call:*") {
    if (target === undefined) return false;
    return capabilities.includes(`call:${target.split("/")[0]}`);
  }
  return capabilities.includes(method.capability);
}

/** Every Clover `core` event as one union, for clients that decode `core.event`. */
export const CloverCoreEvent = z.discriminatedUnion(
  "type",
  [...CLOVER_EVENTS.values()].filter((e) => e.scope === "core").map((e) => e.schema) as unknown as [
    z.ZodObject<{ type: z.ZodLiteral<string> }>, ...z.ZodObject<{ type: z.ZodLiteral<string> }>[],
  ],
);
