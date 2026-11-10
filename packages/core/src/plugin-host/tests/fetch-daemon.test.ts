// The daemon's end of a plugin's net.fetch (fetch-daemon.ts) against a misbehaving peer: every limit is the daemon's,
// whatever the plugin-host process sends. The messages are driven straight at the channel, as a compromised process
// could send them (the mux in the process is no trust boundary).
import { describe, expect, test } from "bun:test";
import type { ApiRouter } from "../../contracts/plugin-host";
import { FETCH_LIMITS } from "../fetch-wire";
import { fetchChannel } from "../fetch-daemon";
import { InvocationTable } from "../invocations";

const CORE = { caller: { kind: "core" } } as never;

/** A router whose `net.fetch` answers what `answer` gives; records each request's init. */
function harness(answer: (url: string, init: RequestInit) => Promise<Response> | Response, limits?: Parameters<typeof fetchChannel>[0]["limits"]) {
  const sent: { m: string; p: Record<string, unknown> }[] = [];
  const inits: RequestInit[] = [];
  const router: ApiRouter = async (call) => {
    if (call.path !== "net.fetch") throw new Error(`unexpected ${call.path}`);
    const [url, init] = call.args as [string, RequestInit];
    inits.push(init);
    return answer(url, init);
  };
  const ch = fetchChannel({ process: "clover", router, invocations: new InvocationTable(), send: (m, p) => sent.push({ m, p: p as Record<string, unknown> }), ...(limits !== undefined ? { limits } : {}) });
  const call = (m: string, p: Record<string, unknown>) => ch.methods[m]!(p, CORE);
  const head = (pluginId: string, fetchId: string, extra: Record<string, unknown> = {}) => call("pluginHost.fetch", { pluginId, fetchId, url: "https://api.example.com/x", method: "GET", headers: [], ...extra });
  return { ch, sent, inits, call, head };
}

/** A request that waits until it is aborted (its upstream never answers). */
const hanging = (_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) return reject(init.signal.reason);
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });

const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error & { data?: { code?: string } });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the daemon's fetch limits, against a misbehaving peer", () => {
  test("a body given whole past 16 MiB, headers past 256 pairs or 64 KiB, and a URL past 16 K characters are refused before any request", async () => {
    const h = harness(() => new Response("never"));
    const big = new Uint8Array(FETCH_LIMITS.bodyBytes + 1);
    expect((await rejection(h.head("clover/aa", "f1", { method: "POST", body: big })))?.message).toContain("at most 16777216 bytes");
    const pairs = Array.from({ length: 257 }, (_, i) => [`x-h${i}`, "v"]);
    expect(await rejection(h.head("clover/aa", "f2", { headers: pairs }))).toBeDefined();
    expect((await rejection(h.head("clover/aa", "f3", { headers: [["x-big", "v".repeat(40_000)], ["x-big2", "v".repeat(30_000)]] })))?.message).toContain("at most 65536 bytes");
    expect(await rejection(h.head("clover/aa", "f4", { url: `https://api.example.com/${"a".repeat(17_000)}` }))).toBeDefined();
    expect(await rejection(h.head("clover/aa", "f5", { body: new Uint8Array(1), upload: true }))).toBeDefined();
    expect(h.inits).toEqual([]);
    expect(h.ch.open).toBe(0);
    // Exactly 16 MiB is taken.
    await h.head("clover/aa", "f6", { method: "POST", body: new Uint8Array(FETCH_LIMITS.bodyBytes) });
    expect(h.inits).toHaveLength(1);
  });

  test("32 fetches per plugin and 128 per process: the next is refused; another plugin still fits until the process is full", async () => {
    const h = harness(hanging);
    const opened: Promise<unknown>[] = [];
    for (let i = 0; i < 32; i++) opened.push(rejection(h.head("clover/aa", `a${i}`)));
    await tick();
    expect((await rejection(h.head("clover/aa", "a32")))?.message).toContain("32 fetches open");
    for (const p of ["clover/bb", "clover/cc", "clover/dd"]) for (let i = 0; i < 32; i++) opened.push(rejection(h.head(p, `${p}-${i}`)));
    await tick();
    expect(h.ch.open).toBe(128);
    expect((await rejection(h.head("clover/ee", "e0")))?.message).toContain("128 fetches open");
    h.ch.closeAll();
    await Promise.all(opened);
    expect(h.ch.open).toBe(0);
  });

  test("every way a fetch ends releases its slot: end, upstream error, cancel, refused head, cut-off, close", async () => {
    let mode = "end";
    const h = harness(async (_url, init) => {
      if (mode === "refused") throw Object.assign(new Error("host_not_declared"), { code: "host_not_declared" });
      if (mode === "error") return new Response(new ReadableStream({ pull(c) { c.error(new Error("upstream broke")); } }));
      if (mode === "nobody") return new Response(null, { status: 204 });
      if (mode === "upload-cut" || mode === "cancel" || mode === "close") {
        // Reads the upload (or waits): the fetch stays open until the peer's misstep, its cancel, or the close.
        const body = init.body as ReadableStream<Uint8Array> | undefined;
        if (body) await new Response(body).arrayBuffer().catch(() => {});
        return hanging(_url, init);
      }
      return new Response("done");
    });
    let n = 0;
    for (const m of ["end", "error", "refused", "nobody", "cancel", "upload-cut", "close", "end"]) {
      mode = m;
      for (let i = 0; i < 6; i++) {
        const id = `${m}-${n++}`;
        if (m === "cancel") {
          const p = rejection(h.head("clover/aa", id));
          await tick();
          await h.call("pluginHost.fetchCancel", { pluginId: "clover/aa", fetchId: id });
          await p;
        } else if (m === "upload-cut") {
          const p = rejection(h.head("clover/aa", id, { method: "POST", upload: true }));
          await tick();
          // Past the credit: no credit was given yet for this piece's size.
          await h.call("pluginHost.fetchSend", { pluginId: "clover/aa", fetchId: id, seq: 0, bytes: new Uint8Array(FETCH_LIMITS.window + 1) });
          await p;
        } else if (m === "close") {
          const p = rejection(h.head("clover/aa", id));
          await tick();
          h.ch.closeAll();
          await p;
        } else {
          const head = await rejection(h.head("clover/aa", id)).catch(() => undefined);
          void head;
          await tick();
          await tick();
        }
      }
    }
    await tick();
    expect(h.ch.open).toBe(0);
    // A fresh fetch still fits: nothing leaked.
    mode = "end";
    for (let i = 0; i < 32; i++) await h.head("clover/aa", `fresh-${i}`).catch(() => undefined);
  });

  test("an upload past its credit, a piece past 64 KiB, one out of order, or one after its end cuts the fetch off; never buffered", async () => {
    for (const misstep of ["credit", "size", "order", "after-end"] as const) {
      // The upstream takes the first piece, then reads no more: what the peer sends next queues within its credit.
      const h = harness(async (url, init) => {
        await (init.body as ReadableStream<Uint8Array>).getReader().read();
        return hanging(url, init);
      });
      const p = rejection(h.head("clover/aa", "up", { method: "POST", upload: true }));
      // The platform fetch pulls: the daemon gives the first window.
      for (let i = 0; i < 20 && !h.sent.some((s) => s.m === "pluginHost.fetchSendCredit"); i++) await tick();
      expect(h.sent.find((s) => s.m === "pluginHost.fetchSendCredit")?.p.bytes).toBe(FETCH_LIMITS.window);
      const send = (seq: number, bytes?: Uint8Array, end?: boolean) => h.call("pluginHost.fetchSend", { pluginId: "clover/aa", fetchId: "up", seq, ...(bytes ? { bytes } : {}), ...(end ? { end } : {}) });
      if (misstep === "credit") {
        for (let i = 0; i < 4; i++) await send(i, new Uint8Array(FETCH_LIMITS.chunkBytes));
        await send(4, new Uint8Array(1)); // the window is used up
      } else if (misstep === "size") await send(0, new Uint8Array(FETCH_LIMITS.chunkBytes + 1));
      else if (misstep === "order") {
        await send(0, new Uint8Array(10));
        await send(2, new Uint8Array(10));
      } else {
        await send(0, new Uint8Array(10), true);
        await send(1, new Uint8Array(10));
      }
      const err = await p;
      expect(err?.message).toMatch(/past the credit|at most 65536|out of order|after its end/);
      expect(h.ch.open).toBe(0);
      expect(h.inits[0]?.signal?.aborted).toBe(true);
    }
  });

  test("the body goes back within the worker's credit: without credit no more than a window, an inflated credit still a window", async () => {
    let pulled = 0;
    const h = harness(() => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 16_384;
        c.enqueue(new Uint8Array(16_384));
        if (pulled >= 4 * 1024 * 1024) c.close();
      },
    }, { highWaterMark: 0 })));
    const head = (await h.head("clover/aa", "dl")) as { body: boolean };
    expect(head.body).toBe(true);
    for (let i = 0; i < 50; i++) await tick();
    const bodyBytes = () => h.sent.filter((s) => s.m === "pluginHost.fetchBody").reduce((n, s) => n + ((s.p.bytes as Uint8Array | undefined)?.length ?? 0), 0);
    expect(bodyBytes()).toBe(FETCH_LIMITS.window);
    expect(pulled).toBeLessThanOrEqual(FETCH_LIMITS.window + 2 * 16_384);
    // A worker that grants a huge credit: still one window more at most.
    await h.call("pluginHost.fetchCredit", { pluginId: "clover/aa", fetchId: "dl", bytes: 1_000_000_000 });
    for (let i = 0; i < 50; i++) await tick();
    expect(bodyBytes()).toBe(2 * FETCH_LIMITS.window);
    // Every piece is at most 64 KiB, in order.
    const pieces = h.sent.filter((s) => s.m === "pluginHost.fetchBody");
    expect(pieces.every((s) => ((s.p.bytes as Uint8Array | undefined)?.length ?? 0) <= FETCH_LIMITS.chunkBytes)).toBe(true);
    expect(pieces.map((s) => s.p.seq)).toEqual(pieces.map((_, i) => i));
    h.ch.closeAll();
  });

  test("a fetch id another plugin opened: its head refused, and that plugin's body messages, credit and cancel change nothing", async () => {
    const h = harness(async (_url, init) => {
      const text = await new Response(init.body as ReadableStream).text();
      return new Response(text);
    });
    const p = h.head("clover/aa", "mine", { method: "POST", upload: true });
    for (let i = 0; i < 20 && !h.sent.some((s) => s.m === "pluginHost.fetchSendCredit"); i++) await tick();
    expect((await rejection(h.head("clover/bb", "mine")))?.message).toContain("is open");
    // clover/b sends into it, cancels it, grants credit: nothing.
    await h.call("pluginHost.fetchSend", { pluginId: "clover/bb", fetchId: "mine", seq: 0, bytes: new TextEncoder().encode("evil"), end: true });
    await h.call("pluginHost.fetchCancel", { pluginId: "clover/bb", fetchId: "mine" });
    await h.call("pluginHost.fetchCredit", { pluginId: "clover/bb", fetchId: "mine", bytes: 5 });
    expect(h.ch.open).toBe(1);
    await h.call("pluginHost.fetchSend", { pluginId: "clover/aa", fetchId: "mine", seq: 0, bytes: new TextEncoder().encode("good"), end: true });
    expect(((await p) as { status: number }).status).toBe(200);
    for (let i = 0; i < 20; i++) await tick();
    const body = h.sent.filter((s) => s.m === "pluginHost.fetchBody" && s.p.fetchId === "mine");
    expect(Buffer.concat(body.flatMap((s) => (s.p.bytes ? [s.p.bytes as Uint8Array] : []))).toString()).toBe("good");
    expect(body.at(-1)?.p.end).toBe(true);
  });

  test("a keyed fetch's failure keeps its code in the error's detail; a cancel aborts the request upstream", async () => {
    const h = harness(async (url, init) => {
      if (url.endsWith("/refused")) throw Object.assign(new Error("api.evil.com is not one of this plugin's network hosts"), { name: "KeyedFetchError", code: "host_not_declared" });
      return hanging(url, init);
    });
    const err = await rejection(h.call("pluginHost.fetch", { pluginId: "clover/aa", fetchId: "r", url: "https://api.evil.com/refused", method: "GET", headers: [] }));
    expect((err as { detail?: { fetch?: string } })?.detail?.fetch).toBe("host_not_declared");
    const p = rejection(h.head("clover/aa", "c"));
    await tick();
    await h.call("pluginHost.fetchCancel", { pluginId: "clover/aa", fetchId: "c" });
    expect(await p).toBeDefined();
    expect(h.inits.at(-1)?.signal?.aborted).toBe(true);
  });

  test("a body nobody reads (no credit back) is held at most the credit wait: then it ends, its slot freed, the worker told why", async () => {
    const h = harness(() => new Response(new Uint8Array(1024 * 1024), { status: 429 }), { creditWaitMs: 100 });
    for (let i = 0; i < 32; i++) expect(((await h.head("clover/aa", `u${i}`)) as { status: number }).status).toBe(429);
    for (let i = 0; i < 20; i++) await tick();
    // 32 open, each waiting for credit after its first window: the 33rd is refused now...
    expect((await rejection(h.head("clover/aa", "u32")))?.message).toContain("32 fetches open");
    await new Promise((r) => setTimeout(r, 250));
    // ...and goes out once the wait has ended them.
    expect(h.ch.open).toBe(0);
    expect(((await h.head("clover/aa", "u33")) as { status: number }).status).toBe(429);
    const errors = h.sent.filter((s) => s.m === "pluginHost.fetchBody" && s.p.error !== undefined);
    expect(errors).toHaveLength(32);
    expect((errors[0]!.p.error as { code: string; message: string })).toMatchObject({ code: "timeout", message: expect.stringContaining("nobody read the response body") });
    h.ch.closeAll();
  });
});
