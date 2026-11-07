// The daemon's `core.event` sender (C-M3 item 2; protocol rpc.ts `EventScope`, clover.ts `events.subscribe`). One
// daemon-wide event goes to each Clover connection that may have it, and to no other:
//   * its type is a known `core` event (`CLOVER_EVENTS`); a session event or an unknown type is never sent here;
//   * it parses with its schema, and what is sent is what parsed (a field the schema doesn't name never leaves);
//   * the connection's role is one the event lists, and the connection subscribed to the event's area;
//   * a plugin's connection (`layer`, `plugin-host`) also holds the event's capability, from the plugin registry
//     (`pluginCapabilities`). A shared plugin host, which runs several plugins, gets no event that needs one;
//   * the caller's own filter (`to`), for an event meant for some connections only.
// A connection whose send throws (it just closed) doesn't stop the others. Remote and web clients, which lane H's
// link brings in as Clover connections, are routed the same way.
import { CLOVER_EVENTS, CORE_EVENT_NOTIFICATION, PLUGIN_ROLES } from "@waifucave/clover-protocol";
import type { CloverConn } from "./clover";

/** A `core` event as a lane hands it over: its `type`, and `ts` (the shared clock's) unless the sender stamps it. */
export interface CoreEventInput {
  type: string;
  ts?: number;
  [key: string]: unknown;
}

export interface CoreEventRouting {
  connections(): Iterable<CloverConn>;
  /** A plugin's granted capabilities (lane B's registry); undefined: none. The bundled tree's host asks for `clover`. */
  pluginCapabilities?(pluginId: string): readonly string[] | undefined;
  /** The shared clock, for an event without `ts`. */
  now?(): number;
  log?(line: string): void;
}

export interface CoreEventOptions {
  /** Only these connections, among those the rules above allow. */
  to?(conn: CloverConn): boolean;
}

/** The plugin a plugin connection speaks for: a layer's own, an own host's, `clover` for the bundled tree's host; a
 *  shared host has none. */
function pluginOf(conn: CloverConn): string | undefined {
  if (conn.role === "layer") return conn.caller.kind === "plugin" ? conn.caller.pluginId : undefined;
  if (conn.hostProcess?.hostProcess === "clover") return "clover";
  if (conn.hostProcess?.hostProcess === "own") return conn.hostProcess.pluginId;
  return undefined;
}

/** Sends `event` as `core.event` to every connection that may have it; how many it went to. */
export function sendCoreEvent(r: CoreEventRouting, event: CoreEventInput, opts: CoreEventOptions = {}): number {
  const spec = CLOVER_EVENTS.get(event.type);
  if (spec === undefined || spec.scope !== "core") {
    r.log?.(`[core.event] not a core event, not sent: ${JSON.stringify(String(event.type).slice(0, 64))}`);
    return 0;
  }
  const parsed = spec.schema.safeParse(event.ts === undefined ? { ...event, ts: (r.now ?? Date.now)() } : event);
  if (!parsed.success) {
    r.log?.(`[core.event] a ${spec.type} event didn't parse; not sent`);
    return 0;
  }
  let sent = 0;
  for (const conn of r.connections()) {
    if (!spec.roles.includes(conn.role) || !conn.areas.has(spec.area)) continue;
    if (spec.capability !== undefined && PLUGIN_ROLES.includes(conn.role)) {
      const plugin = pluginOf(conn);
      if (plugin === undefined || !(r.pluginCapabilities?.(plugin) ?? []).includes(spec.capability)) continue;
    }
    if (opts.to !== undefined && !opts.to(conn)) continue;
    try {
      conn.notify(CORE_EVENT_NOTIFICATION, parsed.data);
      sent++;
    } catch {
      // closing: its close handler removes it
    }
  }
  return sent;
}
