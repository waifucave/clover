// The background host's side of its connection to the engine (spec revision 19, §3.1, §5.8, items 98, 112 and 116;
// lane HS): it says it is up (`host.ready`) on every connection, answers the engine's requests (`host.stop`,
// `host.adopt`, `host.safeMode`, `host.tab.input`, `host.front`), and tells the engine before it leaves on purpose (`host.exiting`).
// Its menu's "stop everything" asks the engine (`host.menu`), which says what is mid-work before it acts. The main
// process gives the deps; nothing here imports Electron (test/host-runtime.test.ts).
import { HOST_METHODS, type HostExitReason, type HostParts, type MidWork, type TabInputEvent } from "@waifucave/moss-protocol";

export interface HostClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface HostRuntimeDeps {
  release: string;
  /** The app bundle (or install) this host runs from. */
  bundlePath: string;
  safeMode: boolean;
  parts(): HostParts;
  /** The engine's connection now, if any. */
  client(): HostClient | undefined;
  /** Leaves the process (its windows, its tabs, its lock), with no question asked. */
  leave(): void;
  tabInput(id: string, events: readonly TabInputEvent[]): void;
  /** The engine says whether a MOSS or MOSS Code window is in front now (`host.front`). */
  front?(front: boolean): void;
  log(line: string): void;
  /** Runs `fn` after `ms` (default: a timer). */
  after?(ms: number, fn: () => void): void;
}

/** The bundle a host runs from: the outermost `.app` on macOS (the app whose copy carries it), else the program itself. */
export function hostBundlePath(execPath: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    const i = execPath.indexOf(".app/");
    if (i >= 0) return execPath.slice(0, i + 4);
  }
  return execPath;
}

export interface HandlerHost {
  handle(method: string, fn: (params: unknown) => unknown): void;
}

/** The engine's requests to the host. */
export function installHostHandlers(pair: HandlerHost, d: HostRuntimeDeps): void {
  const after = d.after ?? ((ms, fn) => { setTimeout(fn, ms); });
  pair.handle(HOST_METHODS.hostStop.name, (raw) => {
    const p = HOST_METHODS.hostStop.params.parse(raw);
    d.log(`host: the engine stops it (${p.reason})`);
    // The answer goes first; the engine waits for the connection to close.
    after(50, () => d.leave());
    return { ok: true };
  });
  pair.handle(HOST_METHODS.hostAdopt.name, () => ({ release: d.release, safeMode: d.safeMode, parts: d.parts() }));
  pair.handle(HOST_METHODS.hostSafeMode.name, (raw) => {
    const p = HOST_METHODS.hostSafeMode.params.parse(raw);
    if (p.on === d.safeMode) return { ok: true };
    // Into safe mode: it leaves for it, and the engine starts it again so. Out of it: no exit reason says "start me again
    // normally" (an `update` exit is a stop, a bare exit a crash), so it stays until its next start, which is normal.
    if (p.on) after(0, () => void leaveFor(d, "safe-mode"));
    else d.log("host: safe mode ends at its next start");
    return { ok: true };
  });
  pair.handle(HOST_METHODS.hostTabInput.name, (raw) => {
    const p = HOST_METHODS.hostTabInput.params.parse(raw);
    d.tabInput(p.id, p.events);
    return { ok: true };
  });
  pair.handle(HOST_METHODS.hostFront.name, (raw) => {
    const p = HOST_METHODS.hostFront.params.parse(raw);
    d.front?.(p.front);
    return { ok: true };
  });
}

/** `host.ready` on a new connection: what it runs, from which copy, in safe mode or not. */
export async function sayHostReady(client: HostClient, d: Pick<HostRuntimeDeps, "release" | "bundlePath" | "safeMode" | "parts" | "log">): Promise<void> {
  try {
    await client.request(HOST_METHODS.hostReady.name, { release: d.release, bundlePath: d.bundlePath, safeMode: d.safeMode, parts: d.parts() }, 10_000);
    d.log(`host: ready${d.safeMode ? " (safe mode)" : ""}`);
  } catch (err) {
    d.log(`host: host.ready was refused (${err instanceof Error ? err.message.slice(0, 160) : "no answer"})`);
  }
}

