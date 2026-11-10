// A plugin's net.fetch over a REAL plugin-host link (fetch-wire.ts): the plugin's code in a worker calls
// `api.net.fetch` as it would `fetch`; the daemon's real keyed fetch (B's gate, the model plugins' handler, the pinned
// fetch with its test seam for the loopback backend) sends it; the plugin gets a real Response back. Twice:
//   A. a real plugin-host process (`spawnHostProcess`, the fd-3 JSON link), its daemon-side link tapped;
//   B. the same mux in this process over a loopback link, with a real Worker whose port is tapped too,
// so every message on both legs is seen. The backend echoes the key in a header, in a body split across pieces and in
// a redirect's URL; the key reaches the worker in no form, on neither leg, and in no log.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, HostProcess } from "@waifucave/clover-protocol";
import { networkAllows } from "@waifucave/clover-plugin-sdk";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { SystemClock } from "../../clock/system-clock";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { guardApiRouter } from "../../contracts/plugin-host";
import { modelPluginApiHandlers } from "../../runtime-sdk/model-plugins/plugin-api";
import { createApiRouter } from "../api/router";
import { CorePluginHost, type HostedRecord } from "../core-host";
import { HOST_PROCESS_ENTRY, spawnHostProcess } from "../launch";
import { loopbackPeers, portPeer, type RpcPeer } from "../link";
import { HostMux } from "../mux";
import { pinnedFetch } from "../pinned-fetch";

const USER: Caller = { kind: "user", client: "app" };
const KEY1 = "sk-netfetch-FIRST-0123456789abcdef";
const KEY2 = "sk-netfetch-NEWER-fedcba9876543210";
const MiB = 1024 * 1024;

const HOST_JS = `
const OPTS = { auth: "api-key" };
const seen = async (r) => ({ status: r.status, headers: [...r.headers], text: await r.text() });
const failure = (e) => ({ name: e?.name, code: e?.code, message: String(e?.message ?? e) });
export async function get(args, ctx) {
  try { return await seen(await ctx.api.net.fetch(args.url, args.init ?? {}, OPTS)); } catch (e) { return { error: failure(e) }; }
}
export async function upload(args, ctx) {
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent >= args.n) return c.close(); const k = Math.min(100_000, args.n - sent); c.enqueue(new Uint8Array(k).fill(7)); sent += k; } });
  const r = await ctx.api.net.fetch(args.url, { method: "POST", body, headers: { "content-type": "application/octet-stream" } }, OPTS);
  return await r.json();
}
export async function download(args, ctx) {
  const r = await ctx.api.net.fetch(args.url, {}, OPTS);
  const reader = r.body.getReader();
  let got = 0;
  for (;;) { const x = await reader.read(); if (x.done) break; got += x.value.length; }
  return { got, type: r.headers.get("content-type") };
}
export async function abort(args, ctx) {
  const ac = new AbortController();
  const r = await ctx.api.net.fetch(args.url, { signal: ac.signal }, OPTS);
  const reader = r.body.getReader();
  await reader.read();
  ac.abort();
  try { await reader.read(); return "read on"; } catch (e) { return e.name; }
}
export async function unread(args, ctx) {
  // The plugin's own mistake, 32 times: a non-ok response thrown away unread.
  const statuses = [];
  for (let i = 0; i < 32; i++) { const r = await ctx.api.net.fetch(args.url, {}, OPTS); statuses.push(r.status); }
  await new Promise((r) => setTimeout(r, args.waitMs));
  try { const r = await ctx.api.net.fetch(args.url, {}, OPTS); statuses.push(r.status); } catch (e) { statuses.push(String(e?.message ?? e)); }
  return statuses;
}
export async function whole(args, ctx) {
  try { await ctx.api.net.fetch(args.url, { method: "POST", body: new Uint8Array(args.n) }, OPTS); return "sent"; } catch (e) { return failure(e); }
}
`;

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The backend on loopback: what each request did, for the assertions. */
const backend = {
  authSeen: [] as string[],
  uploaded: 0,
  aborted: false,
  port: 0,
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
};

