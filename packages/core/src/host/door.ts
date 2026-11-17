// The engine's door for the background host (spec revision 19, §3.1, §3.4, §12.1, items 111 and 112; lane HS): the
// host's own calls (`host.ready`, `host.exiting`, `host.menu`), the windows' views of its tabs (`browser.view.*`), and
// the `host_changed` event, over the `EngineHostSupervisor`.
//
// * Only the host's program calls the host's methods: the connection's program is `host` (`MossConn.program`, lane RT's
//   surface door: the signed identity on macOS, the hello's surface plus the caller check where the OS signs no running
//   image). Every `app` connection may reach these methods by the role's allow list; this is the check.
// * One host connection at a time: its close (its process ended, or the heartbeat ended it) is the supervisor's `exited`,
//   a crash unless it said `host.exiting` first. The daemon hands every close to `closed` (the MOSS server's `onClosed`).
// * `browser.view.input` is the person's input: only from program `code` (MOSS Code's window, which saw the press come
//   from the hardware), only on a stream that connection opened, and only to a code session's tab or the person's own.
//   MOSS's window (`moss`) is watch only, and sees only bots' tabs; MOSS Code's sees no bot's tab.
import { ERR, MOSS_ERR, HOST_METHODS, type HostExitReason, type MidWork, type MossWindow, type Program, type TabInputEvent, type TabView } from "@waifucave/moss-protocol";
import { randomUUID } from "node:crypto";
import { MossRpcError, type MossConn, type MossHandler } from "../ipc/moss";
import type { HostStatus } from "../contracts/host-supervisor";
import type { EngineHostSupervisor } from "./supervisor";
import type { EngineTabFrames, TabFrame, TabFrames } from "./tab-frames";

/** How long the host has to take one batch of the person's input. */
export const HOST_TAB_INPUT_TIMEOUT_MS = 5_000;
/** How long the host has to answer `host.stop` (it then exits; its close is what the supervisor waits for). */
export const HOST_STOP_TIMEOUT_MS = 5_000;

/** The program a connection is (lane RT's door put it there at the hello); never a call's own word. */
export function programOf(conn: MossConn): Program | undefined {
  return conn.program;
}

/** Where the bots live (lane BT's one switch, `bots/source.ts`): `code` while MOSS Code's window still shows them (the
 *  switch at its default, `plugins`), `moss` once they are served as records to the MOSS app. The controller's ruling:
 *  the views' rule follows it, here and nowhere else. */
export type BotsShownIn = "code" | "moss";

/** Which tabs a window may see. While MOSS Code shows the bots, its window sees every tab as today's does (and MOSS's
 *  sees bots' tabs). Once the bots are MOSS's: MOSS Code's window code sessions' and the person's own, MOSS's bots'. */
export function viewMayShow(program: Program | undefined, tab: Pick<TabView, "owner">, bots: BotsShownIn = "moss"): boolean {
  if (program === "moss") return tab.owner.kind === "bot";
  if (program === "code") return tab.owner.kind === "session" || tab.owner.kind === "user" || (bots === "code" && tab.owner.kind === "bot");
  return false;
}

/** Which tabs take the person's input from a view: MOSS Code's, on a code session's tab or the person's own, and on a
 *  bot's while MOSS Code still shows the bots (today's rule). MOSS's view is watch only. */
export function viewTakesInput(program: Program | undefined, tab: Pick<TabView, "owner">, bots: BotsShownIn = "moss"): boolean {
  return program === "code" && (tab.owner.kind === "session" || tab.owner.kind === "user" || (bots === "code" && tab.owner.kind === "bot"));
}

