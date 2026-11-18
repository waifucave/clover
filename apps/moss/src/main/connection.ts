// MOSS's connection to the shared engine (spec §3.1 "Client kinds", "One release for everything"; G1, R4, R7). MOSS's own
// small copy of what MOSS Code's pair does (apps/desktop/src/main/pair/pair.ts, which lanes RT and HS are changing):
//
//   * Dial the engine's socket; prove the endpoint is this user's engine (`protocol.prove`, the token's HMAC over a nonce
//     and this process's pid) before the token goes out; say hello as the `app` role with `surface: "moss"` and this build's
//     `release`. The surface picks the engine's mount list for MOSS (nothing from plugins: its window is built in) and
//     grants no method.
//   * Nothing answers: start the engine through the OS (`moss-core autostart start`, never as MOSS's child), from the
//     copy this app carries, then keep dialling. Each app carries the engine and runs alone (§3.1).
//   * The engine went away: keep the window as it is, redial every 500 ms, slowing to 5 s, and ask the OS again once
//     nothing has answered for 3 s.
//   * Refusals are said as they are: a release behind the engine's (the app must update first), a refused surface.
//   * A release AHEAD of the engine's (lane PK): the engine serves the release door only (`release.status`, `release.bring`,
//     the events), so MOSS is not connected: `onAhead` runs instead of `onConnected` (release.ts's `BringWatch` asks the engine
//     to bring MOSS's release in), and the connection is kept for that door until the engine goes away for the switch.
//   * Quitting MOSS never stops the engine or any work (§3.1, item 112): no `pair.quit`, no hand-over. The engine's own
//     `app.quit` (it is stopping, or updating) is answered, then MOSS leaves.
//
// Pure apart from the injected dial, launcher and clock, so the tests drive it against a fake engine under Bun.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MOSS_ERR, MOSS_PROTOCOL_VERSION, ReleaseRefusal, SurfaceRefusal, type MossHelloParams, type MossHelloResult } from "@waifucave/moss-protocol";
import { dial as dialSocket, RpcCallError, type DaemonClient, type RequestHandler } from "./client";

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "starting-engine" }
  | { kind: "connected"; hello: MossHelloResult }
  /** MOSS is newer than the engine: served the release door only, until the engine brings MOSS's release in (§3.1). */
  | { kind: "ahead"; hello: MossHelloResult }
  | { kind: "reconnecting"; since: number }
  /** The engine is on another release: MOSS must update to `needs` before it connects (§3.1). */
  | { kind: "behind"; needs: string }
  /** The engine refused the `moss` surface (`SurfaceRefusal`): an older second copy, or a signature that isn't MOSS's. */
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "stopped" };

export interface EngineLauncher {
  start(): Promise<{ ok: boolean; code: number | null }>;
}

export interface ConnectionOptions {
  endpoint: string;
  /** The `app` token, read afresh for every dial (the engine mints a new one when it restarts); undefined: none yet. */
  token: () => string | undefined;
  /** This build's release (the `VERSION` file's), and the app's own version for its client name. */
  release: string;
  /** Prove the endpoint before the token goes out (every real run); the tests' fake engine proves too. */
  pid: number;
  launcher?: EngineLauncher;
  dial?: (endpoint: string) => Promise<DaemonClient | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  onConnected?: (client: DaemonClient, hello: MossHelloResult) => void | Promise<void>;
  /** The hello was served as `ahead` (the release door only): `onConnected` isn't called; this is, instead. */
  onAhead?: (client: DaemonClient, hello: MossHelloResult) => void | Promise<void>;
  onState?: (state: ConnectionState) => void;
  /** The engine asked MOSS to leave (`app.quit`): it is stopping, or bringing a newer release. */
  onEngineQuit?: (reason: "quit" | "update") => void;
}

export const TIMING = { reconnectMs: 500, maxBackoffMs: 5_000, kickAfterMs: 3_000, kickEveryMs: 5_000, helloTimeoutMs: 5_000 } as const;

/** The hello MOSS says (G1): the `app` role, the `moss` surface, its release. `features` names what MOSS answers. */
export function mossHello(token: string, release: string, protocolVersion: number): MossHelloParams {
  return { protocolVersion, role: "app", token, clientName: `MOSS ${release}`.slice(0, 128), surface: "moss", release, features: ["app.quit", "app.ping", "app.show"] };
}

/** The engine's proof that it holds the app token (lane C's `protocol.prove`): an HMAC over the nonce and the pid. */
export function engineProof(appToken: string, nonce: string, pid: number): string {
  return createHmac("sha256", appToken).update(`moss-daemon-proof\0${nonce}\0${pid}`).digest("base64url");
}