function slowly(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({ pull(c) { if (at >= bytes.length) return c.close(); c.enqueue(bytes.slice(at, at + size)); at += size; } });
}

beforeAll(() => {
  backend.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      backend.authSeen.push(auth);
      switch (url.pathname) {
        case "/echo":
          // The key in a header, and in the body split across 7-byte pieces.
          return new Response(slowly(`you sent ${auth}; again ${auth}!`, 7), { headers: { "x-echo": auth, "x-fine": "yes", "content-type": "text/plain" } });
        case "/redirect":
          return new Response(null, { status: 302, headers: { location: `/landing?k=${encodeURIComponent(auth.replace(/^Bearer /, ""))}`.replace(/%2D/g, "-") } });
        case "/landing":
          return new Response(`landed at ${url.pathname}${url.search}`);
        case "/away":
          return new Response(null, { status: 302, headers: { location: `http://127.0.0.2:${backend.port}/x` } });
        case "/needs-newer":
          return auth === `Bearer ${KEY2}` ? new Response("welcome") : new Response("no", { status: 401 });
        case "/upload": {
          let n = 0;
          for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) n += chunk.length;
          backend.uploaded = n;
          return Response.json({ bytes: n });
        }
        case "/big": {
          let left = Number(url.searchParams.get("n"));
          return new Response(new ReadableStream({ pull(c) { if (left <= 0) return c.close(); const k = Math.min(65_536, left); c.enqueue(new Uint8Array(k).fill(1)); left -= k; } }), { headers: { "content-type": "application/octet-stream" } });
        }
        case "/busy":
          // A 429 whose body (1 MiB, past one credit window) the plugin never reads.
          return new Response(new Uint8Array(1024 * 1024), { status: 429 });
        case "/hang":
          req.signal.addEventListener("abort", () => { backend.aborted = true; });
          // A first piece big enough that the server sends the head at once, then nothing: the body stays open.
          return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65_536)); } }));
        default:
          return new Response("not here", { status: 404 });
      }
    },
  });
  backend.port = backend.server.port!;
});
afterAll(() => backend.server?.stop(true));

/** The plugin's folder, its registry record (bundled, `network:127.0.0.1:<port>`, an api-key entry) and B's gate. */
function world() {
  const folder = mkdtempSync(join(tmpdir(), "clover-netfetch-"));
  temps.push(folder);
  mkdirSync(join(folder, "host"));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  const child = {
    manifest: 1, name: "Net probe", capabilities: [`network:127.0.0.1:${backend.port}`],
    host: { entry: "host/index.js", runtime: "bun" },
    contributes: { models: [{ provider: "netprobe", name: "Net probe", catalog: [], auth: [{ method: "api-key", secret: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: `http://127.0.0.1:${backend.port}/v1` } }] },
  };
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [
      { id: "clover", manifest: { manifest: 1, id: "clover", name: "Clover" } as never, source: "bundled" },
      { id: "clover/netprobe", manifest: child as never, source: "bundled" },
      { id: "clover/netprobe-two", manifest: { ...child, name: "Net probe two" } as never, source: "bundled" },
      // A third-party plugin with the same granted `network:` entry and auth entry.
      { id: "acme-net", manifest: { ...child, id: "acme-net", name: "Acme net" } as never, source: "local" },
    ],
  });
  const handlers = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => ({ value: KEY1, generation: 1 }), newer: async (g) => (g < 2 ? { value: KEY2, generation: 2 } : null) }),
    secret: async () => undefined,
    // The pinned fetch, with only the test's loopback backend reachable (the seam production never passes).
    fetch: pinnedFetch({ reach: (_host, address) => address === "127.0.0.1" }),
  });
  // B's gate as the daemon builds it (daemon-host.ts): `net.fetch` only to the granted hosts.
  const gate = createApiRouter({ registry, handlers: [handlers], allowNetwork: (caps, host, port) => networkAllows(caps, host, port) });
  const router = guardApiRouter(gate, (id) => {
    const r = registry.get(id);
    return r === undefined ? undefined : { id: r.id, source: r.source };
  });
  const records = new Map<string, HostedRecord>([
    ["clover/netprobe", { id: "clover/netprobe", source: "bundled", folder, entry: "host/index.js", dataFolder: join(folder, "data") }],
    ["clover/netprobe-two", { id: "clover/netprobe-two", source: "bundled", folder, entry: "host/index.js", dataFolder: join(folder, "data-two") }],
    ["acme-net", { id: "acme-net", source: "local", folder, entry: "host/index.js", dataFolder: join(folder, "data-acme") }],
  ]);
  return { router, records };
}