export interface HostDoorDeps {
  supervisor: EngineHostSupervisor;
  /** Sends `host_changed` to the connections that may have it. */
  emit(event: { type: "host_changed"; state: HostStatus["state"]; crashes: number; release?: string; bundlePath?: string; since: number; gaveUp?: boolean }): void;
  /** R12: where the host's surfaces are now (`host.surfaces`), or none once it is gone: this computer's MOSS windows. */
  surfacesAt?(windows: readonly MossWindow[]): void;
  /** The supervisor's state changed: the windows' mounts and the pair follow (the MOSS server's `hostScreen`). */
  screenChanged?(status: HostStatus): void;
  now(): number;
  /** The pid holding the host lock (the host's own process), when the OS has a lock. */
  lockPid(): number | null;
  ask(conn: MossConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** What is mid-work now, for "quit everything". */
  midWork(): MidWork;
  /** Opens MOSS or MOSS Code: shows its window if it runs, else starts it through the OS. */
  openApp(program: "moss" | "code"): Promise<void>;
  /** Stops the host, both apps and the engine (after the answer to the click has gone). */
  quitEverything(): void;
  /** Where the bots are shown now (lane BT's switch); default `moss`, the rule after the bots have left MOSS Code. */
  botsShownIn?(): BotsShownIn;
  /** Whether a window of the product is focused and visible now (the router's `front()`); the host hears it on ready. */
  windowFront?(): boolean;
  /** A tab the browser knows, by id (the MOSS Browser's `BrowserService`). */
  tab(id: string): TabView | undefined;
  /** A tab's pictures (`tab-frames.ts`); `accept` takes `host.tab.frame`. */
  frames: TabFrames & Pick<EngineTabFrames, "accept" | "ownerGone" | "reown">;
  log?(line: string): void;
}

export interface HostDoor {
  readonly handlers: Readonly<Record<string, MossHandler>>;
  /** The live host's connection, if any. */
  hostConn(): MossConn | undefined;
  /** Sends the live host `host.stop`; false when none is connected. */
  stopHost(reason: HostExitReason): boolean;
  /** A connection closed (the MOSS server's `onClosed`): the host's is its exit; a window's views and a pages owner's
   *  streams end with it. */
  closed(conn: MossConn): void;
  /** The router's `front()` changed: the live host hears it (`host.front`). */
  frontChanged(front: boolean): void;
  dispose(): void;
}

interface ViewStream { connId: number; tab: string; program: Program | undefined; stop?: () => void }

export function hostDoor(deps: HostDoorDeps): HostDoor {
  const log = deps.log ?? (() => {});
  let host: MossConn | undefined;
  let since = deps.now();
  let lastState: HostStatus["state"] | undefined;
  const views = new Map<string, ViewStream>();

  const statusNow = (s: HostStatus) => ({ state: s.state, crashes: s.crashes, ...(s.release !== undefined ? { release: s.release } : {}), ...(s.bundlePath !== undefined ? { bundlePath: s.bundlePath } : {}), since, ...(s.gaveUp === true ? { gaveUp: true } : {}) });
  const unwatch = deps.supervisor.watch((s) => {
    if (s.state !== lastState) { lastState = s.state; since = deps.now(); }
    deps.emit({ type: "host_changed", ...statusNow(s) });
    deps.screenChanged?.(s);
  });

  const fromHost = (conn: MossConn, method: string): void => {
    if (conn.role !== "app" || programOf(conn) !== "host") throw new MossRpcError(MOSS_ERR.NOT_THE_USER, `${method} is the background host's alone`);
  };

  const closeView = (id: string): void => {
    const v = views.get(id);
    if (!v) return;
    views.delete(id);
    try { v.stop?.(); } catch { /* the host is gone */ }
  };

  const hostClosed = (conn: MossConn): void => {
    if (host?.connId !== conn.connId) return;
    host = undefined;
    for (const id of [...views.keys()]) closeView(id);
    deps.surfacesAt?.([]);
    deps.supervisor.exited();
  };

  const tellFront = (conn: MossConn, front: boolean): void => {
    deps.ask(conn, HOST_METHODS.hostFront.name, { front }, HOST_STOP_TIMEOUT_MS).catch((e: unknown) => log(`[host] host.front went unanswered: ${(e as Error).message}`));
  };

  const stopHost = (reason: HostExitReason): boolean => {
    const conn = host;
    if (conn === undefined) return false;
    deps.ask(conn, HOST_METHODS.hostStop.name, { reason }, HOST_STOP_TIMEOUT_MS).catch((e: unknown) => log(`[host] host.stop went unanswered: ${(e as Error).message}`));
    return true;
  };

  const handlers: Record<string, MossHandler> = {
    [HOST_METHODS.hostReady.name]: (conn, raw) => {
      fromHost(conn, "host.ready");
      const p = HOST_METHODS.hostReady.params.parse(raw);
      if (host !== undefined && host.connId !== conn.connId) {
        // The server lets only one host connection live; a ready from another means the first one's close is still on its way.
        throw new MossRpcError(ERR.RETRY, "another host connection is still live");
      }
      host = conn;
      // The pages' owner may have changed (a host took them from the window): open views' streams move to it.
      queueMicrotask(() => deps.frames.reown());
      // Whether a window is in front now, on every ready (a host that comes up under a window in front hides its strip line at
      // once; one that reconnected forgets what it heard on its last connection).
      if (deps.windowFront !== undefined) queueMicrotask(() => { if (host?.connId === conn.connId) tellFront(conn, deps.windowFront!()); });
      deps.supervisor.ready({ pid: deps.lockPid() ?? 0, release: p.release, bundlePath: p.bundlePath, safeMode: p.safeMode });
      log(`[host] ready: ${p.parts.surfaces} surfaces, ${p.parts.background} background parts, ${p.parts.tabs.length} tabs${p.safeMode ? ", in safe mode" : ""}`);
      return { ok: true };
    },
    [HOST_METHODS.hostExiting.name]: (conn, raw) => {
      fromHost(conn, "host.exiting");
      const p = HOST_METHODS.hostExiting.params.parse(raw);
      if (host?.connId === conn.connId) deps.supervisor.exiting(p.reason);
      return { ok: true };
    },
    [HOST_METHODS.hostMenu.name]: async (conn, raw) => {
      fromHost(conn, "host.menu");
      const p = HOST_METHODS.hostMenu.params.parse(raw);
      if (p.action === "open-moss" || p.action === "open-code") {
        await deps.openApp(p.action === "open-moss" ? "moss" : "code");
        return { done: true };
      }
      const working = deps.midWork();
      if (p.confirmed !== true && (working.turns > 0 || working.agents > 0 || working.routines > 0)) return { done: false, working };
      // After the answer has gone: the host is told to stop as part of quitting everything.
      setTimeout(() => deps.quitEverything(), 0);
      return { done: true };
    },
    [HOST_METHODS.hostSurfaces.name]: (conn, raw) => {
      fromHost(conn, "host.surfaces");
      const p = HOST_METHODS.hostSurfaces.params.parse(raw);
      if (host?.connId !== conn.connId) throw new MossRpcError(ERR.RETRY, "the host says it is ready first");
      deps.surfacesAt?.(p.windows);
      log(`[host] surfaces: ${p.windows.length} on the screen (${p.windows.map((w) => w.id).join(", ").slice(0, 200)})`);
      return { ok: true };
    },
    [HOST_METHODS.hostStatus.name]: (_conn, raw) => {
      HOST_METHODS.hostStatus.params.parse(raw ?? {});
      return statusNow(deps.supervisor.status());
    },
    [HOST_METHODS.hostTabFrame.name]: (conn, raw) => {
      const p = HOST_METHODS.hostTabFrame.params.parse(raw);
      if (conn.role !== "app" || programOf(conn) === "moss") throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "a tab's pictures come from the program that runs the pages");
      // A refused frame is answered as refused, so a sender that isn't the owner hears it; a dropped one is fine.
      if (deps.frames.accept(conn, p) === "refused") throw new MossRpcError(ERR.INVALID_PARAMS, "frame refused");
      return { ok: true };
    },
    [HOST_METHODS.browserViewOpen.name]: async (conn, raw) => {
      const p = HOST_METHODS.browserViewOpen.params.parse(raw);
      const program = programOf(conn);
      if (conn.role !== "app" || (program !== "moss" && program !== "code")) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "a tab's view is a window's");
      const tab = deps.tab(p.tab);
      if (tab === undefined) throw new MossRpcError(ERR.INVALID_PARAMS, "no such tab");
      if (!viewMayShow(program, tab, deps.botsShownIn?.())) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, program === "moss" ? "MOSS's window shows only bots' tabs" : "MOSS Code's window shows no bot's tab");
      if (host === undefined) throw new MossRpcError(ERR.RETRY, "the background host isn't running; it starts again by itself");
      const stream = `view-${randomUUID()}`;
      const view: ViewStream = { connId: conn.connId, tab: tab.id, program };
      views.set(stream, view);
      // Each frame goes on as this view's own picture: the window hears its stream id, never the tab stream's.
      view.stop = deps.frames.subscribe(tab.id, (f: TabFrame) => {
        try { conn.notify("picture.frame", { stream, seq: f.seq, format: f.format, width: f.width, height: f.height, data: f.data, at: f.at }); } catch { /* it just closed */ }
      }, p.maxFps !== undefined ? { maxFps: p.maxFps } : {});
      return { stream };
    },
    [HOST_METHODS.browserViewClose.name]: (conn, raw) => {
      const p = HOST_METHODS.browserViewClose.params.parse(raw);
      const v = views.get(p.stream);
      if (v === undefined || v.connId !== conn.connId) throw new MossRpcError(ERR.INVALID_PARAMS, "no such view on this connection");
      closeView(p.stream);
      return { ok: true };
    },
    [HOST_METHODS.browserViewInput.name]: async (conn, raw) => {
      const p = HOST_METHODS.browserViewInput.params.parse(raw);
      const program = programOf(conn);
      if (conn.role !== "app" || program !== "code") throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "only MOSS Code's window forwards the person's input; MOSS's view is watch only");
      const v = views.get(p.stream);
      if (v === undefined || v.connId !== conn.connId) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "input goes only to a view this window opened");
      const tab = deps.tab(v.tab);
      if (tab === undefined) throw new MossRpcError(ERR.INVALID_PARAMS, "the tab is gone");
      if (!viewTakesInput(program, tab, deps.botsShownIn?.())) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "this tab takes no input from a view");
      const h = host;
      if (h === undefined) throw new MossRpcError(ERR.RETRY, "the background host isn't running");
      await deps.ask(h, HOST_METHODS.hostTabInput.name, { id: tab.id, events: p.events as TabInputEvent[] }, HOST_TAB_INPUT_TIMEOUT_MS);
      return { ok: true };
    },
  };

  return {
    handlers,
    hostConn: () => host,
    stopHost,
    closed(conn) {
      for (const [id, v] of [...views]) if (v.connId === conn.connId) closeView(id);
      deps.frames.ownerGone(conn.connId);
      hostClosed(conn);
      deps.frames.reown();
    },
    frontChanged(front) {
      if (host !== undefined) tellFront(host, front);
    },
    dispose() {
      unwatch();
      for (const id of [...views.keys()]) closeView(id);
    },
  };
}
