// The app's side of the always-on pair (spec §3.1, "The pair, precisely"), measured in lane L's spike S7 §5:
//
//   * At start the app dials the daemon. If none answers, it makes sure the login item is registered and starts the
//     daemon through the OS (`clover-core login start`, never as its own child), then waits for it.
//   * When the daemon goes away without saying so (a crash), the app keeps its windows, redials every 500 ms, and if
//     the OS (launchd, systemd, the Windows supervisor) hasn't brought the daemon back within 3 s, starts it itself;
//     after that it asks the OS again every 5 s for a minute, then every 30 s, while nothing answers. Its windows stay
//     as they are, and the runtime rebuilds from the core's state when the daemon is back.
//   * Whatever answered and wouldn't pair (a daemon that is stopping, one with no token yet, one that didn't prove
//     itself in time) is never an end: the app keeps dialling, and once NOTHING answers for `kickAfterMs` it starts
//     the daemon through the OS, as on a cold start (try 9's reopen: a stopping daemon timed the proof out, then
//     answered "no token" while it went, and the app dialled on in silence with nobody to start a new one). After
//     `stuckAfterMs` with no daemon it says so (`stuck`), and keeps trying.
//   * A quit that comes while the app is still starting cancels the start: no daemon is started for an app leaving.
//   * A side that exits on purpose tells the other first: the daemon asks the app to quit (`app.quit`), and the app
//     says `pair.exiting` before it leaves for an update or a restart. Quit itself is `pair.quit` (quit.ts).
//
// Pure apart from the injected dial, launcher and clock, so the tests drive it against a fake daemon under Bun.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CLOVER_ERR, APP_METHODS, type CloverHelloParams, type CloverHelloResult } from "@waifucave/clover-protocol";
import { dial as dialSocket, RpcCallError, type DaemonClient, type RequestHandler } from "../protocol/client";
import type { DaemonLauncher } from "./login";

export type PairState =
  | { kind: "connecting" }
  | { kind: "starting-daemon" }
  | { kind: "connected"; hello: CloverHelloResult }
  | { kind: "reconnecting"; since: number }
  | { kind: "unavailable"; reason: string }
  | { kind: "unverified"; reason: string }
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
  /** How often it asks the OS again in the first minute while nothing answers (a daemon still going away holds the
   *  OS's job until it has gone: the next ask after that starts the new one). */
  kickRetryMs: number;
  /** How long without a daemon before the window says Clover can't start (and what to do); the app keeps trying. */
  stuckAfterMs: number;
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
  kickRetryMs: 5_000,
  stuckAfterMs: 60_000,
  helloTimeoutMs: 5_000,
};

/** What the window says when the app has had no daemon for `stuckAfterMs` (it keeps trying meanwhile). */
export const STUCK_REASON = "Clover's background service hasn't started. Clover keeps trying; if this stays, quit Clover and open it again, or restart the computer.";

