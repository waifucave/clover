// The process link's reader: a read that fails (on Linux a socket pair's end closed with bytes it never read answers
// ECONNRESET, never an EOF) ends the link as its end does, and never escapes as an unhandled rejection.
import { describe, expect, test } from "bun:test";
import { LINK_LINE_MAX, LineTooLong, linesOf, streamPeer } from "../link";

test("a reset on the link's read closes the peer, as an EOF does, and nothing escapes", async () => {
  async function* reset(): AsyncGenerator<string> {
    yield "";
    await Bun.sleep(1);
    throw Object.assign(new Error("connection reset by peer, recv"), { code: "ECONNRESET", syscall: "recv" });
  }
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown) => void escaped.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const peer = streamPeer(reset(), () => {});
    await new Promise<void>((resolve) => peer.onClose(resolve));
    await Bun.sleep(5);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  expect(escaped).toEqual([]);
});

describe("the daemon's end of the link holds no line past its limit (fetch-wire's bodies included)", () => {
  test("a line past the limit ends the stream before more of it is buffered; lines within it pass", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield "short line\n";
      for (let i = 0; i < 1000; i++) yield "x".repeat(1024); // a line that never ends
    }
    const got: string[] = [];
    let err: unknown;
    try {
      for await (const l of linesOf(chunks(), 64 * 1024)) got.push(l);
    } catch (e) {
      err = e;
    }
    expect(got).toEqual(["short line"]);
    expect(err).toBeInstanceOf(LineTooLong);
  });

  test("a stream peer whose other end sends an endless line closes (the process's plugins then crash)", async () => {
    async function* lines(): AsyncGenerator<string> {
      yield* linesOf((async function* () {
        for (let i = 0; i < 1000; i++) yield "y".repeat(1024);
      })(), 64 * 1024);
    }
    const peer = streamPeer(lines(), () => {});
    for (let i = 0; i < 100 && !peer.closed; i++) await new Promise((r) => setTimeout(r, 5));
    expect(peer.closed).toBe(true);
    expect(LINK_LINE_MAX).toBeGreaterThan(Math.ceil((16 * 1024 * 1024 * 4) / 3));
  });
});

describe("the link's lines as the pipe delivers them", () => {
  test("a line split over many chunks, several in one chunk, a character split between chunks, and a last line with no newline", async () => {
    const bytes = new TextEncoder().encode("first\nsec" + "ond é\nthird\n\nlast");
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
    }
    const got: string[] = [];
    for await (const l of linesOf(chunks(), 64)) got.push(l);
    expect(got).toEqual(["first", "second é", "third", "", "last"]);
  });

  test("a long line costs its length, not its length times its chunks: 21 MiB in 64 KiB pieces reads in well under a second", async () => {
    const line = new TextEncoder().encode(`${"x".repeat(21 * 1024 * 1024)}\n`);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < line.length; i += 65536) yield line.subarray(i, i + 65536);
    }
    const t = performance.now();
    let n = 0;
    for await (const l of linesOf(chunks(), LINK_LINE_MAX)) n += l.length;
    expect(n).toBe(21 * 1024 * 1024);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test("a line that ends inside a chunk past the limit is refused too", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield `${"z".repeat(100)}\nok\n`;
    }
    await expect((async () => {
      for await (const _ of linesOf(chunks(), 64)) void _;
    })()).rejects.toBeInstanceOf(LineTooLong);
  });
});

describe("the process's end holds every line it writes to the daemon's limit, measured on the line", () => {
  test("a request past it fails its own call, an answer past it goes as `invalid`, a notification past it is dropped; the link stays open", async () => {
    const written: string[] = [];
    const dropped: string[] = [];
    // The other end's lines: a request whose handler answers too much, then nothing (the stream stays open).
    let release: () => void = () => {};
    const ended = new Promise<void>((r) => { release = r; });
    async function* incoming(): AsyncGenerator<string> {
      yield JSON.stringify({ jsonrpc: "2.0", id: 7, method: "big.answer", params: {} });
      await ended;
    }
    const peer = streamPeer(incoming(), (l) => void written.push(l), { maxSend: 400, dropped: (why) => void dropped.push(why) });
    peer.handle("big.answer", () => ({ text: "a".repeat(1000) }));
    // Any field can carry the size: an option, an id, raw bytes; it's the serialized line that counts.
    await expect(peer.request("pluginHost.fetch", { fetchId: "f".repeat(1000) })).rejects.toMatchObject({ code: "invalid" });
    await expect(peer.request("pluginHost.api", { args: [new Uint8Array(1000)] })).rejects.toMatchObject({ code: "invalid" });
    peer.notify("pluginHost.fetchSend", { fetchId: "f", bytes: new Uint8Array(1000) });
    for (let i = 0; i < 50 && !written.some((l) => l.includes('"id":7')); i++) await Bun.sleep(2);
    const answer = JSON.parse(written.find((l) => l.includes('"id":7'))!);
    expect(answer.error.data.code).toBe("invalid");
    expect(written.every((l) => l.length <= 400)).toBe(true);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("pluginHost.fetchSend");
    expect(peer.closed).toBe(false);
    // Within the limit, everything goes.
    peer.notify("pluginHost.log", { line: "fine" });
    expect(written.at(-1)).toContain("pluginHost.log");
    release();
  });
});
