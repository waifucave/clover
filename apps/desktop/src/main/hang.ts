// Ruling R9, the app's side: a hang restarts the app into safe mode, but only the core's own hang. Chromium sends every
// frame's hang to its window, and Electron 45's `unresponsive` doesn't say which frame hung, so when a window goes
// unresponsive the app pings each document in it (`hangVerdict`): a plugin layer that doesn't answer has its process
// killed, and its parent shows the "stopped, reload" placeholder (the census finds it gone); a core root that doesn't
// answer, for 15 s, restarts the app into safe mode. A window that stays unresponsive while its root answers (every
// document answering: the GPU process or the compositor, or a hang that killing a layer didn't end) restarts it too,
// after a longer window, 60 s, since that hang isn't any page's. The daemon's side (lane C) is the pair's heartbeat: the
// app answers `app.ping` at once from its main process, and a daemon that hears nothing for a while restarts it, in
// safe mode. Pure, so the rules and the timing are unit-tested.

/** How long a document has to answer a ping once its window went unresponsive. */
export const HANG_PING_MS = 3_000;

export interface PingResult {
  /** The window's core root, or a plugin layer's document. */
  kind: "root" | "layer";
  /** The document's renderer process. */
  osPid?: number;
  answered: boolean;
}

/** What to do about an unresponsive window, from its documents' pings: restart soon when a core root didn't answer;
 *  otherwise kill the processes of the plugin layers that didn't, never one that also holds a core root, nor the
 *  app's own process, and restart only if the window still hasn't come back after the longer window (`later`). */
export function hangVerdict(results: readonly PingResult[], ownPid: number): { restart: boolean; later: boolean; kill: number[] } {
  const rootPids = new Set(results.filter((r) => r.kind === "root" && r.osPid !== undefined).map((r) => r.osPid!));
  const restart = results.some((r) => r.kind === "root" && !r.answered);
  const kill = new Set<number>();
  for (const r of results) {
    if (r.kind !== "layer" || r.answered || r.osPid === undefined || r.osPid <= 0) continue;
    if (r.osPid === ownPid || rootPids.has(r.osPid)) continue;
    kill.add(r.osPid);
  }
  return { restart, later: !restart, kill: [...kill] };
}

/** How long a window whose core root doesn't answer may stay unresponsive before the app restarts into safe mode. */
export const HANG_RESTART_MS = 15_000;
/** How long a window may stay unresponsive while its documents answer (the GPU or compositor case). */
export const HANG_COMPOSITOR_MS = 60_000;

export class HangWatch {
  private readonly hung = new Map<number, { timer: ReturnType<typeof setTimeout>; at: number }>();
  private fired = false;

  constructor(
    private readonly restart: (windowId: number) => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    private readonly afterMs = HANG_RESTART_MS,
  ) {}

  /** A window went unresponsive: the countdown to a restart starts, `afterMs` long (its core root stopped answering:
   *  the short one; its documents answer: `HANG_COMPOSITOR_MS`). A countdown already running keeps the sooner end. */
  unresponsive(windowId: number, afterMs = this.afterMs, now = Date.now()): void {
    if (this.fired) return;
    const running = this.hung.get(windowId);
    if (running !== undefined) {
      if (running.at <= now + afterMs) return;
      this.timers.clear(running.timer);
    }
    const timer = this.timers.set(() => {
      this.hung.delete(windowId);
      if (this.fired) return;
      this.fired = true;
      this.restart(windowId);
    }, afterMs);
    this.hung.set(windowId, { timer, at: now + afterMs });
  }

  /** It answers again (`responsive`), or it closed. */
  responsive(windowId: number): void {
    const t = this.hung.get(windowId);
    if (t !== undefined) this.timers.clear(t.timer);
    this.hung.delete(windowId);
  }
}
