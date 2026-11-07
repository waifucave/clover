// Two computers for the agent suite (K-M3, remote.ts): Studio runs the bot "alpha", Laptop runs the agents it places
// there, joined by lane B's fake link, each with a test fence over its own view of the lease and Studio with a pause
// switch. `make` registers the pair for `closePair` (the suite's afterEach).
import type { FencingToken, FenceVerdict } from "@waifucave/clover-protocol";
import { FakeLinkNetwork } from "../../contracts/fakes/link-transport";
import type { Clock } from "../../contracts/clock";
import type { LinkTransport } from "../../contracts/link-transport";
import type { LinkView } from "@waifucave/clover-protocol";
import type { AgentPauseGate } from "../manager";
import { AgentPeers, type AgentActFence } from "../remote";
import { World, type WorldOptions } from "./world";

export const STUDIO = "dev-studio";
export const LAPTOP = "dev-laptop";
export const OTHER = "dev-other";

/** A computer's view of the group's lease, and #237's guard over it, simplified: a token must match the view. */
export class TestFence implements AgentActFence {
  view: FencingToken = { scope: "acct_1", epoch: 3, holder: STUDIO };
  token(): FencingToken | undefined {
    return { ...this.view };
  }
  check(t: FencingToken | undefined): FenceVerdict {
    if (!t) return "missing";
    return t.scope === this.view.scope && t.epoch === this.view.epoch && t.holder === this.view.holder ? "ok" : "stale";
  }
}

export class Switch implements AgentPauseGate {
  paused = false;
  readonly #fns = new Set<() => void>();
  mayAct(): boolean {
    return !this.paused;
  }
  watch(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }
  set(paused: boolean): void {
    this.paused = paused;
    for (const fn of this.#fns) fn();
  }
}

export interface Pair {
  net: FakeLinkNetwork;
  a: World;
  b: World;
  peersA: AgentPeers;
  peersB: AgentPeers;
  fenceA: TestFence;
  fenceB: TestFence;
  pauseA: Switch;
}

let pair: Pair | undefined;
export async function closePair(): Promise<void> {
  if (!pair) return;
  const p = pair;
  pair = undefined;
  await p.a.close();
  p.peersA.close();
  p.peersB.close();
  await p.b.manager.close();
  await p.b.close();
}

/** Laptop's transport with its link watch held back on demand: what the transport says about a link while its watch
 *  hasn't told the watchers yet. */
export class HeldWatch {
  held = false;
  readonly #queued: LinkView[] = [];
  readonly #fns = new Set<(v: LinkView) => void>();
  wrap(t: LinkTransport): LinkTransport {
    t.watch((v) => {
      if (this.held) this.#queued.push(v);
      else for (const fn of this.#fns) fn(v);
    });
    return new Proxy(t, {
      get: (target, prop, recv) => {
        if (prop === "watch") return (fn: (v: LinkView) => void) => { this.#fns.add(fn); return () => this.#fns.delete(fn); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
  release(): void {
    this.held = false;
    for (const v of this.#queued.splice(0)) for (const fn of this.#fns) fn(v);
  }
}

export function make(o: { a?: WorldOptions; b?: WorldOptions; graceMs?: number; graceMsB?: number; outboxBytes?: number; heldWatchB?: HeldWatch; heldWatchA?: HeldWatch; resyncBaseMs?: number; netClock?: Clock; wrapA?: (t: LinkTransport) => LinkTransport } = {}): Pair {
  const net = new FakeLinkNetwork(o.netClock ? { clock: o.netClock } : {});
  const wrapA = o.wrapA ?? ((t: LinkTransport) => t);
  const a = new World({ ...o.a, computer: "Studio", otherComputers: { Laptop: "/nonexistent/laptop" } });
  const b = new World({ ...o.b, computer: "Laptop", otherComputers: { Studio: a.userHome } });
  const fenceA = new TestFence();
  const fenceB = new TestFence();
  const pauseA = new Switch();
  const devices: Record<string, string> = { Studio: STUDIO, Laptop: LAPTOP };
  const computer = (name: string) => (devices[name] ? { device: devices[name]!, online: true } : undefined);
  const mayCall = (d: string) => d === STUDIO || d === LAPTOP || d === OTHER;
  const peersA = new AgentPeers(a.manager, {
    transport: wrapA(o.heldWatchA ? o.heldWatchA.wrap(net.endpoint(STUDIO)) : net.endpoint(STUDIO)), computer, mayCall, fence: fenceA, pause: pauseA, clock: a.clock, home: a.cloverHome,
    ...(o.graceMs ? { linkGraceMs: o.graceMs } : {}),
  });
  const peersB = new AgentPeers(b.manager, {
    transport: o.heldWatchB ? o.heldWatchB.wrap(net.endpoint(LAPTOP)) : net.endpoint(LAPTOP), computer, mayCall, fence: fenceB, clock: b.clock, home: b.cloverHome,
    ...(o.graceMsB ? { linkGraceMs: o.graceMsB } : {}), ...(o.outboxBytes ? { outboxBytes: o.outboxBytes } : {}),
    ...(o.resyncBaseMs ? { resyncBaseMs: o.resyncBaseMs } : {}),
  });
  pair = { net, a, b, peersA, peersB, fenceA, fenceB, pauseA };
  return pair;
}

export type Notification = { from: "task-notification"; agent: string; backend: string; stopReason: string; text: string; transcript: string };
export const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as Notification | undefined;

export const delegate = (p: Pair, extra: { root?: string; backend?: string; level?: "read-only" | "ask" | "ask-risky" | "accept-edits" | "automatic" } = {}) =>
  p.a.manager.start({
    caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user", ...(extra.level ? { level: extra.level } : {}) },
    backend: extra.backend ?? "fake", prompt: "Fix the tests.", root: extra.root ?? "home/Laptop/project1", title: "Fix the tests", computer: "Laptop",
  });

export const blockedOn = (w: World, on: string) => w.report("blocked").some((r) => r["on"] === on);
/** Wakes the scripted agent from its `wait` step. */
export const proceed = (w: World) => process.kill(Number(w.report("started")[0]!["pid"]), "SIGUSR2");

