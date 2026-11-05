// The app's side of the pair against a fake daemon (lane C's side lands in C-M1): starting the daemon through the OS
// when none answers, coming back after a crash (the OS first, the app after 3 s), Quit and Hand over and quit, the
// daemon's own quit, the token, how the app was started, and Quit's question.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloverHelloParams } from "@waifucave/clover-protocol";
import { daemonEndpoint } from "../src/main/protocol/client";
import type { DaemonLauncher } from "../src/main/pair/login";
import { Pair, type PairState } from "../src/main/pair/pair";
import { quitQuestion } from "../src/main/pair/quit";
import { appHello, readAppToken, readStartInfo, startFilePath } from "../src/main/pair/start";
import { readCalls, startFakeDaemon, type FakeDaemon } from "./fake-core/fake-daemon";

const homes: string[] = [];
const fakes: FakeDaemon[] = [];
const pairs: Pair[] = [];
function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "clover-pair-"));
  homes.push(h);
  return h;
}
afterEach(async () => {
  for (const p of pairs.splice(0)) p.stop();
  for (const f of fakes.splice(0)) await f.close().catch(() => {});
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const FAST = { firstStartWaitMs: 3000, pollMs: 25, reconnectMs: 25, kickAfterMs: 300, kickEveryMs: 1000, maxBackoffMs: 100, helloTimeoutMs: 2000 };

/** A launcher whose "OS" starts the fake daemon in this process. */
function fakeLauncher(home: string, opts: { startDelayMs?: number } = {}): DaemonLauncher & { started: number; enabled: number } {
  let registered = false;
  const l = {
    started: 0,
    enabled: 0,
    async status() {
      return { registered };
    },
    async enable() {
      registered = true;
      l.enabled++;
      return { ok: true, code: 0, out: "" };
    },
    async start() {
      l.started++;
      setTimeout(() => void startFakeDaemon({ home }).then((f) => fakes.push(f)).catch(() => {}), opts.startDelayMs ?? 0);
      return { ok: true, code: 0, out: "" };
    },
  };
  return l;
}

function pairFor(home: string, launcher: DaemonLauncher | undefined, extra: { onDaemonQuit?: (r: string) => void } = {}): { pair: Pair; states: PairState["kind"][] } {
  const states: PairState["kind"][] = [];
  const pair = new Pair({
    endpoint: daemonEndpoint(home),
    hello: (): CloverHelloParams | undefined => {
      const token = readAppToken(home, {});
      return token === undefined ? undefined : appHello(token, "0.0.0-test", 1);
    },
    ...(launcher ? { launcher } : {}),
    timing: FAST,
    onState: (s) => states.push(s.kind),
    ...(extra.onDaemonQuit ? { onDaemonQuit: extra.onDaemonQuit } : {}),
  });
  pairs.push(pair);
  return { pair, states };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("starting", () => {
  test("a running daemon: the app connects and says hello as `app`, starting nothing", async () => {
    const home = tempHome();
    fakes.push(await startFakeDaemon({ home }));
    const launcher = fakeLauncher(home);
    const { pair } = pairFor(home, launcher);
    await pair.start();
    expect(pair.state.kind).toBe("connected");
    expect(launcher.started).toBe(0);
    expect(readCalls(home).find((c) => c.event === "request" && c.method === "protocol.hello")).toMatchObject({ role: "app" });
  });

  test("no daemon: the app registers the login item, starts the daemon through the OS and waits for it", async () => {
    const home = tempHome();
    const launcher = fakeLauncher(home, { startDelayMs: 150 });
    const { pair, states } = pairFor(home, launcher);
    await pair.start();
    expect(pair.state.kind).toBe("connected");
    expect(launcher.enabled).toBe(1);
    expect(launcher.started).toBe(1);
    expect(states).toEqual(["connecting", "starting-daemon", "connected"]);
  });

  test("no daemon and nothing to start it with: unavailable, and it keeps dialling", async () => {
    const home = tempHome();
    const { pair } = pairFor(home, undefined);
    await pair.start();
    expect(pair.state).toMatchObject({ kind: "unavailable" });
    fakes.push(await startFakeDaemon({ home }));
    await until(() => pair.state.kind === "connected");
  });

  test("a wrong token: refused, with the reason, and no connection kept", async () => {
    const home = tempHome();
    fakes.push(await startFakeDaemon({ home }));
    const pair = new Pair({ endpoint: daemonEndpoint(home), hello: () => appHello("not-the-token", "0", 1), timing: FAST });
    pairs.push(pair);
    await pair.start();
    expect(pair.state.kind).toBe("unavailable");
    expect(pair.state.kind === "unavailable" && pair.state.reason).toContain("refused");
  });
});

describe("crashes", () => {
  test("the OS restarts a crashed daemon within 3 s: the app reconnects without starting it", async () => {
    const home = tempHome();
    const first = await startFakeDaemon({ home });
    fakes.push(first);
    const launcher = fakeLauncher(home);
    const { pair, states } = pairFor(home, launcher);
    await pair.start();
    await first.crash();
    await until(() => pair.state.kind === "reconnecting");
    fakes.push(await startFakeDaemon({ home }));
    await until(() => pair.state.kind === "connected");
    expect(launcher.started).toBe(0);
    expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);
  });

  test("when the OS doesn't, the app starts the daemon itself after the wait, and reconnects", async () => {
    const home = tempHome();
    const first = await startFakeDaemon({ home });
    fakes.push(first);
    const launcher = fakeLauncher(home);
    const { pair } = pairFor(home, launcher);
    await pair.start();
    const lostAt = Date.now();
    await first.crash();
    await until(() => launcher.started === 1);
    expect(Date.now() - lostAt).toBeGreaterThanOrEqual(FAST.kickAfterMs - 50);
    await until(() => pair.state.kind === "connected");
    expect(pair.kicks).toBe(1);
  });
});

describe("quitting", () => {
  test("Quit: pair.quit, and the daemon's close afterwards is not a crash", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const launcher = fakeLauncher(home);
    const { pair } = pairFor(home, launcher);
    await pair.start();
    expect(await pair.quit(false)).toBe(true);
    expect(await fake.quitRequested).toEqual({ handOver: false });
    await fake.crash();
    await until(() => pair.state.kind === "stopped");
    await new Promise((r) => setTimeout(r, FAST.kickAfterMs + 100));
    expect(launcher.started).toBe(0);
  });

  test("Hand over and quit asks the daemon to release the lease first", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home, status: { bots: ["alpha"], canHandOver: true } });
    fakes.push(fake);
    const { pair } = pairFor(home, fakeLauncher(home));
    await pair.start();
    const status = await pair.client!.request("pair.status");
    expect(quitQuestion(status as never).buttons.map((b) => b.id)).toEqual(["handover", "quit", "cancel"]);
    await pair.quit(true);
    expect(await fake.quitRequested).toEqual({ handOver: true });
  });

  test("the daemon's own Quit (app.quit): the app is told, answers, and doesn't restart the daemon", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const launcher = fakeLauncher(home);
    let told: string | undefined;
    const { pair } = pairFor(home, launcher, { onDaemonQuit: (r) => (told = r) });
    await pair.start();
    await fake.quitApps("update");
    await until(() => told !== undefined);
    expect(told).toBe("update");
    await fake.crash();
    await until(() => pair.state.kind === "stopped");
    expect(launcher.started).toBe(0);
  });

  test("leaving on purpose says pair.exiting first", async () => {
    const home = tempHome();
    fakes.push(await startFakeDaemon({ home }));
    const { pair } = pairFor(home, fakeLauncher(home));
    await pair.start();
    await pair.exiting("restart");
    expect(readCalls(home).some((c) => c.method === "pair.exiting" && (c.params as { reason?: string }).reason === "restart")).toBe(true);
  });

  test("the daemon's app.show reaches the handler, on this connection and the next", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const seen: unknown[] = [];
    const { pair } = pairFor(home, fakeLauncher(home));
    pair.handle("app.show", (p) => {
      seen.push(p);
      return { ok: true };
    });
    await pair.start();
    expect(await fake.show({ kind: "window" })).toEqual({ ok: true });
    expect(seen).toEqual([{ what: { kind: "window" } }]);
  });
});

