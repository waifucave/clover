// The BotRecords conformance suite (spec revision 19, §6.1, item 114). `runBotRecordsConformance(make)` registers every
// case against the implementation `make` builds; `tests/bot-records.test.ts` runs it against FakeBotRecords, and lane BT
// runs it against the engine's records on a temp home. What it pins: ids from names, the user's edits, the instructions
// rule, removal, and the one-time move.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import type { FakeBotRecords } from "../fakes/bot-records";

export type BotRecordsHarness = Pick<FakeBotRecords, keyof FakeBotRecords>;
export type BotRecordsFactory = (...args: ConstructorParameters<typeof FakeBotRecords>) => BotRecordsHarness;

export function runBotRecordsConformance(make: BotRecordsFactory): void {
  const setup = () => make({ clock: new FakeClock() });
  const user = { kind: "user" } as const;

  describe("BotRecords", () => {
    test("a bot's id comes from its name, unique; it starts with the instructions it was given", async () => {
      const bots = setup();
      expect((await bots.create({ name: "Alpha" }, { kind: "default" })).id).toBe("alpha");
      expect((await bots.create({ name: "Alpha" }, user)).id).toBe("alpha-2");
      expect((await bots.create({ name: "Zoë the 2nd!" }, user)).id).toBe("zoe-the-2nd");
      expect((await bots.create({ name: "42" }, user)).id).toBe("bot");
      const nova = await bots.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large", face: { color: "teal" } }, user);
      expect(nova).toMatchObject({ id: "nova", model: "acme/large", face: { color: "teal" }, madeBy: { kind: "user" }, instructionsBytes: 13 });
      expect(bots.instructions("nova")).toBe("You are Nova.");
      expect(isContractError(await bots.create({ name: "  " }, user).catch((e: unknown) => e), "invalid")).toBe(true);
    });

    test("the user's edit sets and clears fields; the next read has it", async () => {
      const bots = setup();
      await bots.create({ name: "Nova", model: "acme/large", effort: "high" }, user);
      const edited = await bots.edit("nova", { name: "Nova Prime", model: null, voice: { provider: "fish", voice: "v1" }, instructions: "Be brief." });
      expect(edited).toMatchObject({ name: "Nova Prime", effort: "high", voice: { provider: "fish", voice: "v1" } });
      expect(edited.model).toBeUndefined();
      expect(bots.instructions("nova")).toBe("Be brief.");
      expect(isContractError(await bots.edit("ghost", { name: "x" }).catch((e: unknown) => e), "not_found")).toBe(true);
    });

    test("instructions: the bot itself and the bot that made it write freely; another bot gets a card; a coding session is refused", async () => {
      const bots = setup();
      await bots.create({ name: "Alpha" }, user);
      await bots.create({ name: "Scout", instructions: "v1" }, { kind: "bot", id: "alpha" });
      expect(await bots.writeInstructions({ kind: "bot", id: "scout" }, "scout", "v2")).toEqual({ written: true });
      expect(await bots.writeInstructions({ kind: "bot", id: "alpha" }, "scout", "v3")).toEqual({ written: true });
      expect(await bots.writeInstructions({ kind: "bot", id: "scout" }, "alpha", "taken over")).toEqual({ written: false, card: true });
      expect(bots.instructions("alpha")).toBe("");
      expect(isContractError(await bots.writeInstructions({ kind: "other" }, "scout", "x").catch((e: unknown) => e), "refused")).toBe(true);
      expect(await bots.writeInstructions(user, "alpha", "by the user")).toEqual({ written: true });
      expect(bots.instructions("scout")).toBe("v3");
    });

    test("removing a bot takes it from the list and is heard", async () => {
      const bots = setup();
      const seen: string[] = [];
      bots.watch((c) => seen.push("removed" in c ? `-${c.removed}` : `+${c.bot.id}`));
      await bots.create({ name: "Nova" }, user);
      await bots.remove("nova");
      expect(bots.list()).toEqual([]);
      expect(seen).toEqual(["+nova", "-nova"]);
      expect(isContractError(await bots.remove("nova").catch((e: unknown) => e), "not_found")).toBe(true);
    });

    test("the move: each plugin bot becomes a record of the same id, the user's layer over its plugin's; once", async () => {
      const bots = setup();
      await bots.create({ name: "Nova" }, user);
      const journal = await bots.move([
        { plugin: "alpha", id: "alpha", name: "Alpha", instructions: "plugin words", greeting: "Hi!", model: "acme/small", voice: { provider: "fish", voice: "alpha" }, userLayer: { instructions: "the user's words", model: "acme/large" } },
        { plugin: "pack/luna", id: "pack/luna", name: "Luna", instructions: "Luna's words" },
        { plugin: "nova", id: "nova", name: "Nova from a plugin", instructions: "ignored" },
      ]);
      expect(journal.bots).toEqual([
        { outcome: "moved", id: "alpha", plugin: "alpha" },
        { outcome: "moved", id: "pack/luna", plugin: "pack/luna" },
        { outcome: "kept", id: "nova", plugin: "nova" },
      ]);
      expect(bots.get("alpha")).toMatchObject({ name: "Alpha", model: "acme/large", greeting: "Hi!", voice: { provider: "fish", voice: "alpha" }, madeBy: { kind: "move", plugin: "alpha" } });
      expect(bots.instructions("alpha")).toBe("the user's words");
      expect(bots.instructions("pack/luna")).toBe("Luna's words");
      expect(bots.get("nova")?.name).toBe("Nova");
      expect(await bots.move([{ plugin: "late", id: "late", name: "Late", instructions: "" }])).toEqual(journal);
      expect(bots.get("late")).toBeUndefined();
      expect(bots.journal()).toEqual(journal);
    });
  });
}
