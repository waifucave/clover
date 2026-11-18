// The background host's watch on its engine (lane HV, host-runtime.ts `EngineWatch`): a host whose engine is gone for good
// leaves by itself after HOST_ENGINE_GONE_MS, with one line saying why; an engine back within the bound keeps it (and its
// new connection is set up again: the cards are listed to it there); a hello the engine refuses never counts. Driven on a
// fake clock, then on the real pair against a fake daemon (no launcher: the host never starts the engine).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MossHelloParams } from "@waifucave/moss-protocol";
import { EngineWatch, HOST_ENGINE_GONE_MS, engineGoneLine } from "../src/main/host-runtime";
import { hostHello } from "../src/main/host-program";
import { Pair, type PairState } from "../src/main/pair/pair";
import { readAppToken } from "../src/main/pair/start";
import { daemonEndpoint } from "../src/main/protocol/client";
import { startFakeDaemon, type FakeDaemon } from "./fake-core/fake-daemon";

/** A clock the test moves. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    after(ms: number, fn: () => void) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => { t.live = false; } };
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        now = next.at;
        next.live = false;
        next.fn();
      }
      now = until;
    },
  };
}

function watch(boundMs = 1_000) {
  const clock = fakeClock();
  const lines: string[] = [];
  let left = 0;
  const w = new EngineWatch({ boundMs, after: clock.after, leave: () => { left++; }, log: (l) => lines.push(l) });
  return { w, clock, lines, left: () => left };
}

describe("the host's watch on its engine, on a fake clock", () => {
  test("the bound is past the engine's own legitimate gaps: its restart, its adoption window and the host's redial", () => {
    // launchd's 1 s, the supervisor's 45 s adoption watchdog (HOST_START_TIMEOUT_MS), the pair's 5 s redial at most.
    expect(HOST_ENGINE_GONE_MS).toBeGreaterThan(1_000 + 45_000 + 5_000);
    expect(HOST_ENGINE_GONE_MS).toBe(120_000);
  });

  test("never connected (the engine went before the host's hello): it leaves at the bound, once, saying why", () => {
    const t = watch();
    t.w.connected(false);
    t.clock.advance(999);
    expect(t.left()).toBe(0);
    t.clock.advance(1);
    expect(t.left()).toBe(1);
    expect(t.lines).toEqual([engineGoneLine(1_000)]);
    expect(t.lines[0]).toContain("no engine for 1 s");
    // Nothing more: it left.
    t.w.connected(false);
    t.clock.advance(10_000);
    expect(t.left()).toBe(1);
  });

  test("the engine back within the bound keeps the host; the next loss starts the wait again from that loss", () => {
    const t = watch();
    t.w.connected(false);
    t.clock.advance(900);
    t.w.connected(true);
    t.clock.advance(5_000);
    expect(t.left()).toBe(0);
    t.w.connected(false);
    t.clock.advance(900);
    expect(t.left()).toBe(0);
    t.clock.advance(100);
    expect(t.left()).toBe(1);
  });

  test("repeated losses while down (a redial met by a refusal, then nothing) don't push the leave back", () => {
    const t = watch();
    t.w.connected(false);
    t.clock.advance(600);
    t.w.connected(false);
    t.clock.advance(400);
    expect(t.left()).toBe(1);
  });

  test("a host leaving anyway (a stop, a quit) leaves no timer behind", () => {
    const t = watch();
    t.w.connected(false);
    t.w.stop();
    t.clock.advance(10_000);
    expect(t.left()).toBe(0);
  });

  test("generated sequences: it leaves exactly when a down stretch reached the bound, and at most once", () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 300; run++) {
      const bound = 1_000;
      const t = watch(bound);
      let downSince: number | undefined;
      let now = 0;
      let shouldLeaveAt: number | undefined;
      t.w.connected(false);
      downSince = 0;
      for (let i = 0; i < 30 && shouldLeaveAt === undefined; i++) {
        const step = Math.floor(rand() * 700);
        // Before moving the clock: does the current down stretch reach the bound within this step?
        if (downSince !== undefined && now + step >= downSince + bound) { shouldLeaveAt = downSince + bound; }
        t.clock.advance(step);
        now += step;
        if (shouldLeaveAt !== undefined) break;
        const up = rand() < 0.5;
        t.w.connected(up);
        if (up) downSince = undefined; else downSince ??= now;
      }
      expect(t.left()).toBe(shouldLeaveAt === undefined ? 0 : 1);
      t.clock.advance(10_000);
      // Up at the end of the sequence keeps it; down leaves once more time passes, never twice.
      expect(t.left()).toBe(shouldLeaveAt !== undefined || downSince !== undefined ? 1 : 0);
    }
  });
});

const homes: string[] = [];
const fakes: FakeDaemon[] = [];
const pairs: Pair[] = [];
afterEach(async () => {
  for (const p of pairs.splice(0)) p.stop();
  for (const f of fakes.splice(0)) await f.close().catch(() => {});
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const FAST = { firstStartWaitMs: 3000, pollMs: 25, reconnectMs: 25, kickAfterMs: 300, kickEveryMs: 1000, maxBackoffMs: 50, helloTimeoutMs: 2000 };

/** The host's pair and its watch, as index.ts wires them: the state drives the watch; no launcher. */
function hostPair(home: string, boundMs: number) {
  const states: PairState["kind"][] = [];
  const lines: string[] = [];
  let left = 0;
  let connections = 0;
  const w = new EngineWatch({ boundMs, after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, leave: () => { left++; pair.stop(); }, log: (l) => lines.push(l) });
  const pair: Pair = new Pair({
    endpoint: daemonEndpoint(home),
    hello: (): MossHelloParams | undefined => { const token = readAppToken(home, {}); return token === undefined ? undefined : hostHello(token, "0.0.0-test", 1); },
    timing: FAST,
    onState: (s) => { states.push(s.kind); w.connected(s.kind === "connected" || s.kind === "ahead"); },
    // The host lists its cards here on every connection (index.ts `subscribeThenListCards`): counted.
    onConnected: () => { connections++; },
  });
  pairs.push(pair);
  return { pair, states, lines, left: () => left, connections: () => connections };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "moss-hv-"));
  homes.push(h);
  return h;
}

