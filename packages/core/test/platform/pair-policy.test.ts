import { describe, expect, test } from "bun:test";
import { appRestartPlan, DaemonPair, type AppStartOutcome, type AppStartWhy, type DaemonPairOptions, type PairStopReason } from "../../src/platform/pair/policy";

/** A manual clock: timers fire only when the test advances time. */
function harness(opts: Partial<DaemonPairOptions> = {}, outcome: () => AppStartOutcome = () => "started") {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const starts: Array<{ at: number; why: AppStartWhy; safeMode: boolean }> = [];
  const told: PairStopReason[] = [];
  const toldTo: string[][] = [];
  const stops: string[] = [];
  let gone = 0;
  const pair: DaemonPair = new DaemonPair({
    now: () => now,
    after(ms, fn) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return () => { timers.delete(id); }; },
    async startApp(why) { starts.push({ at: now, why, safeMode: pair.status().safeMode }); return outcome(); },
    tellAppQuit(reason, ids) { told.push(reason); toldTo.push([...ids]); },
    stopDaemon(why) { stops.push(why); },
    onAppGone() { gone++; },
  }, { desktop: true, ...opts });
  async function advance(ms: number): Promise<void> {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await Promise.resolve(); await Promise.resolve(); // let an awaited startApp settle
    }
    now = end;
  }
  return { pair, starts, told, toldTo, stops, gone: () => gone, advance, pending: () => timers.size, now: () => now };
}

describe("appRestartPlan (S7 §5)", () => {
  test("1, 2, 4 s, and the third crash in two minutes restarts in safe mode", () => {
    expect(appRestartPlan([0], 0)).toEqual({ delayMs: 1_000, safeMode: false, recent: 1 });
    expect(appRestartPlan([0, 10_000], 10_000)).toEqual({ delayMs: 2_000, safeMode: false, recent: 2 });
    expect(appRestartPlan([0, 10_000, 20_000], 20_000)).toEqual({ delayMs: 4_000, safeMode: true, recent: 3 });
  });
  test("crashes older than the window do not count", () => {
    expect(appRestartPlan([0, 1_000, 200_000], 200_000)).toEqual({ delayMs: 1_000, safeMode: false, recent: 1 });
  });
  test("the delay is capped at the last step", () => {
    const many = Array.from({ length: 12 }, (_, i) => i * 1_000);
    expect(appRestartPlan(many, 11_000).delayMs).toBe(30_000);
  });
});