/** Leaves on purpose: the engine hears why first (`host.exiting`), so the exit is no crash. */
export async function leaveFor(d: Pick<HostRuntimeDeps, "client" | "leave" | "log">, reason: HostExitReason): Promise<void> {
  const c = d.client();
  await c?.request(HOST_METHODS.hostExiting.name, { reason }, 3_000).catch(() => undefined);
  d.log(`host: leaving (${reason})`);
  d.leave();
}

/** How long the host stays without its engine before it leaves by itself (lane HV). The engine owns the host: one that is
 *  gone for good (it crashed and nothing starts it again, it was force-quit, its home was deleted) leaves a host that would
 *  redial forever, its island and pages with it, answering nothing. The legitimate gaps are far shorter: launchd starts a
 *  crashed engine again after 1 s (`ThrottleInterval`), a release switch replaces it as soon as nothing is mid-work, and a
 *  booted engine adopts the host that holds the lock if it says ready within `HOST_START_TIMEOUT_MS` (45 s); the host
 *  redials at least every 5 s. Two minutes is past all of them (`HOST_SOURCE_GRACE_MS`, the engine's own wait for an app
 *  that carries the host, is the same). A host that left early costs little: the engine starts a new one when it boots, and
 *  the cards are told to it on its connection. */
export const HOST_ENGINE_GONE_MS = 120_000;

/** Why the host left: one line for its log. */
export function engineGoneLine(ms: number): string {
  return `host: no engine for ${Math.round(ms / 1000)} s (its connection closed or never came, and no engine took the host since): the host leaves, and its pages and parts end with it`;
}

/** The host's watch on its engine: `connected(false)` from the start and at each loss arms one timer; `connected(true)`
 *  disarms it. When it runs out the host leaves (`leave`). The engine's socket is the whole watch: a crashed or killed
 *  engine's socket closes at once (the kernel closes it), and a hello the engine refuses (a second host on the home, a
 *  host behind its release) never counts as connected. */
export class EngineWatch {
  private timer: { cancel(): void } | undefined;
  private done = false;
  constructor(private readonly d: { boundMs?: number; after(ms: number, fn: () => void): { cancel(): void }; leave(): void; log(line: string): void }) {}

  connected(up: boolean): void {
    if (this.done) return;
    if (up) {
      this.timer?.cancel();
      this.timer = undefined;
      return;
    }
    if (this.timer !== undefined) return;
    const ms = this.d.boundMs ?? HOST_ENGINE_GONE_MS;
    this.timer = this.d.after(ms, () => {
      this.timer = undefined;
      this.done = true;
      this.d.log(engineGoneLine(ms));
      this.d.leave();
    });
  }

  /** The host is leaving anyway (a stop, a quit): no timer left behind. */
  stop(): void {
    this.done = true;
    this.timer?.cancel();
    this.timer = undefined;
  }
}

/** "Stop everything" from the host's menu: the engine answers what is mid-work, `confirm` asks the person, and the engine
 *  stops the host, both apps and itself only when they say yes. */
export async function stopEverything(d: Pick<HostRuntimeDeps, "client" | "log">, confirm: (working: MidWork) => Promise<boolean>): Promise<"stopped" | "kept" | "no-engine"> {
  const c = d.client();
  if (c === undefined) return "no-engine";
  const first = HOST_METHODS.hostMenu.result.parse(await c.request(HOST_METHODS.hostMenu.name, { action: "quit-everything" }, 10_000));
  if (first.done) return "stopped";
  if (!(await confirm(first.working))) {
    d.log("host: stop everything: kept working");
    return "kept";
  }
  await c.request(HOST_METHODS.hostMenu.name, { action: "quit-everything", confirmed: true }, 10_000);
  return "stopped";
}