export interface PairOptions {
  endpoint: string;
  /** The hello's params, read afresh for every connection (the token can change when the daemon restarts);
   *  undefined when the app has no token yet. */
  hello: () => HelloParamsOrUndefined;
  /** How to install and start the daemon; undefined when the app has no daemon binary (the unpackaged dev app). */
  launcher?: DaemonLauncher;
  /** Lane C's `protocol.prove` before the hello, on the same connection: the daemon answers the app's nonce with an
   *  HMAC under the app's token over the nonce and the pid it sees at the other end, which must be this process. A
   *  daemon that can't prove it holds the token, or that sees another process, gets nothing (no token): on Windows a
   *  pipe's name is in a namespace every user shares, and elsewhere it costs one round trip. */
  prove?: { pid: number };
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

/** Lane C's `proveDaemon`: an HMAC under the app's token over the nonce and the pid the daemon sees. */
export function daemonProof(appToken: string, nonce: string, pid: number): string {
  return createHmac("sha256", appToken).update(`clover-daemon-proof\0${nonce}\0${pid}`).digest("base64url");
}

/** Asks the endpoint to prove it is this user's daemon (`protocol.prove`); undefined when it did. On failure:
 *  `why` for the log and the state, and `refused` when the endpoint refused the call itself — lane C's daemon answers
 *  that way when the pid at its end is ambiguous (on Windows, a pipe's peer pid it couldn't read); a proof that is
 *  wrong, or that names another process, is conclusive instead. */
export async function proveServer(client: Pick<DaemonClient, "request">, appToken: string, pid: number, timeoutMs: number): Promise<{ why: string; refused: boolean } | undefined> {
  const nonce = randomBytes(24).toString("base64url");
  let r: { proof?: unknown; pid?: unknown };
  try {
    r = await client.request<{ proof?: unknown; pid?: unknown }>("protocol.prove", { nonce }, timeoutMs);
  } catch (err) {
    // Lane C's refusal for the ambiguous pid (Windows) is its own code; a method that doesn't exist, a dead pipe or
    // anything else says the endpoint can't prove itself at all — said once, not retried.
    const refused = err instanceof RpcCallError && err.code === CLOVER_ERR.PROCESS_REFUSED;
    return { why: `it gave no proof: ${err instanceof RpcCallError ? `${err.code}: ${err.message}` : String(err)}`, refused };
  }
  if (r.pid !== pid) return { why: "it sees another process at the other end", refused: false };
  const want = Buffer.from(daemonProof(appToken, nonce, pid));
  const got = Buffer.from(typeof r.proof === "string" ? r.proof : "");
  return got.length === want.length && timingSafeEqual(got, want) ? undefined : { why: "its proof is wrong", refused: false };
}

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
  /** Whether the last dial reached anything at all (an endpoint that answered, whatever it said). */
  private answered = false;
  /** Set once the app has had no daemon for `stuckAfterMs` (the window says so); cleared when it connects. */
  private stuckReason: string | undefined;
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
    // The same refusal again (a dial that met it once more) is said once.
    const same = state.kind === "unavailable" && this.stateValue.kind === "unavailable" && state.reason === this.stateValue.reason;
    this.stateValue = state;
    if (same) return;
    this.opts.onState?.(state);
  }

  /** What the window says while the app has had no daemon for a long time; undefined otherwise. */
  get stuck(): string | undefined {
    return this.stuckReason;
  }

  private get gone(): boolean {
    return this.stopped || this.leaving;
  }

  /** Why the last dial didn't connect, when a daemon did answer: it refused the app, or the app had no token. */
  private refusal: string | undefined;
  /** Prove calls in a row whose endpoint refused to prove at all (lane C's ambiguous-pid case among them): after this
   *  many the app says it can't verify the daemon, and never connects unverified whatever the count reaches. */
  private proveRefusals = 0;
  /** How many refusals bear the "can't verify" verdict before it is shown (a blip may resolve at the next dial). */
  static readonly PROVE_TRIES = 3;

  /** Dials once and says hello; true when connected. */
  private async connectOnce(): Promise<boolean> {
    const client = await (this.opts.dial ?? dialSocket)(this.opts.endpoint);
    this.refusal = undefined;
    this.answered = client !== undefined;
    if (client === undefined) return false;
    if (this.gone) {
      client.close();
      return false;
    }
    const params = await this.opts.hello();
    if (params === undefined) {
      client.close();
      this.refusal = "the app has no token for the daemon yet";
      this.setState({ kind: "unavailable", reason: this.refusal });
      return false;
    }
    if (this.opts.prove !== undefined) {
      const why = await proveServer(client, params.token, this.opts.prove.pid, this.timing.helloTimeoutMs);
      if (why !== undefined) {
        client.close();
        this.refusal = `the endpoint isn't this user's daemon (${why.why}); the app sent it nothing`;
        this.log(`pair: ${this.refusal}`);
        // A refused prove can resolve by itself (the pid ambiguity on Windows clears on a fresh connection): after a
        // few runs the app takes it for settled and says it can't verify the daemon, still never connecting
        // unverified, and keeps dialling in case the daemon it can prove is found later. The verdict lands after the
        // unavailable state, so the last state this caller sees is the verdict.
        this.setState({ kind: "unavailable", reason: this.refusal });
        if (why.refused) {
          this.proveRefusals++;
          if (this.proveRefusals >= Pair.PROVE_TRIES && this.stateValue.kind !== "unverified") {
            this.setState({ kind: "unverified", reason: "can't verify the Clover daemon" });
          }
        } else {
          this.proveRefusals = 0;
        }
        return false;
      }
      this.proveRefusals = 0;
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
    if (this.stuckReason !== undefined) this.log("pair: connected after the window said Clover can't start");
    this.stuckReason = undefined;
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
    // An app that is leaving (a quit while it was still starting) starts no daemon.
    if (this.gone) {
      this.log(`pair: not starting the daemon (${why}): the app is quitting`);
      return;
    }
    this.kicks++;
    const r = await this.opts.launcher.start();
    this.log(`pair: started the daemon through the OS (${why}): ${r.ok ? "ok" : `failed, ${r.code}`}`);
  }

  /** Connects, starting the daemon through the OS when none answers. Resolves once connected or given up for now
   *  (it then keeps trying in the background). */
  async start(): Promise<void> {
    const began = this.now();
    this.setState({ kind: "connecting" });
    if (await this.connectOnce()) return;
    if (this.gone) return;
    if (this.answered) {
      // Something answered and wouldn't pair (a daemon stopping, one with no token yet, one that didn't prove itself in
      // time): starting another now would change nothing. Keep dialling; once nothing answers, start one.
      this.loop = this.redial(began);
      return;
    }
    const launcher = this.opts.launcher;
    if (launcher !== undefined) {
      this.setState({ kind: "starting-daemon" });
      const status = await launcher.status();
      if (this.gone) return;
      if (status === undefined || !status.registered) {
        const r = await launcher.enable();
        this.log(`pair: registered the daemon's login item: ${r.ok ? "ok" : `failed, ${r.code}`}`);
      }
      await this.kick("none answered at start");
      let lastKick = this.now();
      const until = this.now() + this.timing.firstStartWaitMs;
      while (!this.gone && this.now() < until) {
        await this.sleep(this.timing.pollMs);
        if (await this.connectOnce()) return;
        // An ask while an old daemon still holds the OS's job starts nothing: ask again while nothing answers.
        if (!this.answered && this.now() - lastKick >= this.timing.kickRetryMs) {
          lastKick = this.now();
          await this.kick("still none answering");
        }
      }
    }
    if (this.gone) return;
    this.setState({ kind: "unavailable", reason: launcher === undefined ? "no daemon answers, and this app has no daemon to start" : "the daemon did not start" });
    this.loop = this.redial(began);
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

  /** Redials until connected: every `reconnectMs` at first, slowing to `maxBackoffMs`. Once NOTHING answers for
   *  `kickAfterMs` (an endpoint that answers and won't pair is waited out: a daemon going away), it starts the daemon
   *  through the OS, again every `kickRetryMs` while nothing answers in the first minute (the OS starts the new one
   *  only once the old one has gone), then every `kickEveryMs`. After `stuckAfterMs` without a daemon the window says
   *  so; the tries go on. Never ends but by connecting, a quit or a stop. */
  private async redial(since: number): Promise<void> {
    let lastKick: number | undefined;
    let quietSince: number | undefined;
    let gap = this.timing.reconnectMs;
    while (!this.gone) {
      if (await this.connectOnce()) return;
      if (this.gone) return;
      const now = this.now();
      if (this.answered) quietSince = undefined;
      else if (quietSince === undefined) {
        quietSince = now;
        gap = this.timing.reconnectMs;
      }
      const down = now - since;
      if (quietSince !== undefined && this.opts.launcher !== undefined) {
        const quiet = now - quietSince;
        const every = quiet < 60_000 ? this.timing.kickRetryMs : this.timing.kickEveryMs;
        const due = quiet >= this.timing.kickAfterMs && (lastKick === undefined || lastKick < quietSince || now - lastKick >= every);
        if (due) {
          lastKick = now;
          await this.kick(`nothing answers for ${quiet} ms (no daemon for ${down} ms)`);
        }
      }
      if (this.stuckReason === undefined && down >= this.timing.stuckAfterMs) {
        this.stuckReason = STUCK_REASON;
        this.log(`pair: no daemon for ${Math.round(down / 1000)} s: the window says Clover can't start; still trying`);
        this.setState({ kind: "unavailable", reason: STUCK_REASON });
      }
      await this.sleep(gap);
      if (down > 10_000) gap = Math.min(this.timing.maxBackoffMs, gap * 2);
    }
  }

  /** Releases the lease without leaving: the computer suspends (a laptop's sleep), so another computer takes the bots
   *  until this one wakes (§3.1, §6.4). The daemon takes it back through its own clock and heartbeat. */
  async handOver(): Promise<boolean> {
    const client = this.client;
    if (client === undefined) return false;
    try {
      await client.request("main.handOver", {}, 10_000);
      return true;
    } catch (err) {
      this.log(`pair: main.handOver failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** The app leaves on purpose (an update, a restart into safe mode): it tells the daemon first, so the daemon
   *  doesn't restart it (§3.1). */
  async exiting(reason: "quit" | "update" | "restart"): Promise<boolean> {
    const client = this.client;
    if (reason === "update") {
      // An update's exit (lane M): the daemon refuses it unless its update gate is closed and idle, and then the app
      // stays as it is (connected, not leaving) and asks again at the next idle moment.
      if (client === undefined) return false;
      try {
        await client.request("pair.exiting", { reason }, 3_000);
      } catch (err) {
        this.log(`pair: pair.exiting{update} refused or not answered: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      this.leaving = true;
      this.setState({ kind: "quitting" });
      return true;
    }
    this.leaving = true;
    this.setState({ kind: "quitting" });
    if (client === undefined) return false;
    try {
      await client.request("pair.exiting", { reason }, 3_000);
      return true;
    } catch (err) {
      this.log(`pair: pair.exiting was not answered: ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
