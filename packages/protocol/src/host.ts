// MOSS protocol area: the background host (spec revision 19, §3.1 "The engine and the background host are the always-on
// part", "The engine and the host, precisely", §3.4, §5.8 safe mode, §12.1, items 98, 111, 112, 116; rulings R6, R7).
// Owner: lane HS (the background host). Shapes pinned by lane SP; nothing here is served yet.
//
// * The host is a nested helper app with one fixed identity (`com.waifucave.moss.host`), one per home, holding its own
//   lock (`HOST_LOCK_FILE`). The engine starts it through the OS from the newest app that carries it; it connects as the
//   `app` role with `surface: "host"` and mounts the screen's points and the background parts (`SURFACE_MOUNTS.host`).
// * Supervision: the host says it is up (`host.ready`) and tells the engine before it exits on purpose (`host.exiting`).
//   The engine restarts a crashed host with growing delays (`HOST_RESTART_DELAYS_MS`); after `HOST_CRASH_LIMIT` crashes in
//   `HOST_CRASH_WINDOW_MS` the host starts in safe mode, which covers its UI parts only. Before an update the engine stops
//   it (`host.stop`); after an engine restart the engine adopts the running host found by its lock (`host.adopt`).
// * The menu bar is the host's: open MOSS, open MOSS Code, and "quit everything", which warns when something is mid-work
//   (`host.menu`). Quitting an app never stops work.
// * The MOSS Browser's tabs live in the host (item 111): the engine's tab requests (`app.tab.*`, browser.ts) go to the
//   host's connection. A window shows a tab as a picture (`browser.view.open`, its frames as `picture.frame`
//   notifications, activity.ts) and MOSS Code's panel forwards the person's input (`browser.view.input` → `host.tab.input`).
//   MOSS's side panel only watches. The frames come to the engine from the program that runs the pages
//   (`host.tab.frame`, a request: the server takes no client notification), at most one in flight, latest wins.
import { z } from "zod";
import { utf16 } from "./strings";
import { Ok, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { Release } from "./release";
import { PictureFrame } from "./activity";
import { MossWindow } from "./computers";

/** The host's single-instance lock, under the home (one host per home, not per user). */
export const HOST_LOCK_FILE = "run/host.lock";
/** Safe mode after this many crashes inside the window (§3.1). */
export const HOST_CRASH_LIMIT = 3;
export const HOST_CRASH_WINDOW_MS = 120_000;
/** The engine's waits before each restart of a crashed host, the last repeated. */
export const HOST_RESTART_DELAYS_MS = [500, 2_000, 8_000, 30_000] as const;
/** A host that never says it is ready is started this many times in a row (once, then after each restart delay), then
 *  no more until the engine starts again: the state is `absent` with `gaveUp`, the screen is the windows' again (the
 *  router has no island; cards draw in a focused window) and each window shows one plain notice. A host that says it is
 *  ready starts the count over. */
export const HOST_START_ATTEMPTS = HOST_RESTART_DELAYS_MS.length + 1;
/** How long a host the engine started (or found holding the lock) has to say `host.ready` before the engine counts it as
 *  a crash: a host that never connects, or dies before its hello, never closes a connection, so without this the engine
 *  would wait in `starting` for ever. Longer than the longest restart delay, and than a cold start at login. */
export const HOST_START_TIMEOUT_MS = 45_000;
/** An app's record can be missing for a moment (its bundle is being replaced by an update): the engine looks again
 *  every `HOST_SOURCE_RECHECK_MS` for `HOST_SOURCE_GRACE_MS` before it takes "no app carries a host" as so, and runs
 *  headless. A window that connects later makes it look again too. */
export const HOST_SOURCE_GRACE_MS = 120_000;
export const HOST_SOURCE_RECHECK_MS = 5_000;
/** What the engine leaves for the host it starts (`{ by, safeMode, at }`), under the home: none of the OS starts
 *  (`open -a`, `systemctl --user start`, `schtasks /Run`) passes arguments reliably. The host reads it once, deletes it
 *  and honours it for `HOST_START_FILE_TTL_MS`. */
export const HOST_START_FILE = "run/host-start.json";
export const HOST_START_FILE_TTL_MS = 60_000;

/** Why the host exits or is stopped. */
export const HostExitReason = z.enum([
  /** An app update replaces the bundle the host runs from, or a newer engine comes in (§3.1). */
  "update",
  /** The menu's "quit everything". */
  "quit-everything",
  /** Restart in safe mode: the host goes and the engine starts it again at once with its UI parts in safe mode (no
   *  third-party part mounted). The one reason after which the engine starts the host again. */
  "safe-mode",
  /** No app that carries a host is left on disk (item 109: the engine then runs headless). */
  "no-app",
]);
export type HostExitReason = z.infer<typeof HostExitReason>;

export const HostState = z.enum(["starting", "running", "safe-mode", "restarting", "stopped", "absent"]);
export type HostState = z.infer<typeof HostState>;

/** What a host runs, as it tells the engine when it is up or adopted. */
export const HostParts = z.object({
  surfaces: z.number().int().nonnegative(),
  background: z.number().int().nonnegative(),
  /** The MOSS Browser's tabs it holds, by id (browser.ts `TabView.id`). */
  tabs: z.array(utf16(128, 1)).max(1024),
});
export type HostParts = z.infer<typeof HostParts>;

/** The menu-bar actions (item 112). */
export const HostMenuAction = z.enum(["open-moss", "open-code", "quit-everything"]);
export type HostMenuAction = z.infer<typeof HostMenuAction>;

/** What is mid-work, for "quit everything"'s warning. */
export const MidWork = z.object({
  turns: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  routines: z.number().int().nonnegative(),
});
export type MidWork = z.infer<typeof MidWork>;

/** The person's input to a tab, from MOSS Code's browser panel: what its main process saw come from the hardware in the
 *  panel's viewport (the press rules of §5.5), in the tab's own coordinates. */
export const TabInputEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mouse"), type: z.enum(["down", "up", "move", "enter", "leave"]), x: z.number(), y: z.number(), button: z.enum(["left", "middle", "right"]).optional(), clicks: z.number().int().min(0).max(3).optional(), modifiers: z.array(utf16(16)).max(8).optional() }),
  z.object({ kind: z.literal("wheel"), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
  z.object({ kind: z.literal("key"), type: z.enum(["down", "up", "char"]), key: utf16(32, 1), code: utf16(32).optional(), modifiers: z.array(utf16(16)).max(8).optional() }),
  z.object({ kind: z.literal("ime"), text: utf16(1024) }),
]);
export type TabInputEvent = z.infer<typeof TabInputEvent>;

/** A window's view of one tab: the size it draws at and how often. */
export const TabViewport = z.object({ width: z.number().int().min(16).max(7680), height: z.number().int().min(16).max(4320), scale: z.number().min(0.5).max(4).optional() });

export const HostChangedEvent = coreEvent("host_changed", {
  state: HostState,
  /** Crashes inside the current window (§3.1). */
  crashes: z.number().int().nonnegative(),
  release: Release.optional(),
  /** The app bundle it runs from. */
  bundlePath: utf16(4096).optional(),
  since: Timestamp,
  /** The engine stopped trying (`HOST_START_ATTEMPTS` starts that never said ready): with `absent`, until it starts again. */
  gaveUp: z.boolean().optional(),
});
/** What `host.status` answers: `host_changed` now, without its type and time. */
export const HostStatusResult = z.object({ state: HostState, crashes: z.number().int().nonnegative(), release: Release.optional(), bundlePath: utf16(4096).optional(), since: Timestamp, gaveUp: z.boolean().optional() });

export const HOST_METHODS = {
  hostReady: defineMethod({
    name: "host.ready", owner: "HS", roles: ["app"],
    params: z.object({ release: Release, bundlePath: utf16(4096, 1), safeMode: z.boolean(), parts: HostParts }),
    result: Ok,
    doc: "The background host is up (its hello said surface host) and says what it runs, from which app's copy.",
  }),
  hostExiting: defineMethod({
    name: "host.exiting", owner: "HS", roles: ["app"],
    params: z.object({ reason: HostExitReason }),
    result: Ok,
    doc: "The host tells the engine before it exits on purpose, so its exit isn't counted as a crash.",
  }),
  hostMenu: defineMethod({
    /** The person's own click in the host's menu-bar menu. "quit everything" with something mid-work answers what is,
     *  and acts only when asked again with `confirmed`. */
    name: "host.menu", owner: "HS", roles: ["app"], userOnly: true,
    params: z.object({ action: HostMenuAction, confirmed: z.boolean().optional() }),
    result: z.discriminatedUnion("done", [
      z.object({ done: z.literal(true) }),
      z.object({ done: z.literal(false), working: MidWork }),
    ]),
    doc: "Open MOSS, open MOSS Code, or quit everything (the engine, the host and both apps), warning first when something is mid-work.",
  }),
  hostAdopt: defineMethod({
    name: "host.adopt", owner: "HS", roles: ["app"], direction: "from-daemon",
    params: z.object({ engine: Release }),
    result: z.object({ release: Release, safeMode: z.boolean(), parts: HostParts }),
    doc: "A restarted engine adopts the running host it found by the host's lock, and hears what it runs.",
  }),
  hostStop: defineMethod({
    name: "host.stop", owner: "HS", roles: ["app"], direction: "from-daemon",
    params: z.object({ reason: HostExitReason }),
    result: Ok,
    doc: "The engine stops the host: before an update replaces its bundle or a newer engine comes in, or to quit everything.",
  }),
  hostSafeMode: defineMethod({
    name: "host.safeMode", owner: "HS", roles: ["app"], direction: "from-daemon",
    params: z.object({ on: z.boolean() }),
    result: Ok,
    doc: "Safe mode for the host's UI parts only (§5.8): no third-party part is mounted; the engine's tools keep running.",
  }),
  hostTabInput: defineMethod({
    name: "host.tab.input", owner: "HS", roles: ["app"], direction: "from-daemon",
    params: z.object({ id: utf16(128, 1), events: z.array(TabInputEvent).min(1).max(256) }),
    result: Ok,
    doc: "The person's input to one of the host's tabs, forwarded from MOSS Code's browser panel.",
  }),
  hostFront: defineMethod({
    name: "host.front", owner: "HS", roles: ["app"], direction: "from-daemon",
    params: z.object({ front: z.boolean() }),
    result: Ok,
    doc: "Whether a MOSS or MOSS Code window is focused and visible now (the router's presence): the host's island hides its strip line then.",
  }),
  hostSurfaces: defineMethod({
    /** R12's host half: where the host's surfaces are on this computer's screen now (the island, the pill, its own card,
     *  the parts it shows), sent when they move, show or hide. The engine keeps them as this computer's MOSS windows
     *  (`computers.mossWindows`), which a computer-use plugin must not act on and blacks out. */
    name: "host.surfaces", owner: "HS", roles: ["app"],
    params: z.object({ windows: z.array(MossWindow).max(64) }).strict(),
    result: Ok,
    doc: "The background host's surfaces on the screen now, for the product's own-windows list.",
  }),
  hostStatus: defineMethod({
    /** A window reads the host's state when it connects (a `host_changed` before its subscription would be missed). */
    name: "host.status", owner: "HS", roles: ["app", "cli"],
    params: z.object({}).strict(),
    result: HostStatusResult,
    doc: "The background host's state now, as host_changed says it.",
  }),
  hostTabFrame: defineMethod({
    /** From the program that runs the browser's pages (the host; today's app until the host runs them), one frame of a
     *  tab stream the engine started (`app.tab.command` `stream` with `codecs: ["jpeg"]`). The sender keeps at most one in
     *  flight and sends only its latest, so a slow engine drops frames, never queues them. The engine refuses a frame from
     *  any other connection, over the stream's declared size, or not a jpeg, png or webp by its own header. */
    name: "host.tab.frame", owner: "HS", roles: ["app"],
    params: PictureFrame,
    result: Ok,
    doc: "One picture of a MOSS Browser tab, from the program that runs its pages, for the windows and tools that show it.",
  }),
  browserViewOpen: defineMethod({
    /** A window asks for a tab's picture; its frames come as `picture.frame` notifications on this connection. MOSS's
     *  side panel shows only a bot's tab (watch only), MOSS Code's view only code sessions' tabs and the person's own. */
    name: "browser.view.open", owner: "HS", roles: ["app"],
    params: z.object({ tab: utf16(128, 1), viewport: TabViewport, maxFps: z.number().int().min(1).max(60).optional() }),
    result: z.object({ stream: utf16(64, 1) }),
    doc: "A window's live picture of one MOSS Browser tab the host runs offscreen.",
  }),
  browserViewClose: defineMethod({
    name: "browser.view.close", owner: "HS", roles: ["app"],
    params: z.object({ stream: utf16(64, 1) }),
    result: Ok,
    doc: "Stops a tab's picture for this window.",
  }),
  browserViewInput: defineMethod({
    /** Only MOSS Code's window (surface `code`), from its main process, for input it saw come from the hardware in the
     *  view's frame; MOSS's view is watch only and is refused. */
    name: "browser.view.input", owner: "HS", roles: ["app"], userOnly: true,
    params: z.object({ stream: utf16(64, 1), events: z.array(TabInputEvent).min(1).max(256) }),
    result: Ok,
    doc: "The person's input to the tab a view shows, which the engine forwards to the host.",
  }),
} as const;

export const HOST_EVENTS = {
  hostChanged: defineEvent({
    type: "host_changed", owner: "HS", roles: ["app", "cli"], schema: HostChangedEvent,
    fixture: { type: "host_changed", ts: 1781270000000, state: "running", crashes: 0, release: "1.111.1", bundlePath: "/Applications/MOSS.app", since: 1781270000000 },
    doc: "The background host's state: starting, running, in safe mode, restarting, stopped, or absent (no app carries one).",
  }),
} as const;
