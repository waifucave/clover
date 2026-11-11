// The plugin API's way to the core from a layer (spec §5.5; roles.ts: "one third-party plugin's UI layer, on a
// connection the app's main process opens for that layer, bound to the plugin's id by its token"). The main process
// opens one connection per plugin with UI, the first time one of its parts calls: a `layer.token` from the app's own
// connection, the daemon's proof (`protocol.prove`), then a hello as that plugin's layer. A part's calls go on its own
// plugin's connection and nowhere else, so the daemon checks every call against that plugin's role and capabilities;
// the main process passes only the methods the `layer` role may call, and the events each connection receives go to
// the documents that hold that plugin's parts. Pure apart from the client it dials, so the tests drive it under Bun.
import { allowedMethods, CLOVER_PROTOCOL_VERSION, CORE_EVENT_NOTIFICATION, type CloverHelloParams } from "@waifucave/clover-protocol";
import { proveServer } from "./pair/pair";
import type { DaemonClient } from "./protocol/client";

/** What a layer may ask the core: the `layer` role's methods. */
export const LAYER_METHODS: ReadonlySet<string> = allowedMethods("layer");

/** What a layer may not call through the general plugin-API door at all: `terminal.write`'s bytes are written only by
 *  the main process, from a key press or paste it saw come to the frame itself (`index.ts`'s `terminalInput` sends it
 *  on here directly). A part handing over its own bytes would lose the check's whole point (§5.5). */
export const MAIN_ONLY: ReadonlySet<string> = new Set(["terminal.write"]);

/** The most a layer's call may carry, serialized. */
export const LAYER_CALL_MAX = 2_000_000;

/** A plugin's own events (its host half's `ui.send`, its store's changes), handed to its documents latest-wins: within
 *  one tick, only the last of each topic or key goes on, and at most OWN_EVENT_KEYS distinct ones are held per plugin
 *  (the oldest goes first). So a burst, or documents slow to take them, never piles up here. */
export const OWN_EVENT_KEYS = 64;
export const OWN_EVENT_TICK_MS = 16;
const OWN_EVENTS = new Set(["plugin_ui_message", "plugin_store_changed"]);

/** Holds a plugin's own events for one tick, the last of each topic or key. */
export class OwnEventMailbox {
  private readonly held = new Map<string, Map<string, unknown>>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deliver: (pluginId: string, params: unknown) => void, private readonly tickMs = OWN_EVENT_TICK_MS) {}

  /** True when the event is a plugin's own and is held here; false for any other event, which goes on at once. */
  offer(pluginId: string, params: unknown): boolean {
    const e = params as { type?: unknown; event?: unknown; key?: unknown } | undefined;
    if (typeof e?.type !== "string" || !OWN_EVENTS.has(e.type)) return false;
    const key = `${e.type}\u0000${String(e.type === "plugin_ui_message" ? e.event : e.key)}`;
    let m = this.held.get(pluginId);
    if (m === undefined) this.held.set(pluginId, (m = new Map()));
    m.delete(key); // re-inserted last: the newest is the one kept
    m.set(key, params);
    while (m.size > OWN_EVENT_KEYS) m.delete(m.keys().next().value!);
    this.timer ??= setTimeout(() => this.flush(), this.tickMs);
    return true;
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const all = [...this.held.entries()];
    this.held.clear();
    for (const [pluginId, m] of all) for (const params of m.values()) this.deliver(pluginId, params);
  }
}

export interface LayerLinkDeps {
  /** The app's own connection (for `layer.token`); undefined while the pair is down. */
  appClient(): DaemonClient | undefined;
  /** A fresh connection to the daemon's endpoint. */
  dial(): Promise<DaemonClient | undefined>;
  /** The app's token, for the daemon's proof (never sent). */
  appToken(): string | undefined;
  /** This process's id, the one the daemon must see. */
  pid: number;
  appVersion: string;
  /** An event (a notification) on a plugin's connection. */
  onEvent(pluginId: string, method: string, params: unknown): void;
  log(line: string): void;
}

export class LayerLinks {
  private readonly links = new Map<string, Promise<DaemonClient>>();
  /** The areas each plugin's documents subscribed to, said again on a connection opened after one closed (the daemon
   *  ends a connection whose reader fell 4 MiB behind, `ConnWriter`), so its parts keep hearing their events. */
  private readonly areas = new Map<string, Set<string>>();
  private readonly mailbox: OwnEventMailbox;

