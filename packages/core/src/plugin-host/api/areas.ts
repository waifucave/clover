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
//   Sealed parts and transient events are judged for the plugin itself, whatever process or caller the call came with
//   (#334's review). `conversation.*` and `bots.*` reach every bot once granted: there is no per-bot grant yet.
// * `bots.*`, `devices.*`: the services' own views; a watch gets each changed view (a removal carries none).
// * Limits: a plugin has at most WATCHES_PER_PLUGIN watches open across the areas; a note or message is at most
//   MESSAGE_MAX characters; `files.grep` returns at most GREP_LIMIT_MAX matches; terminal input is at most
//   TERMINAL_INPUT_MAX characters a call, and a size is 2 to 1000 columns and rows.
// * `computers.*`, `files.*`: J's adapters (`computers/api.ts`); files are always the plugin's, fenced by the tree.
// * `terminal.*`: a terminal opened by a plugin is that plugin's, and only it writes to, resizes, reads or closes it.
//   Its output reaches a component as the `terminal_output` core event for the app, carrying the opener's `pluginId`
//   so the app delivers it to that plugin's layer only (a listener can't cross the layer path), and a host half's
//   `onData` listener directly. A plugin's terminals close when it stops or is removed (`forget`).
import { foldTitle } from "@waifucave/clover-plugin-sdk";
import type { BotView, Caller, DeviceView } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { BotSide } from "../../bots/wiring";
import { computersApiRoutes, filesApiRoutes, filesWatch, type ApiRoute } from "../../computers/api";
import type { ComputerNode } from "../../computers/node";
import { deviceView } from "../../devices/rpc";
import type { DeviceLinks } from "../../links/node";
import type { TerminalOutput } from "../../tree/terminals";
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
/** A follow replays at most this many of the latest events (older ones are `history`'s). */
export const REPLAY_MAX = 10_000;
export const WATCHES_PER_PLUGIN = 32;
export const MESSAGE_MAX = 16_000;
export const GREP_LIMIT_MAX = 1000;
export const TERMINAL_INPUT_MAX = 64 * 1024;
/** Output held while a terminal opens, before its id is known, in characters (any terminal's; ours is kept, the rest
 *  let go). Past it only exits are held, without their data. */
export const EARLY_OUTPUT_BYTES = 1_000_000;

/** A size in columns or rows, as the peer schema takes it: an integer from 2 to 1000. */
const termSize = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1000, Math.max(2, Math.round(v))) : fallback);

/** A note's label (#334's review): one line, no control characters, never reading as Clover or the system, and
 *  always the plugin's own: it starts with the plugin's id. */
export function noteLabel(pluginId: string, raw: unknown): string {
  const clean = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const folded = foldTitle(clean);
  if (clean === "" || ["clover", "system", "waifucave"].some((w) => folded.includes(foldTitle(w)))) return pluginId;
  return clean.startsWith(`${pluginId}`) ? clean : `${pluginId}: ${clean}`;
}

const opt = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const notRunning = (what: string): never => {
  throw new ContractError("refused", `${what} isn't running on this computer`);
};

/** The handlers for the six areas. */
export function areasApi(s: AreaServices): ApiHandlers {
  return areasParts(s).handlers;
}