describe("Quit's question", () => {
  test("nothing running: no question", () => {
    expect(quitQuestion({ bots: [], routines: 0, agents: 0, canHandOver: true, safeMode: false }).ask).toBe(false);
    expect(quitQuestion(undefined).ask).toBe(false);
  });

  test("bots with another computer to take them: Hand over and quit first", () => {
    const q = quitQuestion({ bots: ["alpha", "luna"], routines: 2, agents: 1, canHandOver: true, safeMode: false });
    expect(q.ask).toBe(true);
    expect(q.detail).toContain("2 bots (alpha, luna), 2 routines and 1 agent");
    expect(q.detail).toContain("Hand over and quit");
    expect(q.buttons.map((b) => b.label)).toEqual(["Hand over and quit", "Quit", "Cancel"]);
  });

  test("with no other computer, it says the bots stay offline", () => {
    const q = quitQuestion({ bots: ["alpha"], routines: 0, agents: 0, canHandOver: false, safeMode: false });
    expect(q.detail).toContain("stay offline until this one is back");
    expect(q.buttons.map((b) => b.id)).toEqual(["quit", "cancel"]);
  });

  test("only routines or agents: no hand-over to offer", () => {
    const q = quitQuestion({ bots: [], routines: 1, agents: 0, canHandOver: true, safeMode: false });
    expect(q.ask).toBe(true);
    expect(q.buttons.map((b) => b.id)).toEqual(["quit", "cancel"]);
  });
});

