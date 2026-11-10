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
