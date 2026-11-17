// The background host's side of the engine, put together for `daemon.ts` (lane HS): the real world, the supervisor,
// the tab frames and the door, over the MOSS server's connections. The daemon adds `handlers` to its MOSS handlers,
// calls `boot` once its socket listens, and `dispose` as it stops.
import { type AppInstallRecord, type MidWork, type MossWindow, type TabView, type Viewport } from "@waifucave/moss-protocol";
import { SystemClock } from "../clock/system-clock";
import type { MossConn, MossHandler } from "../ipc/moss";
import type { Runner } from "../platform/login/live";
import type { DaemonPlatform } from "../platform/transport";
import type { MossProfile } from "../profile";
import { hostDoor, type HostDoor } from "./door";
import { EngineHostSupervisor } from "./supervisor";
import { EngineTabFrames } from "./tab-frames";
import { engineHostWorld, hostLockHolder, launchApp } from "./world";
import { hostOwnsScreen } from "./mounts";
import { botSource } from "../bots/source";

export interface HostSupervisionInput {
  readonly home: string;
  readonly os: DaemonPlatform;
  readonly profile: MossProfile;
  readonly release: string;
  readonly run: Runner;
  readonly dist: boolean;
  readonly testBuild: boolean;
  readonly env: Record<string, string | undefined>;
  connections(): readonly MossConn[];
  ask(conn: MossConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  coreEvent(event: { type: string; [k: string]: unknown }): void;
  /** The update gate's busy sources (`name:count`), for "quit everything"'s warning. */
  busy(): readonly string[];
  /** The MOSS Browser's tabs on this computer, as the person sees them. */
  tabs(): readonly TabView[];
  /** Stops the engine (and with it, by `app.quit`, the apps) after the host was told to go. */
  quitEverything(): void;
  /** The newest app that carries the host (lane RL's `hostSource`); default: the world's own read of the records. */
  source?(): AppInstallRecord | undefined;
  /** Starts an app through the OS when it isn't running (the newest record of that program). */
  launchApp?(program: "moss" | "code"): Promise<void>;
  /** R12: the host's surfaces on the screen (this computer's MOSS windows, `computers.mossWindows`). */
  surfacesAt?(windows: readonly MossWindow[]): void;
  /** The supervisor's state changed: whether a host owns the screen now (the MOSS server's `hostScreen`). */
  screenChanged?(owns: boolean): void;
  /** Whether a window of the product is focused and visible now (the router's `front()`). */
  windowFront?(): boolean;
  log?(line: string): void;
}

export interface HostSupervision {
  readonly supervisor: EngineHostSupervisor;
  readonly frames: EngineTabFrames;
  readonly door: HostDoor;
  readonly handlers: Readonly<Record<string, MossHandler>>;
  boot(): Promise<void>;
  dispose(): void;
}

/** Mid-work from the update gate's busy list: turns (the sessions' and the bots'), agents and routines. */
export function midWorkOf(busy: readonly string[]): MidWork {
  const count = (names: string[]) => busy.reduce((n, b) => {
    const [name, c] = b.split(":");
    return names.includes(name ?? "") ? n + (Number(c) || 0) : n;
  }, 0);
  return { turns: count(["turns", "bot-turns"]), agents: count(["agents", "workflows"]), routines: count(["routines"]) };
}

export function startHostSupervision(input: HostSupervisionInput): HostSupervision {
  const log = input.log ?? ((line: string) => console.error(line));
  let supervisor: EngineHostSupervisor | undefined;
  let door: HostDoor | undefined;
  const world = engineHostWorld({
    home: input.home, os: input.os, profile: input.profile, release: input.release, run: input.run, dist: input.dist, testBuild: input.testBuild, env: input.env,
    stopHost: (reason) => door?.stopHost(reason) ?? false,
    ...(input.source !== undefined ? { source: input.source } : {}),
    // A start that failed counts once, while the start is still the supervisor's (a host that already said ready is heard by
    // its connection's close instead).
    startFailed: () => { if (supervisor?.status().state === "starting") supervisor.exited(); },
    log,
  });
  supervisor = new EngineHostSupervisor({ clock: new SystemClock(), world, log });
  const frames = new EngineTabFrames({
    connections: input.connections, ask: input.ask, log,
    hostOwnsScreen: () => hostOwnsScreen(supervisor?.status().state),
    viewport: (id): Viewport | undefined => input.tabs().find((t) => t.id === id)?.viewport,
  });
  door = hostDoor({
    supervisor, frames, ask: input.ask, now: Date.now, log,
    emit: (e) => input.coreEvent(e),
    screenChanged: (s) => input.screenChanged?.(hostOwnsScreen(s.state)),
    surfacesAt: (w) => input.surfacesAt?.(w),
    windowFront: () => input.windowFront?.() ?? false,
    lockPid: () => hostLockHolder(input.home, input.os),
    midWork: () => midWorkOf(input.busy()),
    tab: (id) => input.tabs().find((t) => t.id === id),
    // The views follow lane BT's switch: MOSS Code shows the bots until they are served as records.
    botsShownIn: () => (botSource(input.env) === "plugins" ? "code" : "moss"),
    openApp: async (program) => {
      const live = input.connections().find((c) => c.role === "app" && c.program === program);
      if (live !== undefined) { live.send("app.show", { what: { kind: "window" } }); return; }
      await (input.launchApp ?? ((p: "moss" | "code") => launchApp({ home: input.home, os: input.os, run: input.run, log }, p)))(program);
    },
    quitEverything: () => {
      door?.stopHost("quit-everything");
      input.quitEverything();
    },
  });
  const s = supervisor;
  const d = door;
  return {
    supervisor: s,
    frames,
    door: d,
    handlers: d.handlers,
    async boot() {
      const how = await s.boot();
      log(`[host] boot: ${how}`);
    },
    dispose() {
      s.dispose();
      d.dispose();
    },
  };
}
