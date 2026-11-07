// How Clover's areas describe their methods and events. The wire stays as it is: JSON-RPC 2.0 over NDJSON
// (jsonrpc.ts, ndjson.ts), requests and responses in both directions on one connection, and events as
// notifications. Each area file (plugins.ts, approvals.ts, …) lists its methods with `defineMethod` and its events
// with `defineEvent`; clover.ts gathers them into one table, derives each role's allow list and generates the JSON
// Schemas and fixtures (`pnpm protocol:generate`).
import { z } from "zod";
import { type Lane, Timestamp } from "./common";
import type { CloverRole } from "./roles";

/** Who sends a request: a client to the daemon (most methods), or the daemon to a client (the browser's tabs live in
 *  the app, §12.1; handlers run in the plugin host, §5.2). `peer` methods go both ways between two daemons. */
export type Direction = "to-daemon" | "from-daemon";

/** How a method changes access (§5.5):
 *  - `core`: it changes the core's settings or a user layer. Only the `clover` layer (role `app`) and the user's own
 *    terminal change them directly; from any other layer the change becomes a sealed card.
 *  - `sensitive`: it is a sensitive change (levels, devices, the main computer, loading a found plugin, development
 *    folders, trusting a repo, saved rules, connector permissions). It ends in a sealed card unless the user makes it
 *    in their own terminal, from every layer. */
export type ChangeKind = "core" | "sensitive";

export interface MethodSpec<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  /** `<area>.<verb>`, unique across Clover's protocol. */
  readonly name: string;
  readonly params: P;
  /** What a role may send, where it differs from the others (#179's review, S3 and check 2): a call from that role is
   *  parsed with this alone (`paramsFor`). A peer can't name another computer's level; a layer installs only from an
   *  index or npm. */
  readonly roleParams?: Partial<Record<CloverRole, z.ZodType>>;
  readonly result: R;
  /** The roles that may call it. The allow lists are exactly these (clover.ts). */
  readonly roles: readonly CloverRole[];
  /** The lane that implements it. */
  readonly owner: Lane;
  readonly direction: Direction;
  /** A plugin caller (`layer`, `plugin-host`) needs this capability, else the call doesn't exist for it (§5.4). */
  readonly capability?: string;
  /** The caller check must find the user: a bot's or agent's session is refused (§3.1, §9.1 "Bots cannot raise their
   *  own access"). The one exception is a `change` method called from a plugin's layer, which becomes a sealed card
   *  for the user to answer instead (§5.5). */
  readonly userOnly: boolean;
  readonly change?: ChangeKind;
  /** One line: what it does. */
  readonly doc: string;
}

export interface MethodInput<P extends z.ZodType, R extends z.ZodType> {
  name: string;
  params: P;
  roleParams?: Partial<Record<CloverRole, z.ZodType>>;
  result: R;
  roles: readonly CloverRole[];
  owner: Lane;
  direction?: Direction;
  capability?: string;
  userOnly?: boolean;
  change?: ChangeKind;
  doc: string;
}

/** The params schema a call from `role` is parsed with: that role's own (`roleParams`) where the method has one. Every
 *  server that takes a call (the daemon's endpoint, the link's peer side) parses with this. */
export function paramsFor(spec: Pick<MethodSpec, "params" | "roleParams">, role: CloverRole): z.ZodType {
  return spec.roleParams?.[role] ?? spec.params;
}

export function defineMethod<P extends z.ZodType, R extends z.ZodType>(m: MethodInput<P, R>): MethodSpec<P, R> {
  return {
    name: m.name,
    params: m.params,
    ...(m.roleParams !== undefined ? { roleParams: m.roleParams } : {}),
    result: m.result,
    roles: m.roles,
    owner: m.owner,
    direction: m.direction ?? "to-daemon",
    ...(m.capability !== undefined ? { capability: m.capability } : {}),
    userOnly: m.userOnly ?? false,
    ...(m.change !== undefined ? { change: m.change } : {}),
    doc: m.doc,
  };
}

/** Where an event lives:
 *  - `core`: daemon-wide state (plugins, cards, devices, computers, tabs…), delivered as a `core.event` notification
 *    to connections that subscribed to its area (`events.subscribe`, clover.ts).
 *  - `session`: a session's own log, delivered with the inherited `event` notification and envelope (`seq`,
 *    `sessionId`, `ts`). Clover's session events join `SessionEvent` (events.ts) when lane D wires them through the
 *    inherited checklist (docs/claude/protocol-and-remote.md); until then they are their own union (sessions.ts). */
export type EventScope = "core" | "session";

export interface EventSpec<S extends z.ZodType = z.ZodType> {
  /** The `type` discriminator, unique across the inherited `SessionEvent` and Clover's events. */
  readonly type: string;
  readonly schema: S;
  /** The roles that receive it. */
  readonly roles: readonly CloverRole[];
  readonly owner: Lane;
  readonly scope: EventScope;
  /** A transient event is never stored or replayed (the inherited `TRANSIENT_EVENT_TYPES` rule). */
  readonly transient: boolean;
  /** A plugin receiver (`layer`, `plugin-host`) needs this capability. */
  readonly capability?: string;
  /** A canonical example, generated into `generated/clover/fixtures/` and parsed by the tests. */
  readonly fixture: z.input<S>;
  readonly doc: string;
}

export interface EventInput<S extends z.ZodType> {
  type: string;
  schema: S;
  roles: readonly CloverRole[];
  owner: Lane;
  scope?: EventScope;
  transient?: boolean;
  capability?: string;
  fixture: z.input<S>;
  doc: string;
}

export function defineEvent<S extends z.ZodType>(e: EventInput<S>): EventSpec<S> {
  return {
    type: e.type,
    schema: e.schema,
    roles: e.roles,
    owner: e.owner,
    scope: e.scope ?? "core",
    transient: e.transient ?? false,
    ...(e.capability !== undefined ? { capability: e.capability } : {}),
    fixture: e.fixture,
    doc: e.doc,
  };
}

/** The envelope of every `core` event: its `type` and the shared-clock time it happened. */
export function coreEvent<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), ts: Timestamp, ...shape });
}

/** The notification method that carries `core` events (`params` is the event). Session events keep the inherited
 *  `event` notification (`METHODS.event`). */
export const CORE_EVENT_NOTIFICATION = "core.event";
