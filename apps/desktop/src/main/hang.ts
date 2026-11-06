// Ruling R9, the app's side: a hang restarts the app into safe mode, but only the core's own hang. Chromium sends every
// frame's hang to its window, and Electron 45's `unresponsive` doesn't say which frame hung, so when a window goes
// unresponsive the app pings each document in it (`hangVerdict`): a plugin layer that doesn't answer has its process
// killed, and its parent shows the "stopped, reload" placeholder (the census finds it gone); only a core root that
// doesn't answer, for 15 s, restarts the app into safe mode. The daemon's side (lane C) is the pair's heartbeat: the
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

/** What to do about an unresponsive window, from its documents' pings: restart only when a core root didn't answer;
 *  otherwise kill the processes of the plugin layers that didn't, never one that also holds a core root, nor the
 *  app's own process. */
export function hangVerdict(results: readonly PingResult[], ownPid: number): { restart: boolean; kill: number[] } {
  const rootPids = new Set(results.filter((r) => r.kind === "root" && r.osPid !== undefined).map((r) => r.osPid!));
  const restart = results.some((r) => r.kind === "root" && !r.answered);
  const kill = new Set<number>();
  for (const r of results) {
    if (r.kind !== "layer" || r.answered || r.osPid === undefined || r.osPid <= 0) continue;
    if (r.osPid === ownPid || rootPids.has(r.osPid)) continue;
    kill.add(r.osPid);
  }
  return { restart, kill: [...kill] };
}

/** How long a window may stay unresponsive before the app restarts into safe mode. */
export const HANG_RESTART_MS = 15_000;

export class HangWatch {
  private readonly hung = new Map<number, ReturnType<typeof setTimeout>>();
  private fired = false;

  constructor(
    private readonly restart: (windowId: number) => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
    private readonly afterMs = HANG_RESTART_MS,
  ) {}

  /** A window's core root stopped answering. */
  unresponsive(windowId: number): void {
    if (this.fired || this.hung.has(windowId)) return;
    this.hung.set(windowId, this.timers.set(() => {
      this.hung.delete(windowId);
      if (this.fired) return;
      this.fired = true;
      this.restart(windowId);
    }, this.afterMs));
  }

  /** It answers again (`responsive`), or it closed. */
  responsive(windowId: number): void {
    const t = this.hung.get(windowId);
    if (t !== undefined) this.timers.clear(t);
    this.hung.delete(windowId);
  }
}