/** Every message on a link end, both ways, results and errors included. */
function tap(peer: RpcPeer, log: unknown[], leg: string): RpcPeer {
  return {
    request: (m, p) => {
      log.push([leg, "out", m, p]);
      return peer.request(m, p).then((r) => (log.push([leg, "in-result", m, r]), r), (e: unknown) => { log.push([leg, "in-error", m, String((e as Error)?.message), (e as { detail?: unknown })?.detail]); throw e; });
    },
    notify: (m, p) => {
      log.push([leg, "out", m, p]);
      peer.notify(m, p);
    },
    handle: (m, fn) =>
      peer.handle(m, async (p: unknown) => {
        log.push([leg, "in", m, p]);
        try {
          const r = await fn(p);
          log.push([leg, "out-result", m, r]);
          return r;
        } catch (e) {
          log.push([leg, "out-error", m, String((e as Error)?.message), (e as { detail?: unknown })?.detail]);
          throw e;
        }
      }),
    onClose: (fn) => peer.onClose(fn),
    close: () => peer.close(),
    get closed() {
      return peer.closed;
    },
  };
}

const dump = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x));

async function scenario(host: CorePluginHost, base: string) {
  const call = <T>(handler: string, args: unknown) => host.invoke<T>({ pluginId: "clover/netprobe", handler, args, caller: USER, timeoutMs: 120_000 });
  type Seen = { status: number; headers: [string, string][]; text: string; error?: { name: string; code: string; message: string } };
  const echo = await call<Seen>("get", { url: `${base}/echo` });
  expect(echo.status).toBe(200);
  expect(echo.headers.find(([n]) => n === "x-echo")).toBeUndefined();
  expect(echo.headers.find(([n]) => n === "x-fine")?.[1]).toBe("yes");
  const masked = `Bearer ${"*".repeat(KEY1.length)}`;
  expect(echo.text).toBe(`you sent ${masked}; again ${masked}!`);
  // A same-origin redirect whose URL carries the key: followed, and what the landing echoes is masked.
  const landed = await call<Seen>("get", { url: `${base}/redirect` });
  expect(landed.status).toBe(200);
  expect(landed.text).toBe(`landed at /landing?k=${"*".repeat(KEY1.length)}`);
  // A 401 gets one retry with the newer token, which the plugin never sees either.
  expect((await call<Seen>("get", { url: `${base}/needs-newer` })).text).toBe("welcome");
  // The keyed fetch's refusals keep their codes across the link.
  expect((await call<Seen>("get", { url: `${base}/away` })).error).toMatchObject({ name: "KeyedFetchError", code: "redirect_refused" });
  expect((await call<Seen>("get", { url: `${base}/echo`, init: { headers: { authorization: "Bearer mine" } } })).error).toMatchObject({ name: "KeyedFetchError", code: "credential_header" });
  // A host the plugin's OK doesn't grant: B's gate refuses it before the keyed fetch sees it.
  expect((await call<Seen>("get", { url: `http://localhost:${backend.port}/echo` })).error).toMatchObject({ name: "ContractError", code: "refused" });
  // A body given whole past 16 MiB is the daemon's refusal; 5 MiB streamed up and 20 MiB streamed down go through.
  expect(await call("whole", { url: `${base}/upload`, n: 16 * MiB + 1 })).toMatchObject({ name: "ContractError", code: "invalid" });
  expect(await call("upload", { url: `${base}/upload`, n: 5 * MiB })).toEqual({ bytes: 5 * MiB });
  expect(backend.uploaded).toBe(5 * MiB);
  expect(await call("download", { url: `${base}/big?n=${20 * MiB}` })).toEqual({ got: 20 * MiB, type: "application/octet-stream" });
  // The plugin's abort reaches the server.
  backend.aborted = false;
  expect(await call("abort", { url: `${base}/hang` })).toBe("AbortError");
  for (let i = 0; i < 100 && !backend.aborted; i++) await Bun.sleep(20);
  expect(backend.aborted).toBe(true);
  expect(backend.authSeen).toContain(`Bearer ${KEY2}`);
  return [echo, landed];
}