async function proveEngine(client: DaemonClient, token: string, pid: number): Promise<string | undefined> {
  const nonce = randomBytes(24).toString("base64url");
  let r: { proof?: unknown; pid?: unknown };
  try {
    r = await client.request<{ proof?: unknown; pid?: unknown }>("protocol.prove", { nonce }, TIMING.helloTimeoutMs);
  } catch (err) {
    return `it gave no proof (${err instanceof RpcCallError ? err.code : "error"})`;
  }
  if (r.pid !== pid) return "it sees another process at the other end";
  const want = Buffer.from(engineProof(token, nonce, pid));
  const got = Buffer.from(typeof r.proof === "string" ? r.proof : "");
  return got.length === want.length && timingSafeEqual(got, want) ? undefined : "its proof is wrong";
}

/** What a refused hello means for MOSS. */
export function helloRefusal(err: unknown): ConnectionState {
  if (err instanceof RpcCallError && err.code === MOSS_ERR.RELEASE_REFUSED) {
    const r = ReleaseRefusal.safeParse(err.data);
    if (r.success) return { kind: "behind", needs: r.data.needs };
  }
  if (err instanceof RpcCallError && err.code === MOSS_ERR.SURFACE_REFUSED) {
    const r = SurfaceRefusal.safeParse(err.data);
    const why = r.success ? r.data.reason : "refused";
    return { kind: "refused", reason: why === "older-copy" ? "A newer copy of MOSS is open." : why === "program-mismatch" ? "This copy of MOSS isn't signed as MOSS." : `The engine refused MOSS's window (${why}).` };
  }
  return { kind: "unavailable", reason: `The engine refused MOSS (${err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err)}).` };
}

export class EngineConnection {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private current: DaemonClient | undefined;
  private stateValue: ConnectionState = { kind: "connecting" };
  private stopped = false;
  /** Whether the last dial reached anything (an endpoint that answered, whatever it said). */
  private answered = false;
  loop: Promise<void> | undefined;
  kicks = 0;

  constructor(private readonly opts: ConnectionOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
    this.handlers.set("app.quit", (params) => {
      const reason = (params as { reason?: unknown } | undefined)?.reason === "update" ? "update" : "quit";
      this.stopped = true;
      setTimeout(() => this.opts.onEngineQuit?.(reason), 0);
      return { ok: true };
    });
    // The engine's heartbeat for every app hello (ruling R9): answered at once from the main process.
    this.handlers.set("app.ping", () => ({ ok: true }));
  }