/** The handlers, and `forget`, which closes and drops what a stopped or removed plugin had open (its terminals). */
export function areasParts(s: AreaServices): { handlers: ApiHandlers; forget(pluginId: string): Promise<void> } {
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
  // Judged for the plugin, never for the caller it carries (#334's review: a layer's call came as the user).
  const asPlugin = (ctx: ApiCallContext): Caller => ({ kind: "plugin", pluginId: ctx.pluginId });
  const sealedFor = (ctx: ApiCallContext) => !readsSealed(asPlugin(ctx));
  // Watches per plugin, across the areas.
  const watching = new Map<string, number>();
  const reserve = (ctx: ApiCallContext): (() => void) => {
    const n = watching.get(ctx.pluginId) ?? 0;
    if (n >= WATCHES_PER_PLUGIN) throw new ContractError("refused", `${ctx.pluginId} has ${WATCHES_PER_PLUGIN} watches open; close one first`);
    watching.set(ctx.pluginId, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (watching.get(ctx.pluginId) ?? 1) - 1;
      if (left <= 0) watching.delete(ctx.pluginId);
      else watching.set(ctx.pluginId, left);
    };
  };
  const watch = (ctx: ApiCallContext, open: () => Unsubscribe): Unsubscribe => {
    const release = reserve(ctx);
    let stop: Unsubscribe;
    try {
      stop = open();
    } catch (err) {
      release();
      throw err;
    }
    return () => {
      release();
      stop();
    };
  };
  const watchAsync = async (ctx: ApiCallContext, open: () => Promise<Unsubscribe>): Promise<Unsubscribe> => {
    const release = reserve(ctx);
    let stop: Unsubscribe;
    try {
      stop = await open();
    } catch (err) {
      release();
      throw err;
    }
    return () => {
      release();
      stop();
    };
  };

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

  const handlers: ApiHandlers = {
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
      const opts = { kind: v.kind, sealed: sealedFor(ctx) };
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
    // `since` (an integer, -1 for everything) replays after the watch opens, a page at a time with a yield between
    // pages, at most the latest REPLAY_MAX events; what lands meanwhile, records and transient events alike, waits for
    // the replay and then follows in the order it came (#333/#334's review: a transient never overtakes the replay).
    "conversation.follow": (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const listener = listenerArg<WireEvent>(args, 1);
      const since = opt(args[2]).since;
      if (since !== undefined && !(Number.isInteger(since) && (since as number) >= -1)) throw new ContractError("invalid", "since is an event's seq, or -1 for every event");
      const host = side().host;
      const v = sessionOf(id);
      const opts = { kind: v.kind, sealed: sealedFor(ctx) };
      const me = asPlugin(ctx);
      // The whole watch, its slot included, for a replay that fails (set once `watch` returns, before any page runs).
      let unsubscribe: Unsubscribe = () => {};
      const stopWatch = () => unsubscribe();
      unsubscribe = watch(ctx, () => {
        let closed = false;
        let replaying = typeof since === "number";
        let last = -Infinity;
        // What landed during the replay, in order: a record (sent once, by seq) or a transient event (sent as it is).
        const queued: { event: WireEvent; transient: boolean }[] = [];
        const send = (event: WireEvent) => {
          if (closed || event.seq <= last) return;
          last = event.seq;
          listener(event);
        };
        const offRecords = host.subscribe(id, (record) => {
          const event = projectRecord(record, opts);
          if (!event) return;
          if (replaying) queued.push({ event, transient: false });
          else send(event);
        });
        // What's set up after the first subscription comes off again if any of it throws (#367's review).
        let offTransient: Unsubscribe | undefined;
        try {
          offTransient = host.onTransient(id, (event) => {
            if (closed || !transientFor(me, event.type)) return;
            const e = { ...event, seq: Math.max(0, host.length(id) - 1), sessionId: id, ts: now() } as WireEvent;
            if (replaying) queued.push({ event: e, transient: true });
            else listener(e);
          });
          if (typeof since === "number") {
            const end = host.length(id) - 1;
            let after = Math.max(since, end - REPLAY_MAX);
            const page = () => {
              if (closed) return;
              if (after < end) {
                // A read that throws ends the follow, rather than leaving it replaying with its queue growing (#358's
                // review).
                let events: WireEvent[];
                try {
                  events = projectRecords(host.history(id, { afterSeq: after, limit: Math.min(REPLAY_PAGE, end - after) }), opts);
                } catch {
                  // The plugin hears that its follow ended (`follow_ended`, the last event's seq), then nothing more.
                  const ended = { type: "follow_ended", sessionId: id, seq: last === -Infinity ? -1 : last, ts: now(), reason: "the session's history couldn't be read" } as WireEvent;
                  stopWatch();
                  try {
                    listener(ended);
                  } catch {
                    // the plugin's listener; its error is its own
                  }
                  return;
                }
                for (const event of events) send(event);
                after += REPLAY_PAGE;
                setImmediate(page);
                return;
              }
              replaying = false;
              for (const q of queued.splice(0)) {
                if (closed) break;
                if (q.transient) listener(q.event);
                else send(q.event);
              }
            };
            setImmediate(page);
          }
        } catch (err) {
          closed = true;
          offRecords();
          offTransient?.();
          throw err;
        }
        return () => {
          closed = true;
          offRecords();
          offTransient?.();
        };
      });
      return unsubscribe;
    },
    "conversation.note": async (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const n = opt(args[1]);
      if (typeof n.text !== "string" || n.text.trim() === "") throw new ContractError("invalid", "a note needs text");
      if (n.text.length > MESSAGE_MAX) throw new ContractError("invalid", `a note is at most ${MESSAGE_MAX} characters`);
      reachable(id);
      const label = noteLabel(ctx.pluginId, n.label);
      await side().host.deliver(id, { from: "note", label, text: n.text, by: { kind: "plugin", pluginId: ctx.pluginId } });
    },
    "conversation.send": async (ctx, args) => {
      const id = stringArg(args, 0, "the session");
      const text = args[1];
      if (typeof text !== "string" || text.trim() === "") throw new ContractError("invalid", "a message needs text");
      if (text.length > MESSAGE_MAX) throw new ContractError("invalid", `a message is at most ${MESSAGE_MAX} characters`);
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
    "bots.watch": (ctx, args) => {
      const listener = listenerArg<BotView>(args, 0);
      const bots = side().bots;
      return watch(ctx, () => bots.onEvent((e) => {
        if (e.type === "bot_changed") listener(e.bot);
      }));
    },

    "computers.list": route(computers, "computers.list"),
    "computers.get": route(computers, "computers.get"),
    "computers.holds": route(computers, "computers.holds"),
    "computers.takeHold": route(computers, "computers.takeHold"),
    "computers.releaseHold": route(computers, "computers.releaseHold"),
    "computers.setUserWorking": route(computers, "computers.setUserWorking"),
    "computers.setActionRunning": route(computers, "computers.setActionRunning"),
    "computers.cloverWindows": route(computers, "computers.cloverWindows"),
    "computers.watch": (ctx, args) => {
      const listener = listenerArg<unknown>(args, 0);
      const registry = node().registry;
      return watch(ctx, () => registry.watch((c) => {
        if (c.type === "computer") listener(c.computer);
      }));
    },

    "devices.list": () => {
      const l = links();
      const main = l.main?.lease.state().main ?? null;
      const self = l.registry.self().id;
      return l.registry.list().map((d) => deviceView(d, self, l.transport.links().find((k) => k.peer === d.id), d.id === main));
    },
    "devices.watch": (ctx, args) => {
      const listener = listenerArg<DeviceView>(args, 0);
      const l = links();
      return watch(ctx, () => {
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
      });
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
        ...(typeof p.glob === "string" ? { glob: p.glob } : {}),
        limit: typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.min(GREP_LIMIT_MAX, Math.max(1, Math.floor(p.limit))) : GREP_LIMIT_MAX,
        ...(p.ignoreCase === true ? { ignoreCase: true } : {}),
      } as Parameters<ComputerNode["tree"]["grepAll"]>[1]);
    },
    "files.watch": (ctx, args) => {
      const tree = node().tree;
      const path = stringArg(args, 0, "the path", 4096);
      const listener = listenerArg(args, 1);
      return watchAsync(ctx, () => filesWatch(tree, ctx, path, listener));
    },

    "terminal.open": async (ctx, args) => {
      const p = opt(args[0]);
      const computer = stringArg([p.computer], 0, "the computer");
      const cols = termSize(p.cols, 80);
      const rows = termSize(p.rows, 24);
      const n = node();
      const layer = ctx.process === "ui";
      const entry: { pluginId: string; layer: boolean; stop?: Unsubscribe } = { pluginId: ctx.pluginId, layer };
      // A layer's output reaches the app as `terminal_output`; every terminal, a host half's too, is dropped from the
      // map when its shell exits (#333/#334's review). The listener is on before the open, so a shell that exits before
      // the open returns isn't missed (#358's review): until the id is known, output is held (a bounded few), then
      // ours is replayed and the rest let go.
      const emit = layer ? s.emitToApp : undefined;
      let terminalId: string | undefined;
      let early: TerminalOutput[] | undefined = [];
      let earlyBytes = 0;
      const handle = (o: TerminalOutput) => {
        emit?.({ type: "terminal_output", pluginId: ctx.pluginId, terminalId: o.terminalId, data: o.data, ...(o.exited !== undefined ? { exited: o.exited } : {}) });
        if (o.exited !== undefined) {
          entry.stop?.();
          terminals.delete(o.terminalId);
        }
      };
      entry.stop = n.terminals.onOutput((o) => {
        if (terminalId === undefined) {
          // Output is held up to a byte budget (#367's review: a chunk can be a megabyte, and this sees every terminal
          // on the node); past it, output is dropped and an exit is kept without its data (one per shell). So when
          // other terminals flood the window, this terminal's own first output can be lost; its exit never is.
          if (early === undefined) return;
          if (earlyBytes + o.data.length <= EARLY_OUTPUT_BYTES) {
            earlyBytes += o.data.length;
            early.push(o);
          } else if (o.exited !== undefined) early.push({ terminalId: o.terminalId, data: "", exited: o.exited });
          return;
        }
        if (o.terminalId === terminalId) handle(o);
      });
      try {
        // Opened as the call's caller, the plugin (a layer's call is its plugin's too, never the user's), which a
        // computer at read-only refuses (J's rule).
        ({ terminalId } = await n.terminals.open({
          computer, cols, rows,
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          ...(ctx.session !== undefined ? { session: ctx.session } : typeof p.session === "string" ? { session: p.session } : {}),
        }, ctx.caller));
      } catch (err) {
        entry.stop();
        throw err;
      }
      terminals.set(terminalId, entry);
      const held = early.filter((o) => o.terminalId === terminalId);
      early = undefined;
      for (const o of held) handle(o);
      return { terminalId };
    },
    // The bytes a keydown makes, or a paste's text (the app's runtime turns the DOM event into these, lane E).
    "terminal.input": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      const e = opt(args[1]);
      const text = e.type === "paste" ? e.text : e.data;
      if (typeof text === "string" && text.length > TERMINAL_INPUT_MAX) throw new ContractError("invalid", `terminal input is at most ${TERMINAL_INPUT_MAX} characters a call`);
      if (e.type === "paste" && typeof e.text === "string") return node().terminals.write(id, e.text, { paste: true });
      if (typeof e.data === "string") return node().terminals.write(id, e.data);
      throw new ContractError("invalid", "terminal input is { data } for keys, or { type: \"paste\", text }");
    },
    "terminal.onData": (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      const listener = listenerArg<string>(args, 1) as unknown as (data: string, exited?: { code: number | null }) => void;
      const terms = node().terminals;
      return watch(ctx, () => terms.onOutput((o) => {
        if (o.terminalId === id) listener(o.data, o.exited);
      }));
    },
    "terminal.resize": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      own(ctx, id);
      if (typeof args[1] !== "number" || typeof args[2] !== "number") throw new ContractError("invalid", "a terminal's size is cols and rows");
      await node().terminals.resize(id, termSize(args[1], 80), termSize(args[2], 24));
    },
    "terminal.close": async (ctx, args) => {
      const id = stringArg(args, 0, "the terminal");
      const t = own(ctx, id);
      t.stop?.();
      terminals.delete(id);
      await node().terminals.close(id);
    },
  };
  return {
    handlers,
    async forget(pluginId) {
      for (const [id, t] of [...terminals]) {
        if (t.pluginId !== pluginId) continue;
        t.stop?.();
        terminals.delete(id);
        await s.node()?.terminals.close(id).catch(() => {});
      }
    },
  };
}