  constructor(private readonly deps: LayerLinkDeps) {
    this.mailbox = new OwnEventMailbox((pluginId, params) => this.deps.onEvent(pluginId, CORE_EVENT_NOTIFICATION, params));
  }

  /** A part's call, on its plugin's own connection. The one door a part may open; it refuses the main-process-only
   *  methods (the general door would let a part write any bytes to a terminal). */
  async call(pluginId: string, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!LAYER_METHODS.has(method)) throw new Error(`a layer doesn't call ${method}`);
    if (MAIN_ONLY.has(method)) throw new Error(`${method} goes only from the main process`);
    const result = await this.hand(pluginId, method, params, timeoutMs);
    if (method === "events.subscribe" || method === "events.unsubscribe") {
      const list = (params as { areas?: unknown } | undefined)?.areas;
      const set = this.areas.get(pluginId) ?? new Set<string>();
      for (const a of Array.isArray(list) ? list : []) if (typeof a === "string") (method === "events.subscribe" ? set.add(a) : set.delete(a));
      this.areas.set(pluginId, set);
    }
    return result;
  }

  /** The main process's own call on a plugin's connection: the checks that the general door would skip ride the
   *  caller instead (the key and paste record and the paste's OK, in `terminalInput`). */
  async hand(pluginId: string, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!LAYER_METHODS.has(method)) throw new Error(`the app doesn't call ${method} for a layer`);
    return this.write(pluginId, method, params, timeoutMs);
  }

  private async write(pluginId: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (JSON.stringify(params ?? null).length > LAYER_CALL_MAX) throw new Error("the call is too large");
    const client = await this.link(pluginId);
    return client.request(method, params ?? {}, timeoutMs);
  }

  private link(pluginId: string): Promise<DaemonClient> {
    const open = this.links.get(pluginId);
    if (open !== undefined) return open;
    const made = this.open(pluginId);
    this.links.set(pluginId, made);
    made.catch(() => this.links.delete(pluginId));
    return made;
  }

  private async open(pluginId: string): Promise<DaemonClient> {
    const app = this.deps.appClient();
    const appToken = this.deps.appToken();
    if (app === undefined || appToken === undefined) throw new Error("Clover isn't running");
    const { token } = await app.request<{ token: string }>("layer.token", { pluginId });
    const client = await this.deps.dial();
    if (client === undefined) throw new Error("Clover isn't running");
    const why = await proveServer(client, appToken, this.deps.pid, 5_000);
    if (why !== undefined) {
      client.close();
      throw new Error(`the endpoint isn't this user's daemon (${why.why})`);
    }
    client.onNotification((method, params) => {
      if (method === CORE_EVENT_NOTIFICATION && this.mailbox.offer(pluginId, params)) return;
      this.deps.onEvent(pluginId, method, params);
    });
    const hello: CloverHelloParams = { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "layer", token, clientName: `clover-app/${this.deps.appVersion} layer`, pluginId };
    try {
      await client.request("protocol.hello", hello, 5_000);
    } catch (err) {
      client.close();
      throw err;
    }
    client.onClose(() => {
      if (this.links.get(pluginId) !== undefined) this.links.delete(pluginId);
    });
    const areas = [...(this.areas.get(pluginId) ?? [])];
    if (areas.length > 0) await client.request("events.subscribe", { areas }, 5_000).catch(() => undefined);
    this.deps.log(`layers: ${pluginId}'s layer connected to the core`);
    return client;
  }

  /** The connections of plugins that no longer show UI (turned off, stopped, removed, blocked) close: what such a
   *  plugin's parts had open goes with them, and its next call, once it is back, opens a fresh one. The ids closed. */
  closeGone(shown: ReadonlySet<string>): string[] {
    const gone = [...this.links.keys()].filter((id) => !shown.has(id));
    for (const id of gone) {
      const p = this.links.get(id)!;
      this.links.delete(id);
      void p.then((c) => c.close(), () => undefined);
      this.deps.log(`layers: ${id}'s layer connection closed (it no longer shows UI)`);
    }
    return gone;
  }

  /** Every plugin's connection closes (the pair went down, or the app quits); the next call opens a fresh one. */
  closeAll(): void {
    const all = [...this.links.values()];
    this.links.clear();
    for (const p of all) void p.then((c) => c.close(), () => undefined);
  }
}
