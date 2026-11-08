// The plugin API's areas over other lanes' services (the coordinator's ruling: lane B serves them, so the capability
// gate and the caller rules stay in one place): `conversation.*` on lane D's durable session host, `bots.*` on D's bot
// side, `computers.*` on lane J's computer registry and holds, `devices.*` on lane H's device registry, `files.*` on J's
// folder tree, `terminal.*` on J's terminals. The router (`router.ts`) has checked the capability and where the call
// may be made before a handler runs; a handler acts as the call's caller, the one the core bound (R7), and never as
// the user unless the call came through the app's layer path (`plugin.layer.api`).
//
// The services start after the plugin host (the bot side and the computer node come up with the links, `daemon-parts`),
// so each is read when a call arrives: a call whose service isn't running here is refused with why.
//
// * `conversation.*`: list, get and history are D's `session.*` reads, with the sealed rule for the caller; `follow`
//   replays from `since` and then streams, as `session.attach` does; `note` and `send` post into the session as the
//   plugin (D's `session.post`), into a reachable session only. `answer` has no service on main yet: refused.
// * `bots.*`, `devices.*`: the services' own views; a watch gets each changed view (a removal carries none).
// * `computers.*`, `files.*`: J's adapters (`computers/api.ts`); files are always the plugin's, fenced by the tree.
// * `terminal.*`: a terminal opened by a plugin is that plugin's, and only it writes to, resizes, reads or closes it.
//   Its output reaches a component as the `terminal_output` core event for the app (a listener can't cross the layer
//   path), and a host half's `onData` listener directly.
import type { BotView, Caller, DeviceView } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { BotSide } from "../../bots/wiring";
import { computersApiRoutes, filesApiRoutes, filesWatch, type ApiRoute } from "../../computers/api";
import type { ComputerNode } from "../../computers/node";
import { deviceView } from "../../devices/rpc";
import type { DeviceLinks } from "../../links/node";
import { projectRecord, projectRecords, readsSealed, transientFor, type WireEvent } from "../../sessions/wire";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "./router";

/** Where each service is, read when a call arrives (undefined while it isn't running here). */
export interface AreaServices {
  bots(): BotSide | undefined;
  node(): ComputerNode | undefined;
  links(): DeviceLinks | undefined;
  /** Sends a core event to the app's connections (a layer's terminal output). */
  emitToApp?(event: { type: string; [key: string]: unknown }): void;
  now?(): number;
}

const HISTORY_PAGE_MAX = 500;
const HISTORY_SCAN_STEP = 500;
const REPLAY_PAGE = 500;

const opt = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const notRunning = (what: string): never => {
  throw new ContractError("refused", `${what} isn't running on this computer`);
};