function keyFree(...things: unknown[]): void {
  const text = things.map(dump).join("\n");
  expect(text.includes(KEY1)).toBe(false);
  expect(text.includes(KEY2)).toBe(false);
}

describe("net.fetch over a real plugin-host link", () => {
  test("A. a plugin-host process: every case, and the key on no message of the daemon's link and in no log", async () => {
    const w = world();
    const wire: unknown[] = [];
    const logs: unknown[] = [];
    const out: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((l) => spyOn(console, l).mockImplementation((...a: unknown[]) => void logs.push(a)));
    const processes: { kill(): void }[] = [];
    const links = new Map<string, RpcPeer>();
    try {
      const host = new CorePluginHost({
        clock: new SystemClock(), computer: "Studio", record: (id) => w.records.get(id),
        connect: (process: HostProcess) => {
          let peer = links.get(process);
          if (peer === undefined || peer.closed) {
            const p = spawnHostProcess({ cmd: [globalThis.process.execPath, HOST_PROCESS_ENTRY], env: { ...(globalThis.process.env as Record<string, string>), CLOVER_COMPUTER: "Studio" }, onOutput: (l) => void out.push(l) });
            processes.push(p);
            links.set(process, (peer = tap(p.peer, wire, "daemon-link")));
          }
          return peer;
        },
        log: (id, lines) => void logs.push([id, ...lines]),
      });
      host.serveApi(w.router);
      const seen = await scenario(host, `http://127.0.0.1:${backend.port}`);
      expect(wire.some((m) => (m as unknown[])[2] === "pluginHost.fetchBody")).toBe(true);
      keyFree(wire, seen, logs, out);
    } finally {
      for (const s of spies) s.mockRestore();
      for (const p of processes) p.kill();
    }
  }, 120_000);

  test("B. the mux in this process with a real Worker: the key on no message of either leg (daemon's link, worker's port)", async () => {
    const w = world();
    const wire: unknown[] = [];
    const logs: unknown[] = [];
    const workers: Worker[] = [];
    const [daemonEnd, processEnd] = loopbackPeers();
    const entry = new URL("../worker-main.ts", import.meta.url).href;
    const mux = new HostMux({
      daemon: processEnd,
      spawnWorker: () => {
        const worker = new Worker(entry, { workerData: { computer: "Studio" } } as WorkerOptions);
        workers.push(worker);
        const exits: ((reason: string) => void)[] = [];
        worker.addEventListener("close", () => { for (const fn of exits) fn("the worker exited"); });
        const port = {
          postMessage: (m: unknown) => { wire.push(["worker-port", "to-worker", m]); worker.postMessage(m); },
          addEventListener: (type: "message", fn: (e: { data: unknown }) => void) => worker.addEventListener(type, (e) => { wire.push(["worker-port", "from-worker", (e as MessageEvent).data]); fn(e as MessageEvent); }),
        };
        return { peer: portPeer(port), terminate: () => worker.terminate(), onExit: (fn) => void exits.push(fn) };
      },
    });
    const spies = (["log", "error", "warn", "info"] as const).map((l) => spyOn(console, l).mockImplementation((...a: unknown[]) => void logs.push(a)));
    try {
      const host = new CorePluginHost({
        clock: new SystemClock(), computer: "Studio", record: (id) => w.records.get(id),
        connect: () => tap(daemonEnd, wire, "daemon-link"),
        log: (id, lines) => void logs.push([id, ...lines]),
      });
      host.serveApi(w.router);
      const seen = await scenario(host, `http://127.0.0.1:${backend.port}`);
      expect(wire.some((m) => (m as unknown[])[0] === "worker-port" && dump(m).includes("pluginHost.fetchBody"))).toBe(true);
      keyFree(wire, seen, logs);
    } finally {
      for (const s of spies) s.mockRestore();
      mux.close();
      for (const wk of workers) wk.terminate();
    }
  }, 120_000);

  test("C. over a real process: an oversized body fails that call and the link stays up; 33 unread responses and the 33rd still goes out; a third-party plugin is refused", async () => {
    const w = world();
    const processes: { kill(): void }[] = [];
    const links = new Map<string, RpcPeer>();
    const host = new CorePluginHost({
      clock: new SystemClock(), computer: "Studio", record: (id) => w.records.get(id),
      connect: (process: HostProcess) => {
        let peer = links.get(process);
        if (peer === undefined || peer.closed) {
          const p = spawnHostProcess({ cmd: [globalThis.process.execPath, HOST_PROCESS_ENTRY], env: { ...(globalThis.process.env as Record<string, string>), CLOVER_COMPUTER: "Studio" } });
          processes.push(p);
          links.set(process, (peer = p.peer));
        }
        return peer;
      },
      // The daemon's credit wait, short for the test (60 s in production).
      fetchLimits: { creditWaitMs: 300 },
    });
    host.serveApi(w.router);
    const base = `http://127.0.0.1:${backend.port}`;
    const call = <T>(pluginId: string, handler: string, args: unknown) => host.invoke<T>({ pluginId, handler, args, caller: USER, timeoutMs: 120_000 });
    try {
      // Both bundled plugins run in the one clover process.
      expect((await call<{ status: number }>("clover/netprobe-two", "get", { url: `${base}/echo` })).status).toBe(200);
      // 20 MiB given whole would be a line past the link's limit as base64: the worker refuses it, naming the cap.
      expect(await call("clover/netprobe", "whole", { url: `${base}/upload`, n: 20 * MiB })).toMatchObject({ name: "ContractError", code: "invalid", message: expect.stringContaining("16777216 bytes") });
      expect(links.get("clover")?.closed).toBe(false);
      expect(host.status("clover/netprobe")).toMatchObject({ state: "running", crashes: 0 });
      expect(host.status("clover/netprobe-two")).toMatchObject({ state: "running", crashes: 0 });
      expect((await call<{ status: number }>("clover/netprobe-two", "get", { url: `${base}/echo` })).status).toBe(200);
      // 32 non-ok responses dropped unread hold every slot; past the credit wait the 33rd still goes out.
      const statuses = await call<(number | string)[]>("clover/netprobe", "unread", { url: `${base}/busy`, waitMs: 600 });
      expect(statuses).toHaveLength(33);
      expect(statuses.every((s) => s === 429)).toBe(true);
      // A third-party plugin with a granted network: entry: its keyed fetch is refused, bundled plugins only.
      const acme = await call<{ error?: { name: string; code: string; message: string } }>("acme-net", "get", { url: `${base}/echo` });
      expect(acme.error).toMatchObject({ name: "ContractError", code: "refused", message: expect.stringContaining("bundled plugins only") });
    } finally {
      for (const p of processes) p.kill();
    }
  }, 120_000);
});
