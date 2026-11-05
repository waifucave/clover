// Pins the PluginHost contract through FakePluginHost: limits, failures, crash backoff and the stop after three,
// reloads, MCP channels and the plugin-API router.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { FakeClock, advanceAndSettle, flush } from "../fakes/clock";
import { FakePluginHost } from "../fakes/plugin-host";
import { CRASH_WINDOW_MS, PLUGIN_CALL_MAX_TIMEOUT_MS, PLUGIN_CALL_TIMEOUT_MS, RELOAD_GRACE_MS, crashBackoffMs, type HostedStatus } from "../plugin-host";
import type { HandlerContext } from "../sdk-types";

const USER: Caller = { kind: "user", client: "app" };
const hang = () => new Promise<never>(() => {});

function setup() {
  const clock = new FakeClock();
  const host = new FakePluginHost({ clock, computer: "Studio" });
  const statuses: HostedStatus[] = [];
  host.watch((s) => statuses.push(s));
  return { clock, host, statuses };
}

const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("FakePluginHost", () => {
  test("a handler gets its caller and a copy of its arguments; its result comes back as a copy", async () => {
    const { host } = setup();
    let seen: HandlerContext | undefined;
    const args = { count: 3, deck: ["fool"] };
    host.define("tarot", {
      draw: (a: { count: number; deck: string[] }, ctx: HandlerContext) => {
        seen = ctx;
        a.deck.push("mutated");
        return { cards: a.deck.slice(0, a.count) };
      },
    });
    const result = await host.invoke<{ cards: string[] }>({ pluginId: "tarot", handler: "draw", args, caller: USER, session: "s_alpha" });
    expect(result).toEqual({ cards: ["fool", "mutated"] });
    expect(args.deck).toEqual(["fool"]);
    expect(seen).toMatchObject({ caller: USER, session: "s_alpha", computer: "Studio" });
    expect(seen!.deadline).toBeGreaterThan(0);
  });

  test("the start export runs once, before the first call", async () => {
    const { host } = setup();
    let starts = 0;
    host.define("p", { start: () => void starts++, ping: () => "pong" });
    expect(await host.invoke<string>({ pluginId: "p", handler: "ping", args: null, caller: USER })).toBe("pong");
    expect(await host.invoke<string>({ pluginId: "p", handler: "ping", args: null, caller: USER })).toBe("pong");
    expect(starts).toBe(1);
    expect(host.status("p").state).toBe("running");
  });

  test("not installed, no such handler, and the reserved exports all answer not_installed", async () => {
    const { host } = setup();
    host.define("p", { start: () => {}, stop: () => {}, ok: () => 1 });
    expect(isContractError(await rejection(host.invoke({ pluginId: "nope", handler: "ok", args: 0, caller: USER })), "not_installed")).toBe(true);
    expect(isContractError(await rejection(host.invoke({ pluginId: "p", handler: "missing", args: 0, caller: USER })), "not_installed")).toBe(true);
    expect(isContractError(await rejection(host.invoke({ pluginId: "p", handler: "stop", args: 0, caller: USER })), "not_installed")).toBe(true);
  });

  test("a handler that throws fails `failed` with its message", async () => {
    const { host } = setup();
    host.define("p", { bad: () => { throw new Error("deck is empty"); } });
    const err = await rejection(host.invoke({ pluginId: "p", handler: "bad", args: 0, caller: USER }));
    expect(isContractError(err, "failed")).toBe(true);
    expect((err as Error).message).toBe("deck is empty");
  });

  test("a call times out after 10 seconds by default, at most 10 minutes, unless it keeps its own limit", async () => {
    const { clock, host } = setup();
    let signal: AbortSignal | undefined;
    host.define("p", { slow: (_a: unknown, ctx: HandlerContext) => ((signal = ctx.signal), hang()) });
    const p = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER });
    await flush();
    clock.advance(PLUGIN_CALL_TIMEOUT_MS - 1);
    await flush();
    expect(signal?.aborted).toBe(false);
    clock.advance(1);
    expect(isContractError(await rejection(p), "timeout")).toBe(true);
    expect(signal?.aborted).toBe(true);

    const long = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER, timeoutMs: 60 * 60_000 });
    await flush();
    clock.advance(PLUGIN_CALL_MAX_TIMEOUT_MS);
    expect(isContractError(await rejection(long), "timeout")).toBe(true);

    let done = false;
    const own = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER, timeoutMs: 60 * 60_000, ownLimit: true }).catch(() => (done = true));
    await flush();
    clock.advance(PLUGIN_CALL_MAX_TIMEOUT_MS);
    await flush();
    expect(done).toBe(false);
    clock.advance(60 * 60_000);
    await own;
    expect(done).toBe(true);
  });

  test("an aborted call fails `cancelled` and aborts the handler's signal", async () => {
    const { host } = setup();
    let signal: AbortSignal | undefined;
    host.define("p", { slow: (_a: unknown, ctx: HandlerContext) => ((signal = ctx.signal), hang()) });
    const abort = new AbortController();
    const p = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER, signal: abort.signal });
    await flush();
    abort.abort();
    expect(isContractError(await rejection(p), "cancelled")).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  test("a crash fails the calls in flight and restarts after 1 s, then 2 s; the third in 10 minutes stops it", async () => {
    const { clock, host } = setup();
    let starts = 0;
    host.define("p", { start: () => void starts++, slow: hang, ok: () => "ok" });
    const inFlight = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER });
    await flush();
    host.crash("p", "segfault");
    expect(isContractError(await rejection(inFlight), "failed")).toBe(true);
    expect(host.status("p")).toMatchObject({ state: "restarting", crashes: 1, restartAt: clock.now() + 1000 });

    // A call during the backoff waits for the restart.
    const waiting = host.invoke({ pluginId: "p", handler: "ok", args: 0, caller: USER });
    await advanceAndSettle(clock, 1000);
    expect(await waiting).toBe("ok");
    expect(starts).toBe(2);

    host.crash("p");
    expect(host.status("p")).toMatchObject({ state: "restarting", crashes: 2, restartAt: clock.now() + 2000 });
    await advanceAndSettle(clock, 2000);
    expect(host.status("p").state).toBe("running");

    host.crash("p", "segfault again");
    expect(host.status("p")).toMatchObject({ state: "stopped", reason: "crashed 3 times in 10 minutes: segfault again" });
    const err = await rejection(host.invoke({ pluginId: "p", handler: "ok", args: 0, caller: USER }));
    expect(isContractError(err, "plugin_stopped")).toBe(true);
    expect((err as Error).message).toBe("plugin stopped: crashed 3 times in 10 minutes: segfault again");

    await host.restart("p");
    expect(host.status("p")).toMatchObject({ state: "running", crashes: 0 });
  });

  test("crashes older than 10 minutes don't count toward the stop", async () => {
    const { clock, host } = setup();
    host.define("p", { ok: () => 1 });
    await host.ensureStarted("p");
    host.crash("p");
    await advanceAndSettle(clock, 1000);
    host.crash("p");
    await advanceAndSettle(clock, CRASH_WINDOW_MS);
    host.crash("p");
    expect(host.status("p")).toMatchObject({ state: "restarting", crashes: 1 });
  });

  test("the backoff doubles up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(crashBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  test("a reload gives calls in flight a grace period, then interrupts them, and runs the new module", async () => {
    const { clock, host } = setup();
    let stops: string[] = [];
    host.define("p", { stop: (why: string) => void stops.push(why), slow: hang, v: () => 1 });
    expect(await host.invoke<number>({ pluginId: "p", handler: "v", args: 0, caller: USER })).toBe(1);
    const inFlight = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER, timeoutMs: 60_000 });
    await flush();
    host.define("p", { v: () => 2 });
    const reloading = host.reload("p");
    await advanceAndSettle(clock, RELOAD_GRACE_MS);
    await reloading;
    const err = await rejection(inFlight);
    expect(isContractError(err, "cancelled")).toBe(true);
    expect((err as Error).message).toContain("reloaded");
    expect(stops).toEqual(["reload"]);
    expect(await host.invoke<number>({ pluginId: "p", handler: "v", args: 0, caller: USER })).toBe(2);
  });

  test("stop fails the calls in flight and refuses new ones with the reason", async () => {
    const { host } = setup();
    host.define("p", { slow: hang });
    const p = host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER });
    await flush();
    await host.stop("p", "turned off on this computer");
    expect(isContractError(await rejection(p), "plugin_stopped")).toBe(true);
    expect((await rejection(host.invoke({ pluginId: "p", handler: "slow", args: 0, caller: USER })) as Error).message).toBe("plugin stopped: turned off on this computer");
  });

  test("a host MCP server is reached as a raw JSON-RPC channel", async () => {
    const { host } = setup();
    host.define("tarot", {
      mcp: {
        tarot: async (transport) => {
          transport.onmessage = (msg) => void transport.send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "Draw" }] } });
          await transport.start();
        },
      },
    });
    const channel = await host.openMcp("tarot", "tarot");
    const got = new Promise<Record<string, unknown>>((resolve) => channel.onMessage(resolve));
    channel.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(await got).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "Draw" }] } });
    channel.close();
    expect(channel.closed).toBe(true);
    expect(isContractError(await rejection(host.openMcp("tarot", "other")), "not_installed")).toBe(true);
  });

  test("a plugin's own API calls reach the core's router by path, with its id and the caller", async () => {
    const { host } = setup();
    const calls: { pluginId: string; path: string; args: unknown[]; caller: Caller }[] = [];
    host.serveApi(async (call) => {
      calls.push(call);
      return call.path === "storage.synced.get" ? ["fool", "tower"] : undefined;
    });
    host.define("tarot", { deck: async (_a: unknown, ctx: HandlerContext) => ctx.api.storage.synced.get<string[]>("deck") });
    expect(await host.invoke<string[]>({ pluginId: "tarot", handler: "deck", args: 0, caller: USER })).toEqual(["fool", "tower"]);
    expect(calls).toEqual([{ pluginId: "tarot", path: "storage.synced.get", args: ["deck"], caller: USER }]);
  });
});
