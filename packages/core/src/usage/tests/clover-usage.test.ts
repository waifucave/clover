// Counting Clover's own turns (../counter.ts, ../ledger.ts, ../rpc.ts): one row per model per turn, per bot and per
// session, side threads included, counted once even across a restart, and read back through `usage.rows` and
// `usage.summary`.
import { afterEach, describe, expect, test } from "bun:test";
import { ERR, USAGE_METHODS, UsageRow } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "../../bots/tests/fixtures";
import { MethodError } from "../../bots/rpc";
import { CloverUsageCounter } from "../counter";
import { cloverUsageDbPath, UsageLedger } from "../ledger";
import { usageMethods } from "../rpc";

afterEach(removeTemps);

const user = (text: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: `m-${text}` });

async function twoBots(home: string, clock: FakeClock) {
  const root = tempDir();
  const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
  const plugins = [...(await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, ...(await pluginFromFolder(luna)).inputs];
  return boot({ home, clock, plugins });
}

function counterFor(b: Awaited<ReturnType<typeof twoBots>>, changes: number[] = []) {
  const ledger = new UsageLedger({ path: cloverUsageDbPath(b.home), computer: "Studio" });
  const counter = new CloverUsageCounter({
    ledger, host: b.host, onChange: (since) => changes.push(since),
    price: ({ model, inputTokens, outputTokens }) => (model.startsWith("anthropic/") ? (inputTokens * 3 + outputTokens * 15) / 1_000_000 : undefined),
  });
  counter.start();
  return { ledger, counter };
}

describe("Clover's usage", () => {
  test("each turn counts per model, per bot and per session, side threads under their bot", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const b = await twoBots(home, clock);
    const changes: number[] = [];
    const { ledger, counter } = counterFor(b, changes);

    // Alpha: a turn on two models, as the runtime reports it.
    await b.host.sendUser("b_alpha", user("plan the trip"));
    await flush();
    const alpha = b.drivers.for("b_alpha");
    alpha.emit({ type: "turn_usage", model: "anthropic/claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 50_000 });
    alpha.emit({ type: "turn_usage", model: "openai/gpt-6.1-sol", provider: "openai", inputTokens: 300, outputTokens: 40, costUsd: 0.01 });
    alpha.end({ text: "Here's a plan.", usage: { inputTokens: 1_300, outputTokens: 240 } });
    await flush();
    // Luna: a turn with only the turn's own usage, under the session's model.
    clock.advance(60_000);
    await b.host.sendUser("b_luna", user("hi"));
    await flush();
    b.drivers.for("b_luna").end({ text: "hey", usage: { inputTokens: 80, outputTokens: 5 } });
    await flush();
    // A routine's side thread of Alpha's.
    const run = b.bots.runSideThread("alpha", { routine: "r_1", name: "Check", text: "Check things." });
    await flush();
    const side = b.drivers.made.at(-1)!;
    side.driver.emit({ type: "turn_usage", model: "anthropic/claude-sonnet-5-5", inputTokens: 500, outputTokens: 60 });
    side.driver.end({ text: "All fine." });
    await run;

    expect(ledger.totals({ bot: "alpha" })).toMatchObject({ rows: 3, inputTokens: 1_800, outputTokens: 300, cacheReadTokens: 50_000 });
    expect(ledger.totals({ session: "b_alpha" })).toMatchObject({ rows: 2, inputTokens: 1_300, outputTokens: 240 });
    expect(ledger.totals({ session: side.ctx.sessionId })).toMatchObject({ rows: 1, inputTokens: 500, outputTokens: 60 });
    expect(ledger.totals({ bot: "luna" })).toMatchObject({ rows: 1, inputTokens: 80, outputTokens: 5 });
    const rows = ledger.rows({ since: 0 }).rows;
    for (const r of rows) UsageRow.parse(r);
    expect(rows.map((r) => [r.id, r.bot, r.session, r.model, r.provider])).toEqual([
      ["Studio:1", "alpha", "b_alpha", "anthropic/claude-sonnet-5-5", "anthropic"],
      ["Studio:2", "alpha", "b_alpha", "openai/gpt-6.1-sol", "openai"],
      ["Studio:3", "luna", "b_luna", "fireworks/kimi-k3", "fireworks"],
      ["Studio:4", "alpha", side.ctx.sessionId, "anthropic/claude-sonnet-5-5", "anthropic"],
    ]);
    // The runtime's own price stands; the rest are priced from the catalog where it can.
    expect(rows[0]!.costUsd).toBeCloseTo((1_000 * 3 + 200 * 15) / 1_000_000, 10);
    expect(rows[1]!.costUsd).toBe(0.01);
    expect(rows[2]!.costUsd).toBeUndefined();
    expect(changes.length).toBeGreaterThan(0);
    expect(ledger.summary({ from: 0, to: clock.now() + 1, groupBy: "bot" }).map((g) => [g.key, g.inputTokens])).toEqual([["alpha", 1_800], ["luna", 80]]);
    expect(ledger.summary({ from: 0, to: clock.now() + 1, groupBy: "session", bot: "alpha" }).map((g) => g.key).sort()).toEqual(["b_alpha", side.ctx.sessionId].sort());
    counter.stop();
    ledger.close();
    await b.shutdown();
  });

  test("a turn that ended while nothing was counting is counted on the next start, once", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const b = await twoBots(home, clock);
    const { ledger, counter } = counterFor(b);
    counter.stop();
    await b.host.sendUser("b_alpha", user("hi"));
    await flush();
    b.drivers.for("b_alpha").emit({ type: "turn_usage", model: "anthropic/claude-sonnet-5-5", inputTokens: 10, outputTokens: 2 });
    b.drivers.for("b_alpha").end({ usage: { inputTokens: 10, outputTokens: 2 } });
    await flush();
    expect(ledger.totals().rows).toBe(0);
    ledger.close();
    await b.shutdown();

    const again = await twoBots(home, clock);
    const second = counterFor(again);
    expect(second.ledger.totals()).toMatchObject({ rows: 1, inputTokens: 10, outputTokens: 2 });
    second.counter.stop();
    second.counter.start();
    expect(second.ledger.totals().rows).toBe(1);
    expect(second.ledger.cursor("b_alpha")).toBeGreaterThan(0);
    second.counter.stop();
    second.ledger.close();
    await again.shutdown();
  });

  test("usage.rows pages with a cursor and filters by bot and session; usage.summary groups", async () => {
    const home = tempDir();
    const ledger = new UsageLedger({ path: cloverUsageDbPath(home), computer: "Studio" });
    ledger.add(Array.from({ length: 5 }, (_, i) => ({
      dedupe: `s:${i}`, source: "clover" as const, at: 1_781_270_000_000 + i * 86_400_000, bot: i % 2 === 0 ? "alpha" : "pack/luna",
      session: i % 2 === 0 ? "b_alpha" : "b_pack--luna", model: "anthropic/claude-sonnet-5-5", inputTokens: 10 * (i + 1), outputTokens: i,
    })));
    const methods = usageMethods({ ledger });
    const ctx = { caller: { kind: "user", client: "app" } as const };
    const first = USAGE_METHODS.usageRows.result.parse(await methods["usage.rows"]!({ since: 0, limit: 2 }, ctx));
    expect(first.rows.map((r) => r.id)).toEqual(["Studio:1", "Studio:2"]);
    const second = USAGE_METHODS.usageRows.result.parse(await methods["usage.rows"]!({ since: 0, limit: 2, cursor: first.next }, ctx));
    expect(second.rows.map((r) => r.id)).toEqual(["Studio:3", "Studio:4"]);
    const luna = USAGE_METHODS.usageRows.result.parse(await methods["usage.rows"]!({ since: 0, bot: "pack/luna" }, ctx));
    expect(luna.rows.map((r) => r.session)).toEqual(["b_pack--luna", "b_pack--luna"]);
    expect(luna.next).toBeUndefined();
    const days = USAGE_METHODS.usageSummary.result.parse(await methods["usage.summary"]!({ from: 0, to: 2_000_000_000_000, groupBy: "day" }, ctx));
    expect(days.groups.map((g) => g.key)).toEqual(["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16"]);
    const bySession = USAGE_METHODS.usageSummary.result.parse(await methods["usage.summary"]!({ from: 0, to: 2_000_000_000_000, groupBy: "session" }, ctx));
    expect(bySession.groups).toEqual([{ key: "b_alpha", inputTokens: 90, outputTokens: 6 }, { key: "b_pack--luna", inputTokens: 60, outputTokens: 4 }]);
    const bad = await methods["usage.rows"]!({ since: 0, cursor: "nope" }, ctx).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(MethodError);
    expect((bad as MethodError).code).toBe(ERR.INVALID_PARAMS);
    expect(((await methods["usage.summary"]!({ from: 0, to: 1, groupBy: "planet" }, ctx).catch((e: unknown) => e)) as MethodError).code).toBe(ERR.INVALID_PARAMS);
    ledger.close();
  });

  test("a row is never counted twice, and bad numbers are refused", () => {
    const ledger = new UsageLedger({ path: cloverUsageDbPath(tempDir()), computer: "Studio" });
    const row = { dedupe: "s:1:5", source: "clover" as const, at: 5, inputTokens: 1, outputTokens: 1 };
    expect(ledger.add([row])).toHaveLength(1);
    expect(ledger.add([row])).toHaveLength(0);
    expect(() => ledger.add([{ ...row, dedupe: "s:2", inputTokens: -1 }])).toThrow();
    expect(() => ledger.add([{ ...row, dedupe: "s:3", costUsd: Number.NaN }])).toThrow();
    expect(ledger.totals().rows).toBe(1);
    ledger.close();
  });
});