describe("the host's pair and its watch, against a fake engine", () => {
  test("the engine gone for good (its socket closed, as a SIGKILL closes it): the host leaves at the bound", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    const h = hostPair(home, 400);
    await h.pair.start();
    expect(h.pair.state.kind).toBe("connected");
    const at = Date.now();
    await fake.close();
    await until(() => h.left() === 1, 5_000);
    expect(Date.now() - at).toBeGreaterThanOrEqual(350);
    expect(h.lines).toEqual([engineGoneLine(400)]);
    expect(h.states).toContain("reconnecting");
  });

  test("the engine back within the bound: the host stays, and its new connection is set up again (its cards told again)", async () => {
    const home = tempHome();
    const first = await startFakeDaemon({ home });
    const h = hostPair(home, 1_500);
    await h.pair.start();
    expect(h.connections()).toBe(1);
    await first.close();
    await until(() => h.pair.state.kind === "reconnecting");
    await new Promise((r) => setTimeout(r, 300));
    const second = await startFakeDaemon({ home });
    fakes.push(second);
    await until(() => h.connections() === 2, 3_000);
    await new Promise((r) => setTimeout(r, 1_800));
    expect(h.left()).toBe(0);
    expect(h.pair.state.kind).toBe("connected");
  });

  test("an engine that refuses the host's hello (a second host on the home) never counts: the host leaves at the bound", async () => {
    const home = tempHome();
    // Another token than the one the home holds: every hello is refused, as the engine refuses a second host.
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const refusing = tempHome();
    const other = await startFakeDaemon({ home: refusing, token: "not-this-hosts-token" });
    fakes.push(other);
    const states: PairState["kind"][] = [];
    let left = 0;
    const w = new EngineWatch({ boundMs: 400, after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, leave: () => { left++; }, log: () => {} });
    // The host's endpoint is the refusing engine's; its token is the other home's.
    const pair = new Pair({
      endpoint: daemonEndpoint(refusing),
      hello: (): MossHelloParams | undefined => { const token = readAppToken(home, {}); return token === undefined ? undefined : hostHello(token, "0.0.0-test", 1); },
      timing: FAST,
      onState: (s) => { states.push(s.kind); w.connected(s.kind === "connected" || s.kind === "ahead"); },
    });
    pairs.push(pair);
    void pair.start();
    await until(() => left === 1, 5_000);
    expect(states).not.toContain("connected");
  });
});