/** The handlers for the six areas. */
export function areasApi(s: AreaServices): ApiHandlers {
  const now = s.now ?? Date.now;
  const side = () => s.bots() ?? notRunning("the bot side");
  const node = () => s.node() ?? notRunning("the computer node");
  const links = () => s.links() ?? notRunning("the device links");

  // ---- conversation (D's session host) ----
  const sessionOf = (id: string) => {
    const v = side().host.get(id);
    if (!v) throw new ContractError("not_found", `no session ${id}`);
    return v;
  };
  const reachable = (id: string) => {
    const v = sessionOf(id);
    if (v.kind === "bot" && (v.bot === undefined || !side().bots.has(v.bot))) throw new ContractError("not_found", `the bot of ${id} isn't installed`);
    return v;
  };
  const sealedFor = (caller: Caller) => !readsSealed(caller);

  // ---- computers and files (J's adapters, which take the arguments first) ----
  const route = (pick: (n: ComputerNode) => Record<string, ApiRoute>, path: string) =>
    (ctx: ApiCallContext, args: readonly unknown[]) => {
      const r = pick(node())[path];
      if (r === undefined) throw new ContractError("refused", `${path} is not served on this computer`);
      return r([...args], { pluginId: ctx.pluginId, caller: ctx.caller });
    };
  const computers = (n: ComputerNode) => computersApiRoutes(n.registry, n.holds);
  const files = (n: ComputerNode) => filesApiRoutes(n.tree);

  // ---- terminals: each one its opener's ----
  const terminals = new Map<string, { pluginId: string; layer: boolean; stop?: Unsubscribe }>();
  const own = (ctx: ApiCallContext, id: string) => {
    const t = terminals.get(id);
    if (t === undefined || t.pluginId !== ctx.pluginId) throw new ContractError("not_found", `no terminal ${id} of ${ctx.pluginId}'s`);
    return t;
  };

  return {
    "conversation.list": (_ctx, args) => {
      const f = opt(args[0]);
      const kinds = Array.isArray(f.kinds) ? (f.kinds as string[]) : undefined;
      return side().host.list(typeof f.bot === "string" ? { bot: f.bot } : {}).filter((v) => kinds === undefined || kinds.includes(v.kind));
    },
    "conversation.get": (_ctx, args) => sessionOf(stringArg(args, 0, "the session")),
    "conversation.history": (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const page = opt(args[1]);
      const limit = typeof page.limit === "number" && page.limit >= 1 ? Math.min(Math.floor(page.limit), HISTORY_PAGE_MAX) : 50;
      const host = side().host;
      const v = sessionOf(id);
      const opts = { kind: v.kind, sealed: sealedFor(ctx.caller) };
      const eventsIn = (start: number, end: number) => projectRecords(host.history(id, { afterSeq: start - 1, limit: end - start }), opts);
      let end = Math.min(typeof page.before === "number" ? page.before : host.length(id), host.length(id));
      const events: WireEvent[] = [];
      let hasMore = false;
      while (end > 0) {
        const start = Math.max(0, end - HISTORY_SCAN_STEP);
        const got = eventsIn(start, end);
        const need = limit - events.length;
        if (got.length > need) {
          events.unshift(...got.slice(got.length - need));
          hasMore = true;
          break;
        }
        events.unshift(...got);
        end = start;
        if (events.length === limit) {
          for (let e = end; e > 0 && !hasMore; e = Math.max(0, e - HISTORY_SCAN_STEP)) hasMore = eventsIn(Math.max(0, e - HISTORY_SCAN_STEP), e).length > 0;
          break;
        }
      }
      return { events, hasMore };
    },
    "conversation.follow": (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const listener = listenerArg<WireEvent>(args, 1);
      const since = opt(args[2]).since;
      const host = side().host;
      const v = sessionOf(id);
      const opts = { kind: v.kind, sealed: sealedFor(ctx.caller) };
      if (typeof since === "number") {
        for (let after = since; after < host.length(id) - 1; after += REPLAY_PAGE) {
          for (const event of projectRecords(host.history(id, { afterSeq: after, limit: REPLAY_PAGE }), opts)) listener(event);
        }
      }
      const offRecords = host.subscribe(id, (record) => {
        const event = projectRecord(record, opts);
        if (event) listener(event);
      });
      const offTransient = host.onTransient(id, (event) => {
        if (transientFor(ctx.caller, event.type)) listener({ ...event, seq: Math.max(0, host.length(id) - 1), sessionId: id, ts: now() } as WireEvent);
      });
      return () => {
        offRecords();
        offTransient();
      };
    },
    "conversation.note": async (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const n = opt(args[1]);
      if (typeof n.text !== "string" || n.text.trim() === "") throw new ContractError("invalid", "a note needs text");
      reachable(id);
      const label = (typeof n.label === "string" && n.label !== "" ? n.label : ctx.pluginId).slice(0, 120);
      await side().host.deliver(id, { from: "note", label, text: n.text, by: { kind: "plugin", pluginId: ctx.pluginId } });
    },
    "conversation.send": async (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const text = args[1];
      if (typeof text !== "string" || text.trim() === "") throw new ContractError("invalid", "a message needs text");
      reachable(id);
      await side().host.deliver(id, { from: "plugin", pluginId: ctx.pluginId, text });
    },

    "bots.list": () => side().bots.list(),
    "bots.get": (_ctx, args) => {
      const id = stringArg(args, 0, "the bot");
      const bot = side().bots.get(id);
      if (!bot) throw new ContractError("not_found", `no bot ${id}`);
      return bot;
    },
    "bots.watch": (_ctx, args) => {
      const listener = listenerArg<BotView>(args, 0);
      return side().bots.onEvent((e) => {
        if (e.type === "bot_changed") listener(e.bot);
      });
    },

    "computers.list": route(computers, "computers.list"),
    "computers.get": route(computers, "computers.get"),
    "computers.holds": route(computers, "computers.holds"),
    "computers.takeHold": route(computers, "computers.takeHold"),
    "computers.releaseHold": route(computers, "computers.releaseHold"),
    "computers.setUserWorking": route(computers, "computers.setUserWorking"),
    "computers.setActionRunning": route(computers, "computers.setActionRunning"),
    "computers.cloverWindows": route(computers, "computers.cloverWindows"),
    "computers.watch": (_ctx, args) => {
      const listener = listenerArg<unknown>(args, 0);
      return node().registry.watch((c) => {
        if (c.type === "computer") listener(c.computer);
      });
    },

    "devices.list": () => {
      const l = links();
      const main = l.main?.lease.state().main ?? null;
      const self = l.registry.self().id;
      return l.registry.list().map((d) => deviceView(d, self, l.transport.links().find((k) => k.peer === d.id), d.id === main));
    },
    "devices.watch": (_ctx, args) => {
      const listener = listenerArg<DeviceView>(args, 0);
      const l = links();
      const self = l.registry.self().id;
      const view = (id: string) => {
        const d = l.registry.get(id);
        if (d === undefined || d.revokedAt !== undefined) return;
        listener(deviceView(d, self, l.transport.links().find((k) => k.peer === id), id === (l.main?.lease.state().main ?? null)));
      };
      const offRegistry = l.registry.watch((c) => {
        if (c.type !== "revoked") view(c.device.id);
      });
      const offLinks = l.transport.watch((link) => view(link.peer));
      return () => {
        offRegistry();
        offLinks();
      };
    },

    "files.stat": route(files, "files.stat"),
    "files.readText": route(files, "files.readText"),
    "files.readBytes": route(files, "files.readBytes"),
    "files.write": route(files, "files.write"),
    "files.list": route(files, "files.list"),
    "files.remove": route(files, "files.remove"),
    "files.move": route(files, "files.move"),
    "files.glob": route(files, "files.glob"),
    // J's adapter, with `ignoreCase` passed on (the SDK's option; the tree takes it).
    "files.grep": (ctx, args) => {
      const p = opt(args[1]);
      return node().tree.grepAll(stringArg(args, 0, "the pattern", 4096), {
        as: { kind: "plugin", pluginId: ctx.pluginId }, cwd: stringArg([p.cwd], 0, "cwd", 4096),
        ...(typeof p.glob === "string" ? { glob: p.glob } : {}), ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        ...(p.ignoreCase === true ? { ignoreCase: true } : {}),
      } as Parameters<ComputerNode["tree"]["grepAll"]>[1]);
    },
    "files.watch": (ctx, args) => filesWatch(node().tree, ctx, stringArg(args, 0, "the path", 4096), listenerArg(args, 1)),

    "terminal.open": async (ctx, args) => {
      const p = opt(args[0]);
      const computer = stringArg([p.computer], 0, "the computer");
      const cols = typeof p.cols === "number" ? p.cols : 80;
      const rows = typeof p.rows === "number" ? p.rows : 24;
      const n = node();
      // Opened as the call's caller: a layer's call is the user's, a host half's is the plugin's, which a computer at
      // read-only refuses (J's rule).
      const { terminalId } = await n.terminals.open({
        computer, cols, rows,
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
        ...(ctx.session !== undefined ? { session: ctx.session } : typeof p.session === "string" ? { session: p.session } : {}),
      }, ctx.caller);
      const layer = ctx.process === "ui";
      const entry: { pluginId: string; layer: boolean; stop?: Unsubscribe } = { pluginId: ctx.pluginId, layer };
      if (layer && s.emitToApp !== undefined) {
        const emit = s.emitToApp;
        entry.stop = n.terminals.onOutput((o) => {
          if (o.terminalId !== terminalId) return;
          emit({ type: "terminal_output", terminalId, data: o.data, ...(o.exited !== undefined ? { exited: o.exited } : {}) });
          if (o.exited !== undefined) {
            entry.stop?.();
            terminals.delete(terminalId);
          }
        });
      }
      terminals.set(terminalId, entry);
      return { terminalId };
    },
    // The bytes a keydown makes, or a paste's text (the app's runtime turns the DOM event into these, lane E).
    "terminal.input": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      const e = opt(args[1]);
      if (e.type === "paste" && typeof e.text === "string") return node().terminals.write(id, e.text, { paste: true });
      if (typeof e.data === "string") return node().terminals.write(id, e.data);
      throw new ContractError("invalid", "terminal input is { data } for keys, or { type: \"paste\", text }");
    },
    "terminal.onData": (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      const listener = listenerArg<string>(args, 1) as unknown as (data: string, exited?: { code: number | null }) => void;
      return node().terminals.onOutput((o) => {
        if (o.terminalId === id) listener(o.data, o.exited);
      });
    },
    "terminal.resize": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      const cols = args[1];
      const rows = args[2];
      if (typeof cols !== "number" || typeof rows !== "number") throw new ContractError("invalid", "a terminal's size is cols and rows");
      await node().terminals.resize(id, cols, rows);
    },
    "terminal.close": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      const t = own(ctx, id);
      t.stop?.();
      terminals.delete(id);
      await node().terminals.close(id);
    },
  };
}