describe("how the app was started, and its token", () => {
  test("a fresh start file from the daemon: started by it, in safe mode; the file is consumed", () => {
    const home = tempHome();
    mkdirRun(home);
    writeFileSync(startFilePath(home), JSON.stringify({ by: "daemon", safeMode: true, at: 1_000_000 }));
    expect(readStartInfo(home, [], 1_000_500)).toEqual({ by: "daemon", safeMode: true });
    expect(readStartInfo(home, [], 1_000_600)).toEqual({ by: "user", safeMode: false });
  });

  test("an old start file is a user's start", () => {
    const home = tempHome();
    mkdirRun(home);
    writeFileSync(startFilePath(home), JSON.stringify({ by: "daemon", safeMode: true, at: 1_000_000 }));
    expect(readStartInfo(home, [], 1_000_000 + 61_000)).toEqual({ by: "user", safeMode: false });
  });

  test("the command line: --safe-mode and --clover-started-by", () => {
    const home = tempHome();
    expect(readStartInfo(home, ["--safe-mode", "--clover-started-by=login"])).toEqual({ by: "login", safeMode: true });
  });

  test("the token: CLOVER_APP_TOKEN, else the daemon's file, else none", () => {
    const home = tempHome();
    expect(readAppToken(home, {})).toBeUndefined();
    mkdirRun(home);
    writeFileSync(join(home, "run", "app.token"), "abc\n");
    expect(readAppToken(home, {})).toBe("abc");
    expect(readAppToken(home, { CLOVER_APP_TOKEN: "env" })).toBe("env");
  });

  test("the endpoint: a socket in the home, or a pipe named after it on Windows", () => {
    expect(daemonEndpoint("/h", "darwin")).toBe(join("/h", "run", "core.sock"));
    const pipe = daemonEndpoint("C:\\Users\\me\\.clover", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\clover-core-[0-9a-f]{16}$/);
    expect(daemonEndpoint("c:\\users\\ME\\.clover", "win32")).toBe(pipe);
    expect(daemonEndpoint("C:\\Users\\me\\.clover-dev", "win32")).not.toBe(pipe);
  });
});

function mkdirRun(home: string): void {
  mkdirSync(join(home, "run"), { recursive: true });
}
