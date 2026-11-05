// The app's side of the always-on pair (spec §3.1, "The pair, precisely"), measured in lane L's spike S7 §5:
//
//   * At start the app dials the daemon. If none answers, it makes sure the login item is registered and starts the
//     daemon through the OS (`clover-core login start`, never as its own child), then waits for it.
//   * When the daemon goes away without saying so (a crash), the app keeps its windows, redials every 500 ms, and if
//     the OS (launchd, systemd, the Windows supervisor) hasn't brought the daemon back within 3 s, starts it itself;
//     after that it asks the OS again every 30 s while the daemon stays down. Its windows stay as they are, and the
//     runtime rebuilds from the core's state when the daemon is back.
//   * A side that exits on purpose tells the other first: the daemon asks the app to quit (`app.quit`), and the app
//     says `pair.exiting` before it leaves for an update or a restart. Quit itself is `pair.quit` (quit.ts).
//
// Pure apart from the injected dial, launcher and clock, so the tests drive it against a fake daemon under Bun.
import { APP_METHODS, type CloverHelloParams, type CloverHelloResult } from "@waifucave/clover-protocol";
import { dial as dialSocket, RpcCallError, type DaemonClient, type RequestHandler } from "../protocol/client";
import type { DaemonLauncher } from "./login";

export type PairState =
  | { kind: "connecting" }
  | { kind: "starting-daemon" }
  | { kind: "connected"; hello: CloverHelloResult }
  | { kind: "reconnecting"; since: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "quitting" }
  | { kind: "stopped" };

export interface PairTiming {
  /** How long a first start waits for the daemon it started. */
  firstStartWaitMs: number;
  /** How often it dials while waiting for a daemon it started. */
  pollMs: number;
  /** How often it redials after losing the daemon. */
  reconnectMs: number;
  /** How long it gives the OS to restart a crashed daemon before starting it itself. */
  kickAfterMs: number;
  /** How often it asks the OS again while the daemon stays down. */
  kickEveryMs: number;
  /** The longest gap between dials once the daemon has been down a while. */
  maxBackoffMs: number;
  /** How long a hello may take. */
  helloTimeoutMs: number;
}

export const PAIR_TIMING: PairTiming = {
  firstStartWaitMs: 30_000,
  pollMs: 300,
  reconnectMs: 500,
  kickAfterMs: 3_000,
  kickEveryMs: 30_000,
  maxBackoffMs: 5_000,
  helloTimeoutMs: 5_000,
};

export interface PairOptions {
  endpoint: string;
  /** The hello's params, read afresh for every connection (the token can change when the daemon restarts);
   *  undefined when the app has no token yet. */
  hello: () => HelloParamsOrUndefined;
  /** How to install and start the daemon; undefined when the app has no daemon binary (the unpackaged dev app). */
  launcher?: DaemonLauncher;
  dial?: (endpoint: string) => Promise<DaemonClient | undefined>;
  timing?: Partial<PairTiming>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Each new connection, after its hello: the runtime fetches the registry and the user's choices, subscribes. */
  onConnected?: (client: DaemonClient, hello: CloverHelloResult) => void | Promise<void>;
  onState?: (state: PairState) => void;
  /** The daemon asked the app to quit (`app.quit`): the pair is stopping, for a Quit elsewhere or an update. */
  onDaemonQuit?: (reason: "quit" | "update") => void;
}

type HelloParamsOrUndefined = CloverHelloParams | undefined | Promise<CloverHelloParams | undefined>;

export class Pair {
  private readonly timing: PairTiming;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private current: DaemonClient | undefined;
  private stateValue: PairState = { kind: "connecting" };
  private leaving = false;
  private stopped = false;
  private loop: Promise<void> | undefined;
  /** How many times the app started the daemon itself (for the log and the tests). */
  kicks = 0;

  constructor(private readonly opts: PairOptions) {
    this.timing = { ...PAIR_TIMING, ...opts.timing };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
    this.handlers.set("app.quit", (params) => {
      const parsed = APP_METHODS.appQuit.params.safeParse(params);
      if (!parsed.success) throw new Error("app.quit needs a reason: quit or update");
      const reason = parsed.data.reason;
      this.leaving = true;
      this.setState({ kind: "quitting" });
      // Answer first, then leave: the daemon waits for the answer before it stops.
      setTimeout(() => this.opts.onDaemonQuit?.(reason), 0);
      return { ok: true };
    });
  }

  get state(): PairState {
    return this.stateValue;
  }

  get client(): DaemonClient | undefined {
    return this.current !== undefined && !this.current.isClosed ? this.current : undefined;
  }

