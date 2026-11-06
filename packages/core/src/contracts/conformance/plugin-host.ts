// The PluginHost conformance suite (review S15). `runPluginHostConformance(make)` registers every case against the
// implementation `make` builds; `tests/plugin-host.test.ts` runs it against FakePluginHost, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// limits, failures, crash backoff and the stop after three,
// reloads, MCP channels and the plugin-API router.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { FakeClock, advanceAndSettle, flush } from "../fakes/clock";
import { type FakePluginHost } from "../fakes/plugin-host";
import {
  CRASH_WINDOW_MS, MCP_INVOCATION_META, PLUGIN_CALL_MAX_TIMEOUT_MS, PLUGIN_CALL_TIMEOUT_MS, RELOAD_GRACE_MS, cloverProcessOnly, crashBackoffMs,
  guardApiRouter, hostProcessFor, resolveHandler, type ApiRouter, type HostedStatus, type InstallRecord,
} from "../plugin-host";
import type { HandlerContext } from "../sdk-types";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type PluginHostHarness = Pick<FakePluginHost, keyof FakePluginHost>;
/** Builds the implementation under test from the options the fake takes. */
export type PluginHostFactory = (...args: ConstructorParameters<typeof FakePluginHost>) => PluginHostHarness;

export function runPluginHostConformance(make: PluginHostFactory): void {
  const USER: Caller = { kind: "user", client: "app" };
  /** The account token's `auth` name (the plugin SDK's `WAIFUCAVE_AUTH`; `tests/plugin-host.test.ts` checks they agree). */
  const WAIFUCAVE_AUTH = "waifucave";
  const hang = () => new Promise<never>(() => {});

  function setup() {
    const clock = new FakeClock();
    const host = make({ clock, computer: "Studio" });
    const statuses: HostedStatus[] = [];
    host.watch((s) => statuses.push(s));
    return { clock, host, statuses };
  }

  const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

  describe("PluginHost", () => {
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

    test("an export that is an object of handlers runs the one `method` names, on its object", async () => {
      const { host } = setup();
      class Ingress {
        #held = ["d1"];
        next() {
          return this.#held.shift() ?? null;
        }
      }
      const notifier = { unseen: 0, notify(u: { unseen: number }) { this.unseen = u.unseen; return this.unseen; }, clear: () => 0 };
      host.define("clover/forwarder", { ingress: new Ingress(), notifier, plain: () => "plain" });
      const call = (handler: string, method?: string, args: unknown = null) =>
        host.invoke({ pluginId: "clover/forwarder", handler, ...(method === undefined ? {} : { method }), args, caller: { kind: "core" } });
      expect(await call("ingress", "next")).toBe("d1");
      expect(await call("ingress", "next")).toBeNull();
      expect(await call("notifier", "notify", { unseen: 4 })).toBe(4);
      expect(notifier.unseen).toBe(4);
      expect(await call("plain")).toBe("plain");
      for (const [handler, method] of [["ingress", undefined], ["ingress", "constructor"], ["ingress", "toString"], ["notifier", "unseen"], ["notifier", "missing"], ["plain", "call"]] as const) {
        expect([handler, method, isContractError(await rejection(call(handler, method)), "not_installed")]).toEqual([handler, method, true]);
      }
    });

    test("resolveHandler never reaches what every object has, nor the reserved exports", () => {
      const mod = { svc: Object.create(null, { go: { value: () => 1, enumerable: true } }), start: () => 0, fn: () => 2 };
      expect(resolveHandler(mod, "svc", "go")?.fn(null, null)).toBe(1);
      expect(resolveHandler(mod, "fn")?.fn(null, null)).toBe(2);
      expect(resolveHandler(mod, "start")).toBeUndefined();
      expect(resolveHandler(mod, "fn", "apply")).toBeUndefined();
      expect(resolveHandler(mod, "svc", "__proto__")).toBeUndefined();
      expect(resolveHandler(mod, "hasOwnProperty")).toBeUndefined();
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
      const calls: Parameters<ApiRouter>[0][] = [];
      host.serveApi(async (call) => {
        calls.push(call);
        return call.path === "storage.synced.get" ? ["fool", "tower"] : undefined;
      });
      host.define("tarot", { deck: async (_a: unknown, ctx: HandlerContext) => ctx.api.storage.synced.get<string[]>("deck") });
      expect(await host.invoke<string[]>({ pluginId: "tarot", handler: "deck", args: 0, caller: USER })).toEqual(["fool", "tower"]);
      expect(calls).toEqual([{ pluginId: "tarot", process: "shared", path: "storage.synced.get", args: ["deck"], caller: USER }]);
    });

    test("a call made while serving a tool call acts as its session; one made outside any acts as the plugin (R7)", async () => {
      const { host } = setup();
      const callers: unknown[] = [];
      host.serveApi(async (call) => void callers.push([call.path, call.caller]));
      const SESSION: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
      let startApi: HandlerContext["api"] | undefined;
      host.define("browser", {
        start: async (api: HandlerContext["api"]) => void (startApi = api),
        // A plugin can't speak for anyone else: what it passes as a caller is only an argument.
        tabs: async (_a: unknown, ctx: HandlerContext) => ctx.api.browser!.tabs({ owner: { kind: "user" } }),
      });
      await host.invoke({ pluginId: "browser", handler: "tabs", args: { _meta: { "clover/caller": USER } }, caller: SESSION, session: "s_alpha" });
      await startApi!.browser!.tabs();
      expect(callers).toEqual([["browser.tabs", SESSION], ["browser.tabs", { kind: "plugin", pluginId: "browser" }]]);
    });

    test("a call's ctx.api ends with the call: kept and used later, it is closed (#179's review, S1)", async () => {
      const { host } = setup();
      const callers: unknown[] = [];
      host.serveApi(async (call) => void callers.push(call.path));
      const SESSION: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
      let kept: HandlerContext["api"] | undefined;
      host.define("browser", {
        tabs: async (_a: unknown, ctx: HandlerContext) => {
          kept = ctx.api;
          await ctx.api.browser!.tabs();
        },
      });
      await host.invoke({ pluginId: "browser", handler: "tabs", args: null, caller: SESSION, session: "s_alpha" });
      expect(isContractError(await rejection(Promise.resolve(kept!.browser!.tabs())), "closed")).toBe(true);
      expect(callers).toEqual(["browser.tabs"]);
    });

    test("the core's call id on an MCP request never reaches the plugin's server (R7)", async () => {
      const { host } = setup();
      const seen: unknown[] = [];
      host.define("tarot", {
        mcp: {
          tarot: async (transport) => {
            transport.onmessage = (msg) => {
              seen.push(msg);
              void transport.send({ jsonrpc: "2.0", id: msg.id, result: { content: [] } });
            };
            await transport.start();
          },
        },
      });
      const channel = await host.openMcp("tarot", "tarot");
      const got = new Promise<unknown>((resolve) => channel.onMessage(resolve));
      channel.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "Draw", arguments: {}, _meta: { [MCP_INVOCATION_META]: "call_1", progressToken: 1 } } }, { kind: "session", sessionId: "s_alpha", sessionKind: "bot" });
      await got;
      expect(seen).toEqual([{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "Draw", arguments: {}, _meta: { progressToken: 1 } } }]);
    });

    test("the plugin id on an API call is the worker's, stamped by the host, whatever the plugin passes (review S3)", async () => {
      const { host } = setup();
      const ids: string[] = [];
      host.serveApi(async (call) => void ids.push(call.pluginId));
      host.define("third-party", {
        spoof: async (_a: unknown, ctx: HandlerContext) => {
          await ctx.api.net.fetch("https://hooks.waifucave.com/x", {}, { auth: "waifucave" });
          await (ctx.api as unknown as { call(o: unknown): Promise<unknown> }).call({ pluginId: "clover/forwarder" });
        },
      });
      await host.invoke({ pluginId: "third-party", handler: "spoof", args: 0, caller: USER });
      expect(ids).toEqual(["third-party", "third-party"]);
    });

    test("the core decides the process from the install record: the bundled clover tree's own, the shared one, a Node plugin's own (S4)", () => {
      expect(hostProcessFor({ id: "clover/forwarder", source: "bundled" })).toBe("clover");
      expect(hostProcessFor({ id: "clover", source: "bundled" })).toBe("clover");
      // An id is no claim: a clover id that wasn't installed with the app is a third-party plugin.
      expect(hostProcessFor({ id: "clover/forwarder", source: "local" })).toBe("shared");
      expect(hostProcessFor({ id: "cloverleaf", source: "bundled" })).toBe("shared");
      expect(hostProcessFor({ id: "luna/tarot", source: "index" })).toBe("shared");
      expect(hostProcessFor({ id: "opensky", source: "index", runtime: "node" })).toBe("own");
      expect(hostProcessFor({ id: "clover/model-bedrock", source: "bundled", runtime: "node" })).toBe("own");
    });

    test("a third-party worker presenting a clover/* id is refused, and the account token and keys answer only the clover process (S4)", async () => {
      const { host } = setup();
      const records = new Map<string, InstallRecord>([
        ["clover/forwarder", { id: "clover/forwarder", source: "bundled" }],
        ["luna", { id: "luna", source: "index" }],
      ]);
      const served: { pluginId: string; process: string; path: string }[] = [];
      const inner: ApiRouter = async (call) => void served.push({ pluginId: call.pluginId, process: call.process, path: call.path });
      host.serveApi(guardApiRouter(inner, (id) => records.get(id)));
      host.define("clover/forwarder", {
        next: async (_a: unknown, ctx: HandlerContext) => {
          await ctx.api.keys!.open("forwarder", { enc: new Uint8Array(32), ciphertext: new Uint8Array(16) });
          await ctx.api.net.fetch("https://hooks.waifucave.com/v1/next", undefined, { auth: WAIFUCAVE_AUTH });
        },
      }, { source: "bundled" });
      host.define("luna", {
        sneak: async (_a: unknown, ctx: HandlerContext) => ctx.api.net.fetch("https://hooks.waifucave.com/v1/next", undefined, { auth: WAIFUCAVE_AUTH }),
        keys: async (_a: unknown, ctx: HandlerContext) => ctx.api.keys!.publicKey("mine"),
        fine: async (_a: unknown, ctx: HandlerContext) => ctx.api.storage.synced.get("x"),
      }, { source: "index" });
      expect([host.processOf("clover/forwarder"), host.processOf("luna")]).toEqual(["clover", "shared"]);
      await host.invoke({ pluginId: "clover/forwarder", handler: "next", args: null, caller: USER });
      expect(served.map((c) => `${c.pluginId}@${c.process}:${c.path}`)).toEqual(["clover/forwarder@clover:keys.open", "clover/forwarder@clover:net.fetch"]);
      // From the shared process: the account token and key pairs are refused, even for luna's own pair.
      expect(isContractError(await rejection(host.invoke({ pluginId: "luna", handler: "sneak", args: null, caller: USER })), "refused")).toBe(true);
      expect(isContractError(await rejection(host.invoke({ pluginId: "luna", handler: "keys", args: null, caller: USER })), "refused")).toBe(true);
      await host.invoke({ pluginId: "luna", handler: "fine", args: null, caller: USER });
      // A compromised shared process presenting the forwarder's id, or an unknown one, is refused before any call runs.
      served.length = 0;
      for (const path of ["keys.open", "net.fetch", "storage.synced.get"]) {
        expect(isContractError(await rejection(host.forgeApiCall("shared", "clover/forwarder", path, [])), "refused")).toBe(true);
      }
      expect(isContractError(await rejection(host.forgeApiCall("clover", "luna", "storage.synced.get", [])), "refused")).toBe(true);
      expect(isContractError(await rejection(host.forgeApiCall("shared", "no-such-plugin", "storage.synced.get", [])), "refused")).toBe(true);
      expect(served).toEqual([]);
      expect(cloverProcessOnly("net.fetch", ["https://api.example.com", {}, { auth: "luna" }])).toBe(false);
      expect(cloverProcessOnly("keys.delete", ["x"])).toBe(true);
    });

    test("a streamed handler's values arrive in order, then its return value; its input arrives as ctx.input (review S16)", async () => {
      const { host } = setup();
      let heard: unknown[] = [];
      host.define("voice", {
        speak: async function* (a: { text: string }) {
          for (const word of a.text.split(" ")) yield { audio: word };
          return { words: a.text.split(" ").length };
        },
        listen: async function* (_a: unknown, ctx: HandlerContext) {
          heard = [];
          for await (const chunk of ctx.input!) {
            heard.push(chunk);
            yield { partial: heard.length };
          }
          return { text: heard.join(" ") };
        },
        notAStream: () => 1,
      });
      const out: unknown[] = [];
      const speak = host.stream<{ audio: string }, { words: number }>({ pluginId: "voice", handler: "speak", args: { text: "hello there" }, caller: USER });
      for (;;) {
        const next = await speak.next();
        if (next.done) {
          expect(next.value).toEqual({ words: 2 });
          break;
        }
        out.push(next.value);
      }
      expect(out).toEqual([{ audio: "hello" }, { audio: "there" }]);
      async function* mic() {
        yield "good";
        yield "morning";
      }
      const partials: unknown[] = [];
      const listen = host.stream({ pluginId: "voice", handler: "listen", args: null, caller: USER, input: mic() });
      let result: unknown;
      for (;;) {
        const next = await listen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        partials.push(next.value);
      }
      expect([partials, result]).toEqual([[{ partial: 1 }, { partial: 2 }], { text: "good morning" }]);
      expect(isContractError(await rejection(host.stream({ pluginId: "voice", handler: "notAStream", args: null, caller: USER }).next()), "failed")).toBe(true);
    });

    test("a stream is cancelled by its signal and fails when its worker crashes", async () => {
      const { host } = setup();
      let aborted = false;
      host.define("adapter", {
        turn: async function* (_a: unknown, ctx: HandlerContext) {
          ctx.signal.addEventListener("abort", () => void (aborted = true));
          yield "first";
          await hang();
        },
      });
      const ac = new AbortController();
      const s = host.stream({ pluginId: "adapter", handler: "turn", args: null, caller: USER, signal: ac.signal });
      expect((await s.next()).value).toBe("first");
      const pending = rejection(s.next());
      ac.abort();
      expect(isContractError(await pending, "cancelled")).toBe(true);
      expect(aborted).toBe(true);
      const t = host.stream({ pluginId: "adapter", handler: "turn", args: null, caller: USER });
      expect((await t.next()).value).toBe("first");
      const crashed = rejection(t.next());
      host.crash("adapter");
      expect(isContractError(await crashed, "failed")).toBe(true);
    });
  });
}
