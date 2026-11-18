// MOSS's archive row (row 107) on the engine alone (lane BT, round 6): a bot the person made and renamed, whose turn
// failed (the row before it), is archived and brought back 200 times, with the move's passes, edits and turns in between
// in a generated order. After each restore `bot.records` lists it with its name and its maker, `bot_record_changed`
// carried it after its `bot_record_removed`, and its conversation is the one it had; after each archive it is in
// `bot.archived` only. Each step's state is what MOSS's list is built from (apps/moss engine.ts: the records the events
// keep, then `bot.records` read again after a restore).
import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { moveInputs } from "../move";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const user = (text: string, id: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });

describe("a bot the person made, archived and brought back again and again", () => {
  test("200 archive/restore pairs with move passes, edits and turns between: listed after each restore, with its name, maker and conversation", async () => {
    const seed = 1077;
    const next = rng(seed);
    const clock = new FakeClock();
    const b = await boot({ home: tempDir(), clock, plugins: [], botSource: "records", defaultBot: true });
    const store = b.bots.records!;
    const made = await b.bots.createBot({ name: "Nova" }, { kind: "user" });
    await b.bots.editBot(made.id, { name: "Nova Two" });
    const session = made.mainSession;
    // The row before: her turn failed.
    await b.host.sendUser(session, user("hello", "m-0"));
    await flush();
    b.drivers.for(session).end({ reason: "failed" });
    await flush();
    const events: { type: string; id?: string; bot?: { id: string; name: unknown } }[] = [];
    const off = b.bots.onEvent((e) => events.push(e as never));
    let archived = false;
    let turns = 1;
    const log: string[] = [];
    for (let pairs = 0; pairs < 200;) {
      const op = next();
      clock.advance(10);
      const why = `seed ${seed}: ${log.slice(-12).join(" ")}`;
      if (op < 0.15) {
        // A move pass, as a start runs it (the journal settles everything; nothing of hers is touched).
        log.push("move");
        await store.move(moveInputs(b.registry, b.home, store.journal()));
      } else if (op < 0.25 && !archived) {
        log.push("turn");
        await b.host.sendUser(session, user(`turn ${turns}`, `m-${turns}`));
        turns++;
        await flush();
        b.drivers.for(session).end({ text: "ok" });
        await flush();
      } else if (!archived) {
        log.push("archive");
        const from = events.length;
        await b.bots.archiveBot(made.id);
        archived = true;
        expect(store.get(made.id), why).toBeUndefined();
        expect(b.bots.archivedBots().map((a) => a.id), why).toContain(made.id);
        expect(events.slice(from).some((e) => e.type === "bot_record_removed" && e.id === made.id), why).toBe(true);
      } else {
        log.push("restore");
        const from = events.length;
        await b.bots.restoreBot(made.id);
        await flush();
        archived = false;
        pairs++;
        const listed = store.list().find((v) => v.id === made.id);
        expect(listed, why).toMatchObject({ name: "Nova Two", madeBy: { kind: "user" }, mainSession: session });
        expect(b.bots.archivedBots().map((a) => a.id), why).not.toContain(made.id);
        // The last word on her in the events is her record, not her removal.
        const mine = events.slice(from).filter((e) => e.id === made.id || e.bot?.id === made.id).filter((e) => e.type === "bot_record_changed" || e.type === "bot_record_removed");
        expect(mine.at(-1)?.type, why).toBe("bot_record_changed");
        // Her conversation is the one she had: her first message and every turn since.
        expect(b.host.history(session).filter((r) => r.type === "input").length, why).toBe(turns);
      }
    }
    off();
    await b.shutdown();
  }, 120_000);
});
