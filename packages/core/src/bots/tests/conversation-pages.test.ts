// `bot.conversation`'s paging, as MOSS pages back through a long conversation (round 4 of lane MA): the cursor a client
// needs is there already. A page's events carry their `seq`; the next page is asked for `before` the first one's, and
// `hasMore` says whether anything is older. Walked to the start over thousands of events: each once, in order.
import { afterEach, describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };

describe("bot.conversation's pages", () => {
  test("before the first event's seq, page after page, reaches the start: every event once, in order, and then no more", { timeout: 30_000 }, async () => {
    const b = await boot({ home: tempDir(), clock: new FakeClock(), plugins: [], botSource: "records", modelOffer: () => "offered" });
    const all = b.side.methods({ localDevice: "studio0000000000000" });
    const call = (params: unknown) => all["bot.conversation"]!(params, { caller: USER } as never) as Promise<{ events: { seq: number; type: string; text?: string }[]; hasMore: boolean }>;
    await all["bot.create"]!({ name: "Chronicle" }, { caller: USER } as never);
    // 2,000 events, 20 pages (each record is written durably, about a millisecond apiece on a busy machine, so the
    // setup is kept small; the 20,000-event walk is the acceptance row's, MOSS_LONG_STEP).
    const n = 2_000;
    for (let i = 1; i <= n; i++) b.host.recordCore("b_chronicle", { type: "assistant_message", threadId: "b_chronicle", text: `m${i}` });
    const seen: number[] = [];
    const texts: string[] = [];
    let before: number | undefined;
    let pages = 0;
    const t0 = performance.now();
    for (;;) {
      const page = await call({ id: "chronicle", limit: 100, ...(before === undefined ? {} : { before }) });
      pages++;
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.length).toBeLessThanOrEqual(100);
      seen.unshift(...page.events.map((e) => e.seq));
      texts.unshift(...page.events.filter((e) => e.type === "assistant_message").map((e) => e.text!));
      if (!page.hasMore) break;
      before = page.events[0]!.seq;
    }
    const ms = performance.now() - t0;
    // Each event once, in order, with no gap: seq is the log's own index.
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[seen.length - 1]! - seen[0]! + 1).toBe(seen.length);
    expect(texts.slice(-n)).toEqual(Array.from({ length: n }, (_, i) => `m${i + 1}`));
    expect(pages).toBeGreaterThanOrEqual(n / 100);
    // A page back costs about the same at the start as at the end (each reads its own records, not the whole log).
    expect(ms / pages).toBeLessThan(50);
    await b.shutdown();
  });
});