  /** Answers the daemon's requests for a method, on this connection and every later one. */
  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
    this.current?.handle(method, handler);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    const off = this.current?.onNotification(listener);
    return () => {
      this.notificationListeners.delete(listener);
      off?.();
    };
  }

  private setState(state: PairState): void {
    this.stateValue = state;
    this.opts.onState?.(state);
  }

  /** Why the last dial didn't connect, when a daemon did answer: it refused the app, or the app had no token. */
  private refusal: string | undefined;

  /** Dials once and says hello; true when connected. */
  private async connectOnce(): Promise<boolean> {
    const client = await (this.opts.dial ?? dialSocket)(this.opts.endpoint);
    this.refusal = undefined;
    if (client === undefined) return false;
    const params = await this.opts.hello();
    if (params === undefined) {
      client.close();
      this.refusal = "the app has no token for the daemon yet";
      this.setState({ kind: "unavailable", reason: this.refusal });
      return false;
    }
    client.onListenerError = (what, err) => this.log(`pair: a listener for ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const [method, handler] of this.handlers) client.handle(method, handler);
    for (const l of this.notificationListeners) client.onNotification(l);
    let hello: CloverHelloResult;
    try {
      hello = await client.request<CloverHelloResult>("protocol.hello", params, this.timing.helloTimeoutMs);
    } catch (err) {
      client.close();
      const why = err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err);
      this.log(`pair: the daemon refused the hello (${why})`);
      this.refusal = `the daemon refused the app (${why})`;
      this.setState({ kind: "unavailable", reason: this.refusal });
      return false;
    }
    if (this.stopped) {
      client.close();
      return false;
    }
    this.current = client;
    client.onClose(() => this.lost(client));
    this.setState({ kind: "connected", hello });
    try {
      await this.opts.onConnected?.(client, hello);
    } catch (err) {
      this.log(`pair: setting up the connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  private async kick(why: string): Promise<void> {
    if (this.opts.launcher === undefined) return;
    this.kicks++;
    const r = await this.opts.launcher.start();
    this.log(`pair: started the daemon through the OS (${why}): ${r.ok ? "ok" : `failed, ${r.code}`}`);
  }

  /** Connects, starting the daemon through the OS when none answers. Resolves once connected or given up for now
   *  (it then keeps trying in the background). */
  async start(): Promise<void> {
    this.setState({ kind: "connecting" });
    if (await this.connectOnce()) return;
    if (this.stopped) return;
    if (this.refusal !== undefined) {
      // A daemon answered and refused: starting another would change nothing. Keep dialling, since a restarted
      // daemon writes a new token.
      this.loop = this.redial(this.now(), false);
      return;
    }
    const launcher = this.opts.launcher;
    if (launcher !== undefined) {
      this.setState({ kind: "starting-daemon" });
      const status = await launcher.status();
      if (status === undefined || !status.registered) {
        const r = await launcher.enable();
        this.log(`pair: registered the daemon's login item: ${r.ok ? "ok" : `failed, ${r.code}`}`);
      }
      await this.kick("none answered at start");
      const until = this.now() + this.timing.firstStartWaitMs;
      while (!this.stopped && this.now() < until) {
        await this.sleep(this.timing.pollMs);
        if (await this.connectOnce()) return;
      }
    }
    if (this.stopped) return;
    this.setState({ kind: "unavailable", reason: launcher === undefined ? "no daemon answers, and this app has no daemon to start" : "the daemon did not start" });
    this.loop = this.redial(this.now());
  }

  private lost(client: DaemonClient): void {
    if (client !== this.current) return;
    this.current = undefined;
    if (this.leaving || this.stopped) {
      this.setState({ kind: "stopped" });
      return;
    }
    this.log("pair: the daemon went away without saying so");
    const since = this.now();
    this.setState({ kind: "reconnecting", since });
    this.loop = this.redial(since);
  }

  /** Redials until connected: every `reconnectMs` at first, slowing to `maxBackoffMs`; starts the daemon itself
   *  after `kickAfterMs`, then every `kickEveryMs`. */
  private async redial(since: number, kicks = true): Promise<void> {
    let lastKick: number | undefined;
    let gap = this.timing.reconnectMs;
    while (!this.stopped && !this.leaving) {
      if (await this.connectOnce()) return;
      const down = this.now() - since;
      const kickDue = lastKick === undefined ? down >= this.timing.kickAfterMs : this.now() - lastKick >= this.timing.kickEveryMs;
      if (kicks && this.refusal === undefined && kickDue && this.opts.launcher !== undefined) {
        lastKick = this.now();
        await this.kick(`down for ${down} ms`);
      }
      await this.sleep(gap);
      if (down > 10_000) gap = Math.min(this.timing.maxBackoffMs, gap * 2);
    }
  }

  /** The app leaves on purpose (an update, a restart into safe mode): it tells the daemon first, so the daemon
   *  doesn't restart it (§3.1). */
  async exiting(reason: "quit" | "update" | "restart"): Promise<void> {
    this.leaving = true;
    this.setState({ kind: "quitting" });
    const client = this.client;
    if (client === undefined) return;
    try {
      await client.request("pair.exiting", { reason }, 3_000);
    } catch (err) {
      this.log(`pair: pair.exiting was not answered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Quit: stops both, releasing the lease first with `handOver` (§3.1, §6.4). True when the daemon took it. */
  async quit(handOver: boolean): Promise<boolean> {
    const client = this.client;
    this.leaving = true;
    this.setState({ kind: "quitting" });
    if (client === undefined) return false;
    try {
      await client.request("pair.quit", { handOver }, 10_000);
      return true;
    } catch (err) {
      this.log(`pair: pair.quit failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Stops every loop and closes the connection. */
  stop(): void {
    this.stopped = true;
    this.leaving = true;
    this.current?.close();
    this.current = undefined;
    this.setState({ kind: "stopped" });
  }

  /** For the tests: the background loop, if one runs. */
  get background(): Promise<void> | undefined {
    return this.loop;
  }
}
