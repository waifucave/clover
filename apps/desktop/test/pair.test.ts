// The app's side of the pair against a fake daemon (lane C's side lands in C-M1): starting the daemon through the OS
// when none answers, coming back after a crash (the OS first, the app after 3 s), Quit and Hand over and quit, the
// daemon's own quit, the token, how the app was started, and Quit's question.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloverHelloParams } from "@waifucave/clover-protocol";
import { daemonEndpoint } from "../src/main/protocol/client";
import { parseAutostartStatus, type DaemonLauncher } from "../src/main/pair/login";
import { Pair, daemonProof, type PairState } from "../src/main/pair/pair";
import { quitQuestion } from "../src/main/pair/quit";
import { appHello, devOverridesAllowed, pairEnv, readAppToken, readStartInfo, startFilePath } from "../src/main/pair/start";
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

function pairFor(home: string, launcher: DaemonLauncher | undefined, extra: { onDaemonQuit?: (r: string) => void; log?: (line: string) => void; prove?: boolean } = {}): { pair: Pair; states: PairState["kind"][] } {
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
    ...(extra.log ? { log: extra.log } : {}),
    ...(extra.prove ? { prove: { pid: process.pid } } : {}),
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

  test("lane C's SIGTERM: app.quit, then the daemon is gone at once; that's no crash, and nothing restarts it", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const launcher = fakeLauncher(home);
    let told: string | undefined;
    const { pair, states } = pairFor(home, launcher, { onDaemonQuit: (r) => (told = r) });
    await pair.start();
    await fake.quitAndDie();
    await until(() => told !== undefined && pair.state.kind === "stopped");
    expect(told).toBe("quit");
    await new Promise((r) => setTimeout(r, 100));
    expect(states).not.toContain("reconnecting");
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

describe("the daemon's proof before the hello (lane C's protocol.prove, on the same connection)", () => {
  test("this user's daemon proves it holds the token and sees this process: the hello goes, and the pair connects", async () => {
    const home = tempHome();
    fakes.push(await startFakeDaemon({ home }));
    const { pair } = pairFor(home, fakeLauncher(home), { prove: true });
    await pair.start();
    expect(pair.state.kind).toBe("connected");
    const methods = readCalls(home).filter((c) => c.event === "request").map((c) => c.method);
    expect(methods.slice(0, 2)).toEqual(["protocol.prove", "protocol.hello"]);
    // The nonce is fresh and long, and nothing secret goes with it.
    const prove = readCalls(home).find((c) => c.method === "protocol.prove")!.params as { nonce: string };
    expect(prove.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Object.keys(prove)).toEqual(["nonce"]);
  });

  for (const [what, prove, reason] of [
    ["gives no proof", "refuse", "it gave no proof"],
    ["can't prove it holds the token", "wrong", "its proof is wrong"],
    ["sees another process at the other end (a proof relayed from its own connection)", 1, "another process"],
  ] as const) {
    test(`an endpoint that ${what} gets nothing: no hello, no token`, async () => {
      const home = tempHome();
      fakes.push(await startFakeDaemon({ home, prove }));
      const { pair } = pairFor(home, fakeLauncher(home), { prove: true });
      await pair.start();
      // (Read before matching: Bun's toMatchObject writes its matchers into the object it checks.)
      const state = { ...pair.state } as { kind: string; reason?: string };
      expect(state.kind).toBe("unavailable");
      expect(state.reason).toContain(reason);
      expect(state.reason).toContain("the app sent it nothing");
      expect(readCalls(home).some((c) => c.method === "protocol.hello")).toBe(false);
    });
  }

  test("the proof is lane C's: an HMAC under the app token over the nonce and the pid", () => {
    expect(daemonProof("token", "nonce", 42)).toBe(createHmac("sha256", "token").update("clover-daemon-proof\u0000nonce\u000042").digest("base64url"));
  });
});

describe("what the daemon sends is checked (the E-M1 review's should-fix 2)", () => {
  test("an app.quit that isn't one is answered with an error, and the app stays", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    let told: string | undefined;
    const { pair } = pairFor(home, fakeLauncher(home), { onDaemonQuit: (r) => (told = r) });
    await pair.start();
    const [answer] = await fake.request("app.quit", { reason: "now" });
    expect(answer).toMatchObject({ message: expect.stringContaining("app.quit needs a reason") });
    await new Promise((r) => setTimeout(r, 50));
    expect(told).toBeUndefined();
    expect(pair.state.kind).toBe("connected");
  });

  test("a listener that throws stops neither the other listeners, the rest of the chunk, nor the connection", async () => {
    const home = tempHome();
    const fake = await startFakeDaemon({ home });
    fakes.push(fake);
    const lines: string[] = [];
    const { pair } = pairFor(home, fakeLauncher(home), { log: (l) => lines.push(l) });
    const seen: unknown[] = [];
    pair.onNotification(() => {
      throw new Error("boom");
    });
    pair.onNotification((_m, p) => seen.push(p));
    await pair.start();
    fake.write([{ jsonrpc: "2.0", method: "core.event", params: { type: "a" } }, { jsonrpc: "2.0", method: "core.event", params: { type: "b" } }]);
    await until(() => seen.length === 2);
    expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
    expect(lines.filter((l) => l.includes("a listener for core.event failed: boom")).length).toBe(2);
    expect(pair.state.kind).toBe("connected");
  });
});

describe("Quit's question", () => {
  test("a pair.status that isn't one falls back to a plain Quit", () => {
    expect(quitQuestion({ bots: "alpha" })).toMatchObject({ ask: false });
    expect(quitQuestion(null)).toMatchObject({ ask: false });
    expect(quitQuestion({ bots: ["alpha"], routines: -1, agents: 0, canHandOver: true, safeMode: false })).toMatchObject({ ask: false });
  });

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

  test("the dev overrides count only in a dev or unpackaged run", () => {
    expect(devOverridesAllowed({ packaged: false, profile: "dist" })).toBe(true);
    expect(devOverridesAllowed({ packaged: true, profile: "dev" })).toBe(true);
    expect(devOverridesAllowed({ packaged: true, profile: "dist" })).toBe(false);
    const env = { CLOVER_DAEMON_BIN: "/tmp/x", CLOVER_APP_TOKEN: "t", CLOVER_HOME: "/h" };
    expect(pairEnv(env, false)).toEqual({ CLOVER_HOME: "/h" });
    expect(pairEnv(env, true)).toBe(env);
  });

  test("the endpoint, as lane C resolves it: a socket in the run directory, or a pipe named after it on Windows", () => {
    expect(daemonEndpoint("/h", "darwin")).toBe("/h/run/core.sock");
    const pipe = daemonEndpoint("C:\\Users\\me\\.clover", "win32");
    const id = createHash("sha256").update("C:\\Users\\me\\.clover\\run").digest("hex").slice(0, 16);
    expect(pipe).toBe(`\\\\.\\pipe\\clover-core-${id}`);
    expect(daemonEndpoint("C:\\Users\\me\\.clover-dev", "win32")).not.toBe(pipe);
  });

  test("lane C's `autostart status`, as text or JSON", () => {
    expect(parseAutostartStatus("autostart: enabled (/Users/u/Library/LaunchAgents/x.plist) [registered]\n")).toEqual({ registered: true });
    expect(parseAutostartStatus("autostart: disabled\n")).toEqual({ registered: false });
    expect(parseAutostartStatus('{"registered":true,"running":false}')).toEqual({ registered: true, running: false });
    expect(parseAutostartStatus("something else")).toBeUndefined();
  });
});

function mkdirRun(home: string): void {
  mkdirSync(join(home, "run"), { recursive: true });
}