  /** Whether the engine asked MOSS to leave (`app.quit`), or refused it for good. */
  get engineStopped(): boolean {
    return this.stopped;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  /** Lets a stopped connection dial again (a release switch's "Try again", or after the app was told it is behind and the
   *  person asks once more). Does nothing while it runs. */
  resume(): void {
    if (!this.stopped || this.current !== undefined) return;
    this.stopped = false;
    void this.start();
  }

  get client(): DaemonClient | undefined {
    return this.current !== undefined && !this.current.isClosed ? this.current : undefined;
  }

  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
    this.current?.handle(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    const off = this.current?.onNotification(listener);
    return () => {
      this.listeners.delete(listener);
      off?.();
    };
  }

  private setState(state: ConnectionState): void {
    const same = JSON.stringify(state) === JSON.stringify(this.stateValue);
    this.stateValue = state;
    if (!same) this.opts.onState?.(state);
  }

  /** One dial, hello and setup; true when connected. Never throws. */
  private async connectOnce(): Promise<boolean> {
    let client: DaemonClient | undefined;
    try {
      client = await (this.opts.dial ?? dialSocket)(this.opts.endpoint);
    } catch {
      client = undefined;
    }
    this.answered = client !== undefined;
    if (client === undefined) return false;
    if (this.stopped) {
      client.close();
      return false;
    }
    const token = this.opts.token();
    if (token === undefined) {
      client.close();
      this.setState({ kind: "unavailable", reason: "The engine has no token for MOSS yet." });
      return false;
    }
    const why = await proveEngine(client, token, this.opts.pid);
    if (why !== undefined) {
      client.close();
      this.log(`connection: the endpoint isn't this user's engine (${why}); MOSS sent it nothing`);
      this.setState({ kind: "unavailable", reason: "MOSS can't verify the engine." });
      return false;
    }
    client.onListenerError = (what, err) => this.log(`connection: a listener for ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const [method, handler] of this.handlers) client.handle(method, handler);
    for (const l of this.listeners) client.onNotification(l);
    let hello: MossHelloResult;
    try {
      hello = await client.request<MossHelloResult>("protocol.hello", mossHello(token, this.opts.release, MOSS_PROTOCOL_VERSION), TIMING.helloTimeoutMs);
    } catch (err) {
      client.close();
      const state = helloRefusal(err);
      this.log(`connection: the engine refused the hello (${state.kind === "behind" ? `behind, needs ${state.needs}` : state.kind === "refused" || state.kind === "unavailable" ? state.reason : state.kind})`);
      this.setState(state);
      // A release behind the engine's, or a refused surface, isn't fixed by dialling again.
      if (state.kind === "behind" || state.kind === "refused") this.stopped = true;
      return false;
    }
    if (this.stopped) {
      client.close();
      return false;
    }
    this.current = client;
    client.onClose(() => this.lost(client));
    if (hello.release?.standing === "ahead") {
      this.log(`connection: MOSS is ahead of the engine (${hello.release.engine}); only the release door is open`);
      this.setState({ kind: "ahead", hello });
      try {
        await this.opts.onAhead?.(client, hello);
      } catch (err) {
        this.log(`connection: the release door failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    this.log(`connection: connected as surface ${hello.surface ?? "?"} (mount: ${hello.mount?.points.length ?? "?"} points)`);
    this.setState({ kind: "connected", hello });
    try {
      await this.opts.onConnected?.(client, hello);
    } catch (err) {
      this.log(`connection: setting up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  private async kick(why: string): Promise<void> {
    if (this.opts.launcher === undefined || this.stopped) return;
    this.kicks++;
    const r = await this.opts.launcher.start();
    this.log(`connection: started the engine through the OS (${why}): ${r.ok ? "ok" : `failed, ${r.code}`}`);
  }

  /** Connects, starting the engine when none answers; resolves once connected or handed to the redial loop. */
  async start(): Promise<void> {
    this.setState({ kind: "connecting" });
    if (await this.connectOnce()) return;
    if (this.stopped) return;
    if (!this.answered && this.opts.launcher !== undefined) {
      this.setState({ kind: "starting-engine" });
      await this.kick("none answered at start");
    }
    this.loop = this.redial(this.now());
  }

  private lost(client: DaemonClient): void {
    if (client !== this.current) return;
    this.current = undefined;
    if (this.stopped) {
      this.setState({ kind: "stopped" });
      return;
    }
    this.log("connection: the engine went away without saying so");
    const since = this.now();
    this.setState({ kind: "reconnecting", since });
    this.loop = this.redial(since);
  }

  private async redial(since: number): Promise<void> {
    let gap: number = TIMING.reconnectMs;
    let quietSince: number | undefined;
    let lastKick: number | undefined;
    while (!this.stopped) {
      if (await this.connectOnce()) return;
      if (this.stopped) return;
      const now = this.now();
      if (this.answered) quietSince = undefined;
      else quietSince ??= now;
      if (quietSince !== undefined && now - quietSince >= TIMING.kickAfterMs && (lastKick === undefined || now - lastKick >= TIMING.kickEveryMs)) {
        lastKick = now;
        await this.kick(`nothing answers for ${now - quietSince} ms`);
      }
      await this.sleep(gap);
      if (now - since > 10_000) gap = Math.min(TIMING.maxBackoffMs, gap * 2);
    }
  }

  /** Stops dialling and closes the connection; the engine and its work go on (§3.1). */
  stop(): void {
    this.stopped = true;
    this.current?.close();
    this.current = undefined;
    this.setState({ kind: "stopped" });
  }
}

// -------------------------------------------------------------------------------------------------
// Where the engine and the token are
// -------------------------------------------------------------------------------------------------

export const ENGINE_BINARY_NAME = process.platform === "win32" ? "moss-core.exe" : "moss-core";

/** The engine binary MOSS carries: `MOSS_DAEMON_BIN` in a dev or unpackaged run, else the packaged app's own
 *  `<resources>/daemon/moss-core`; none in an unpackaged run without the override. */
export function locateEngine(input: { env: NodeJS.ProcessEnv; packaged: boolean; resourcesPath?: string }): string | undefined {
  const fromEnv = input.env.MOSS_DAEMON_BIN;
  if (!input.packaged && fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (!input.packaged || input.resourcesPath === undefined) return undefined;
  const bundled = join(input.resourcesPath, "daemon", ENGINE_BINARY_NAME);
  return existsSync(bundled) ? bundled : undefined;
}

/** Starts the engine through the OS with its own command (`moss-core autostart start`), never as MOSS's child. */
export function osLauncher(binary: string, home: string, profile: "dist" | "dev"): EngineLauncher {
  return {
    start: () => new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, MOSS_HOME: home, MOSS_PROFILE: profile };
      delete env.ELECTRON_RUN_AS_NODE;
      execFile(binary, ["autostart", "start"], { env, timeout: 15_000, windowsHide: true }, (err) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : null;
        resolve({ ok: err === null, code });
      });
    }),
  };
}

/** The `app` token: `MOSS_APP_TOKEN` in a dev or unpackaged run, else the engine's `<home>/run/app.token`. */
export function tokenPath(home: string): string {
  return join(home, "run", "app.token");
}