describe("DaemonPair", () => {
  test("starts the app when none connects within the grace after boot", async () => {
    const h = harness();
    h.pair.start();
    await h.advance(1_999);
    expect(h.starts).toHaveLength(0);
    await h.advance(1);
    expect(h.starts).toEqual([{ at: 2_000, why: "boot", safeMode: false }]);
  });

  test("an app that connects within the grace is not started again", async () => {
    const h = harness();
    h.pair.start();
    await h.advance(500);
    h.pair.appConnected("a");
    await h.advance(10_000);
    expect(h.starts).toHaveLength(0);
    expect(h.pair.status().appConnected).toBe(true);
  });

  test("a server (no desktop) never starts an app", async () => {
    const h = harness({ desktop: false });
    h.pair.start();
    h.pair.appConnected("a");
    h.pair.appDisconnected("a");
    await h.advance(60_000);
    expect(h.starts).toHaveLength(0);
    expect(h.stops).toHaveLength(0);
  });

  test("the last app connection leaving reports appGone once; an overlapping one holds it", () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.appConnected("b");
    h.pair.appDisconnected("a");
    expect(h.gone()).toBe(0); // "b" still up: the tabs keep their app
    h.pair.appDisconnected("b");
    expect(h.gone()).toBe(1); // lane E's appGone: the browser closes or parks the tabs
    h.pair.appDisconnected("b"); // already gone: no second report
    expect(h.gone()).toBe(1);
  });

  test("a crashed app restarts after 1, 2, then 4 s, the third in safe mode", async () => {
    const h = harness();
    h.pair.appConnected("a1");
    h.pair.appDisconnected("a1"); // crash 1 at t=0
    await h.advance(1_000);
    expect(h.starts.at(-1)).toEqual({ at: 1_000, why: "crash", safeMode: false });
    h.pair.appConnected("a2");
    h.pair.appDisconnected("a2"); // crash 2
    await h.advance(2_000);
    expect(h.starts.at(-1)).toEqual({ at: 3_000, why: "crash", safeMode: false });
    h.pair.appConnected("a3");
    h.pair.appDisconnected("a3"); // crash 3, within two minutes
    await h.advance(4_000);
    expect(h.starts.at(-1)).toEqual({ at: 7_000, why: "crash", safeMode: true });
    h.pair.appConnected("a4");
    expect(h.pair.status().safeMode).toBe(true); // the app reads it from pair.status
  });

  test("the user's restart leaves safe mode and is not a crash", async () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) { h.pair.appConnected(id); h.pair.appDisconnected(id); await h.advance(5_000); }
    h.pair.appConnected("safe");
    expect(h.pair.status().safeMode).toBe(true);
    h.pair.appExiting("safe", "restart");
    h.pair.appDisconnected("safe");
    expect(h.pair.status()).toMatchObject({ safeMode: false, crashesInWindow: 0, startPending: "restart" });
    h.pair.appConnected("normal"); // came back by itself
    await h.advance(30_000);
    expect(h.starts.filter((s) => s.why === "restart")).toHaveLength(0);
  });

  test("an app restarting itself that does not come back is started after the restart grace", async () => {
    const h = harness({ restartGraceMs: 10_000 });
    h.pair.appConnected("a");
    h.pair.appExiting("a", "restart");
    h.pair.appDisconnected("a");
    await h.advance(9_999);
    expect(h.starts).toHaveLength(0);
    await h.advance(1);
    expect(h.starts).toEqual([{ at: 10_000, why: "restart", safeMode: false }]);
  });

  test("the app's quit stops the pair once the app has gone, without restarting it", async () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.appExiting("a", "quit");
    expect(h.stops).toHaveLength(0);
    expect(h.told).toHaveLength(0); // the app is the one leaving: no app.quit back to it
    h.pair.appDisconnected("a");
    expect(h.stops).toHaveLength(1);
    await h.advance(60_000);
    expect(h.starts).toHaveLength(0);
    expect(h.stops).toHaveLength(1);
  });

  test("an update from the app stops the pair the same way", () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.appExiting("a", "update");
    h.pair.appDisconnected("a");
    expect(h.stops).toEqual(["the app went (update)"]);
  });

  test("pair.quit (or SIGTERM) tells the app, then stops when it goes", () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.quit("quit");
    expect(h.told).toEqual(["quit"]);
    expect(h.stops).toHaveLength(0);
    h.pair.appDisconnected("a");
    expect(h.stops).toEqual(["the app went (quit)"]);
  });

  test("pair.quit stops anyway when the app does not go in time", async () => {
    const h = harness({ quitTimeoutMs: 3_000 });
    h.pair.appConnected("a");
    h.pair.quit("update");
    await h.advance(2_999);
    expect(h.stops).toHaveLength(0);
    await h.advance(1);
    expect(h.stops).toHaveLength(1);
    h.pair.appDisconnected("a");
    expect(h.stops).toHaveLength(1); // stopped once
  });

  test("pair.quit with no app connected stops at once, and cancels a pending start", async () => {
    const h = harness();
    h.pair.start();
    h.pair.quit("quit");
    expect(h.stops).toHaveLength(1);
    await h.advance(10_000);
    expect(h.starts).toHaveLength(0);
  });

  test("an app connecting while the pair stops is told to quit too", () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.quit("quit");
    h.pair.appConnected("b");
    expect(h.told).toEqual(["quit", "quit"]);
  });

  test("a reconnect overlapping the old connection is not a crash", async () => {
    const h = harness();
    h.pair.appConnected("old");
    h.pair.appConnected("new");
    h.pair.appDisconnected("old");
    await h.advance(60_000);
    expect(h.starts).toHaveLength(0);
    expect(h.pair.status().crashesInWindow).toBe(0);
  });

  test("a user starting the app during the back-off cancels the daemon's start", async () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.appDisconnected("a");
    await h.advance(500);
    h.pair.appConnected("user");
    await h.advance(10_000);
    expect(h.starts).toHaveLength(0);
  });

  test("an OS refusal counts as a crash and backs off", async () => {
    const h = harness({}, () => "failed");
    h.pair.start();
    await h.advance(2_000); // boot start, refused → crash 1 → +1 s
    await h.advance(1_000); // refused → crash 2 → +2 s
    await h.advance(2_000); // refused → crash 3 → +4 s, safe mode
    await h.advance(4_000);
    expect(h.starts.map((s) => [s.at, s.why, s.safeMode])).toEqual([
      [2_000, "boot", false], [3_000, "crash", false], [5_000, "crash", false], [9_000, "crash", true],
    ]);
  });

  test("a start the OS can't make yet (no graphical session) is retried and is not a crash", async () => {
    let ready = false;
    const h = harness({ notReadyRetryMs: 3_000 }, () => (ready ? "started" : "not-ready"));
    h.pair.start();
    await h.advance(2_000 + 3_000 * 10); // ten retries over 30 s
    expect(h.pair.status()).toMatchObject({ crashesInWindow: 0, safeMode: false, startPending: "boot" });
    ready = true;
    await h.advance(3_000);
    expect(h.starts.at(-1)).toMatchObject({ why: "boot", safeMode: false });
    h.pair.appConnected("a");
    expect(h.pair.status().startPending).toBeNull();
  });

  test("an app that never connects after a start counts as a crash", async () => {
    const h = harness({ connectTimeoutMs: 20_000 });
    h.pair.start();
    await h.advance(2_000);
    expect(h.starts).toHaveLength(1);
    await h.advance(20_000);
    expect(h.pair.status().crashesInWindow).toBe(1);
    await h.advance(1_000);
    expect(h.starts).toHaveLength(2);
  });

  test("the app that asked for pair.quit gets its answer and no app.quit back (E-M1)", () => {
    const h = harness();
    h.pair.appConnected("app");
    h.pair.quit("quit", "app");
    expect(h.told).toEqual([]);
    expect(h.stops).toHaveLength(0);
    h.pair.appDisconnected("app");
    expect(h.stops).toEqual(["the app went (quit)"]);
  });

  test("pair.quit from the CLI tells the app", () => {
    const h = harness();
    h.pair.appConnected("app");
    h.pair.quit("quit", "cli-conn"); // not an app connection
    expect(h.toldTo).toEqual([["app"]]);
  });

  test("app.quit goes only to apps whose hello listed it; one that can't be told is waited for", async () => {
    const h = harness({ quitTimeoutMs: 3_000 });
    h.pair.appConnected("old", ["app.show"]);
    h.pair.appConnected("new", ["app.show", "app.quit", "layers"]);
    h.pair.quit("update");
    expect(h.toldTo).toEqual([["new"]]);
    h.pair.appDisconnected("new");
    expect(h.stops).toHaveLength(0); // "old" is still there
    await h.advance(3_000);
    expect(h.stops).toHaveLength(1);
  });

  test("a hung app (no app.ping answer, R9) restarts in safe mode on its first crash", async () => {
    const h = harness();
    h.pair.appConnected("a");
    h.pair.appHung("a");
    h.pair.appDisconnected("a"); // the daemon ended it
    expect(h.pair.status()).toMatchObject({ safeMode: true, crashesInWindow: 1, startPending: "crash" });
    await h.advance(1_000);
    expect(h.starts.at(-1)).toEqual({ at: 1_000, why: "crash", safeMode: true });
  });

  test("dispose cancels every timer", async () => {
    const h = harness();
    h.pair.start();
    h.pair.dispose();
    expect(h.pending()).toBe(0);
    await h.advance(60_000);
    expect(h.starts).toHaveLength(0);
  });
});
