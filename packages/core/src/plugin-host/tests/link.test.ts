// The process link's reader: a read that fails (on Linux a socket pair's end closed with bytes it never read answers
// ECONNRESET, never an EOF) ends the link as its end does, and never escapes as an unhandled rejection.
import { expect, test } from "bun:test";
import { streamPeer } from "../link";

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
