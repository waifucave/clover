// The BotRecords conformance suite (spec revision 19, §6.1, item 114). `runBotRecordsConformance(make)` registers every
// case against the implementation `make` builds; `tests/bot-records.test.ts` runs it against FakeBotRecords, and lane BT
// runs it against the engine's records on a temp home. What it pins: ids from names, the user's edits, the instructions
// rule, a bot made by a bot behind the person's OK, the archive, plugins' bot-scoped settings, and the one-time move.
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
      const nova = await bots.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large", face: { color: "lagoon" } }, user);
      expect(nova).toMatchObject({ id: "nova", model: "acme/large", face: { color: "lagoon" }, madeBy: { kind: "user" }, instructionsBytes: 13 });
      expect(bots.instructions("nova")).toBe("You are Nova.");
      expect(isContractError(await bots.create({ name: "  " }, user).catch((e: unknown) => e), "invalid")).toBe(true);
    });

    test("a face pins any of the kit's four traits (shape, colour, eyes, temper); a value the kit doesn't have is refused", async () => {
      const bots = setup();
      const pinned = await bots.create({ name: "Nova", face: { shape: "gem", color: "#12ab34", eyes: "dot", temper: "slow" } }, user);
      expect(pinned.face).toEqual({ shape: "gem", color: "#12ab34", eyes: "dot", temper: "slow" });
      expect((await bots.edit("nova", { face: { eyes: "calm" } })).face).toEqual({ eyes: "calm" });
      expect((await bots.edit("nova", { face: null })).face).toBeUndefined();
      for (const face of [{ color: "teal" }, { shape: "star" }, { eyes: "wide" }, { temper: "angry" }, { mood: "happy" }]) {
        expect(isContractError(await bots.create({ name: "Bad", face } as never, user).catch((e: unknown) => e), "invalid")).toBe(true);
      }
      expect(bots.get("bad")).toBeUndefined();
    });

    test("the user's edit sets and clears fields; the next read has it", async () => {
      const bots = setup();
      await bots.create({ name: "Nova", model: "acme/large", effort: "high" }, user);
      const edited = await bots.edit("nova", { name: "Nova Prime", model: null, greeting: "Hey.", instructions: "Be brief." });
      expect(edited).toMatchObject({ name: "Nova Prime", effort: "high", greeting: "Hey." });
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

    test("removing a bot archives it: it leaves the list, keeps its id, and comes back whole", async () => {
      const bots = setup();
      const seen: string[] = [];
      bots.watch((c) => seen.push("removed" in c ? `-${c.removed}` : `+${c.bot.id}`));
      await bots.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large" }, user);
      await bots.remove("nova");
      expect(bots.list()).toEqual([]);
      expect(bots.archived()).toEqual([{ id: "nova", name: "Nova", archivedAt: expect.any(Number) }]);
      expect(seen).toEqual(["+nova", "-nova"]);
      expect(isContractError(await bots.remove("nova").catch((e: unknown) => e), "not_found")).toBe(true);
      // Its id isn't given to a new bot while it is archived.
      expect((await bots.create({ name: "Nova" }, user)).id).toBe("nova-2");
      expect(await bots.restore("nova")).toMatchObject({ id: "nova", model: "acme/large", instructionsBytes: 13 });
      expect(bots.instructions("nova")).toBe("You are Nova.");
      expect(bots.archived()).toEqual([]);
      expect(isContractError(await bots.restore("nova").catch((e: unknown) => e), "not_found")).toBe(true);
    });

    test("a plugin's bot-scoped settings are read and set per bot; another scope, or an undeclared key, is refused", async () => {
      const bots = setup();
      bots.declareBotSettings("speech-kit", [{ key: "style", scope: "bot", default: "plain" }, { key: "apiRegion", scope: "account" }]);
      bots.declareBotSettings("plain-tool", [{ key: "verbose", scope: "account" }]);
      await bots.create({ name: "Alpha" }, user);
      await bots.create({ name: "Nova" }, user);
      expect(bots.pluginSettings("alpha")).toEqual([{ pluginId: "speech-kit", settings: [{ key: "style", value: "plain", set: false }] }]);
      await bots.setPluginSetting("alpha", "speech-kit", "style", "bright");
      expect(bots.pluginSettings("alpha")[0]!.settings).toEqual([{ key: "style", value: "bright", set: true }]);
      expect(bots.pluginSettings("nova")[0]!.settings).toEqual([{ key: "style", value: "plain", set: false }]);
      await bots.setPluginSetting("alpha", "speech-kit", "style", null);
      expect(bots.pluginSettings("alpha")[0]!.settings[0]).toMatchObject({ value: "plain", set: false });
      expect(isContractError(await bots.setPluginSetting("alpha", "speech-kit", "apiRegion", "eu").catch((e: unknown) => e), "refused")).toBe(true);
      expect(isContractError(await bots.setPluginSetting("alpha", "speech-kit", "nope", 1).catch((e: unknown) => e), "not_found")).toBe(true);
      expect(isContractError((() => { try { bots.pluginSettings("ghost"); } catch (e) { return e; } })(), "not_found")).toBe(true);
    });

    test("a bot makes a bot only behind the person's OK naming the maker; its model defaults to the maker's and must be set up", async () => {
      const bots = setup();
      await bots.create({ name: "Alpha", model: "acme/large" }, user);
      const asked = await bots.proposeByBot("alpha", { name: "Scout", instructions: "Find things.", face: { shape: "drop" } }, ["acme/large", "acme/small"]);
      if (!("proposal" in asked)) throw new Error("expected a proposal");
      expect(asked.proposal).toMatchObject({ maker: "alpha", input: { name: "Scout", model: "acme/large" } });
      expect(bots.get("scout")).toBeUndefined();
      expect(await bots.answerProposal(asked.proposal.id, true)).toEqual({ outcome: "made", id: "scout" });
      expect(bots.get("scout")).toMatchObject({ madeBy: { kind: "bot", id: "alpha" }, model: "acme/large", face: { shape: "drop" } });
      expect(bots.instructions("scout")).toBe("Find things.");
      expect(await bots.proposeByBot("alpha", { name: "Rogue", model: "acme/unset" }, ["acme/large"])).toMatchObject({ outcome: "refused" });
      const no = await bots.proposeByBot("alpha", { name: "Maybe" }, ["acme/large"]);
      if (!("proposal" in no)) throw new Error("expected a proposal");
      expect(await bots.answerProposal(no.proposal.id, false)).toEqual({ outcome: "declined" });
      expect(bots.get("maybe")).toBeUndefined();
      expect(bots.proposals()).toEqual([]);
      // The maker sets name, instructions, face and model, nothing else.
      expect(isContractError(await bots.proposeByBot("alpha", { name: "X", effort: "max" } as never, ["acme/large"]).catch((e: unknown) => e), "invalid")).toBe(true);
    });

    test("the move: each plugin bot becomes a record of the same id, the user's layer over its plugin's; a settled entry is final", async () => {
      const clock = new FakeClock();
      const bots = make({ clock });
      await bots.create({ name: "Nova" }, user);
      const journal = await bots.move([
        { plugin: "alpha", id: "alpha", name: "Alpha", instructions: "plugin words", greeting: "Hi!", model: "acme/small", userLayer: { instructions: "the user's words", model: "acme/large" } },
        { plugin: "pack/luna", id: "pack/luna", name: "Luna", instructions: "Luna's words" },
        { plugin: "nova", id: "nova", name: "Nova from a plugin", instructions: "ignored" },
      ]);
      expect(journal.bots).toEqual([
        { outcome: "moved", id: "alpha", plugin: "alpha" },
        { outcome: "moved", id: "pack/luna", plugin: "pack/luna" },
        { outcome: "kept", id: "nova", plugin: "nova" },
      ]);
      expect(bots.get("alpha")).toMatchObject({ name: "Alpha", model: "acme/large", greeting: "Hi!", madeBy: { kind: "move", plugin: "alpha" } });
      expect(bots.instructions("alpha")).toBe("the user's words");
      expect(bots.instructions("pack/luna")).toBe("Luna's words");
      expect(bots.get("nova")?.name).toBe("Nova");
      // Run again, later: a plugin bot the journal doesn't name yet is moved, the settled ones are untouched, and the
      // journal's `at` stays its first completion's.
      clock.advance(60_000);
      const again = await bots.move([
        { plugin: "late", id: "late", name: "Late", instructions: "" },
        { plugin: "alpha", id: "alpha", name: "Alpha", instructions: "the plugin's words again" },
      ]);
      expect(again.bots).toEqual([...journal.bots, { outcome: "moved", id: "late", plugin: "late" }]);
      expect(again.at).toBe(journal.at);
      expect(bots.get("late")).toMatchObject({ madeBy: { kind: "move", plugin: "late" } });
      expect(bots.instructions("alpha")).toBe("the user's words");
      // A run that settles nothing new changes nothing.
      expect(await bots.move([{ plugin: "late", id: "late", name: "Late", instructions: "" }])).toEqual(again);
      expect(bots.journal()).toEqual(again);
    });
  });
}
