// Alpha as the default bot MOSS offers (lane MC; spec §6.2, G9): engine data, not a plugin. On a fresh home she is a
// record at the first start, as MOSS's window reads bots (`bot.records`, `bot.summaries`); on a home that ran her as the
// bundled plugin bot (the owner's), the flip to records at default keeps her conversation, her memory, her routines and
// the person's own instructions, and deletes nothing; removed, she is never offered again.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BOT_MOVE_JOURNAL, BotMoveJournal, type Caller } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { projectRecords } from "../../sessions/wire";
import { DEFAULT_BOT_GREETING, DEFAULT_BOT_INSTRUCTIONS } from "../default-bot";
import { servesScope } from "../../runtime-sdk/turn-loop/only-backends";
import { botPaths, userLayerFile } from "../paths";
import { instructionsFile } from "../records";
import { botSource, DEFAULT_BOT_SOURCE } from "../source";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };
const user = (text: string, id = `m-${text}`) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });

/** Every file under `dir` with its size, by path. */
function tree(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (at: string) => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) out.set(relative(dir, p), statSync(p).size);
    }
  };
  walk(dir);
  return out;
}

const call = (b: Awaited<ReturnType<typeof boot>>) => {
  const all = b.side.methods({ localDevice: "studio0000000000000" });
  return (name: string, params: unknown = {}) => all[name]!(params, { caller: USER } as never) as Promise<Record<string, unknown>>;
};

describe("the default bot", () => {
  test("bots are records by default (MOSS_BOT_SOURCE=plugins keeps the old source for one daemon)", () => {
    expect(DEFAULT_BOT_SOURCE).toBe("records");
    expect(botSource({})).toBe("records");
    expect(botSource({ MOSS_BOT_SOURCE: "plugins" })).toBe("plugins");
  });

  test("a fresh home has MOSS at its first start: a record MOSS made, her greeting, her instructions, the person's default model", async () => {
    const home = tempDir();
    const b = await boot({ home, plugins: [], botSource: "records", defaultBot: true });
    const alpha = b.bots.records!.get("alpha")!;
    expect(alpha).toMatchObject({ id: "alpha", name: "MOSS", face: { shape: "tile", color: "coral", eyes: "round" }, madeBy: { kind: "default" }, greeting: DEFAULT_BOT_GREETING, mainSession: "b_alpha" });
    // Item 124: the person's model until they pick one.
    expect(alpha.model).toBeUndefined();
    expect(readFileSync(instructionsFile(home, "alpha"), "utf8")).toBe(DEFAULT_BOT_INSTRUCTIONS);
    expect(readFileSync(join(botPaths(home, "alpha").memory, "MEMORY.md"), "utf8")).toStartWith("# Memory");
    // As MOSS's window reads bots.
    const c = call(b);
    expect(((await c("bot.records")).bots as { id: string }[]).map((x) => x.id)).toEqual(["alpha"]);
    expect(((await c("bot.summaries")).summaries as { id: string }[]).map((x) => x.id)).toEqual(["alpha"]);
    expect(projectRecords(b.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "assistant_message").map((e) => (e as unknown as { text: string }).text)).toEqual([DEFAULT_BOT_GREETING]);
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(join(home, ...BOT_MOVE_JOURNAL.split("/")), "utf8")));
    expect(journal.bots).toEqual([{ outcome: "moved", id: "alpha", plugin: "alpha" }]);
    await b.shutdown();

    // A second start changes nothing; archived, she is never offered again, even past a restart.
    const again = await boot({ home, plugins: [], botSource: "records", defaultBot: true });
    expect(again.bots.list().map((v) => v.id)).toEqual(["alpha"]);
    await again.bots.archiveBot("alpha");
    expect(again.bots.list()).toEqual([]);
    await again.shutdown();
    const after = await boot({ home, plugins: [], botSource: "records", defaultBot: true });
    expect(after.bots.list()).toEqual([]);
    expect(after.bots.archivedBots().map((a) => a.id)).toEqual(["alpha"]);
    await after.shutdown();
  });

  test("a home that ran her as the bundled plugin bot keeps her conversation, memory, routines and the person's instructions after the flip; nothing is deleted", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const pluginEra = (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs;

    // Before: plugins as the source, Alpha her plugin's bot. A long conversation, her memory edited, a routine, and
    // the person's own instructions in her user layer.
    const before = await boot({
      home, clock, plugins: pluginEra, botSource: "plugins",
      routines: { userTimeZone: () => "Europe/London", watchFiles: false },
    });
    for (let i = 0; i < 3; i++) {
      await before.host.sendUser("b_alpha", user(`message ${i}`));
      await flush();
      before.drivers.for("b_alpha").end({ text: `reply ${i}` });
      await flush();
    }
    await before.bots.setUserLayer("alpha", { instructions: "You are Alpha, as the person rewrote you." }, USER);
    const memory = join(botPaths(home, "alpha").memory, "MEMORY.md");
    writeFileSync(memory, "# Memory\n\n- [Sam](sam.md): the person is Sam.\n");
    writeFileSync(join(botPaths(home, "alpha").memory, "sam.md"), "Sam likes short answers.\n");
    const routine = before.side.tools("b_alpha").find((t) => t.name === "Routine")!;
    await routine.run({ name: "Morning brief", instructions: "Summarize the overnight issues.", schedule: "0 8 * * *" });
    const routinesBefore = before.side.routines!.list("alpha").map((r) => r.id);
    expect(routinesBefore.length).toBe(1);
    const turnsBefore = before.host.length("b_alpha");
    await before.shutdown();
    const filesBefore = tree(home);

    // After the upgrade: records at default, and the bundled tree has no plugin that brings her.
    const after = await boot({ home, clock, plugins: [], routines: { userTimeZone: () => "Europe/London", watchFiles: false }, botSource: DEFAULT_BOT_SOURCE, defaultBot: true });
    const alpha = after.bots.records!.get("alpha")!;
    expect(alpha).toMatchObject({ id: "alpha", name: "MOSS", madeBy: { kind: "default" }, mainSession: "b_alpha" });
    // Her model as her plugin had it, so it doesn't change under the person.
    expect(alpha).toMatchObject({ model: "anthropic/claude-sonnet-5-5", effort: "medium" });
    expect(after.bots.records!.instructions("alpha")).toBe("You are Alpha, as the person rewrote you.");
    // Her memory as it was: the starter memory not written over.
    expect(readFileSync(memory, "utf8")).toBe("# Memory\n\n- [Sam](sam.md): the person is Sam.\n");
    expect(readFileSync(join(botPaths(home, "alpha").memory, "sam.md"), "utf8")).toBe("Sam likes short answers.\n");
    // Her conversation: every turn there, no second greeting, and it goes on.
    expect(after.host.length("b_alpha")).toBe(turnsBefore);
    const texts = projectRecords(after.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "user_message").map((e) => (e as unknown as { text: string }).text);
    expect(texts).toEqual(["message 0", "message 1", "message 2"]);
    expect(projectRecords(after.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "assistant_message" && (e as unknown as { greeting?: boolean }).greeting === true).length).toBe(1);
    await after.host.sendUser("b_alpha", user("still you?"));
    await flush();
    expect(after.drivers.for("b_alpha").turns.at(-1)?.input).toMatchObject({ from: "user", text: "still you?" });
    expect(after.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx.current().instructions).toContain("You are Alpha, as the person rewrote you.");
    after.drivers.for("b_alpha").end({ text: "yes" });
    await flush();
    // Her routines, as MOSS lists a bot's.
    expect(after.side.routines!.list("alpha").map((r) => r.id)).toEqual(routinesBefore);
    // As MOSS's window reads bots.
    const c = call(after);
    expect(((await c("bot.records")).bots as { id: string }[]).map((x) => x.id)).toEqual(["alpha"]);
    expect(((await c("bot.summaries")).summaries as { id: string }[]).map((x) => x.id)).toEqual(["alpha"]);
    await after.shutdown();

    // Nothing of the home is gone or shrunk: every file before is there, at least as large (logs only grow).
    const filesAfter = tree(home);
    for (const [path, size] of filesBefore) {
      expect({ path, there: filesAfter.has(path) }).toEqual({ path, there: true });
      if (!path.endsWith(".json")) expect({ path, grew: (filesAfter.get(path) ?? 0) >= size }).toEqual({ path, grew: true });
    }
    expect(readFileSync(userLayerFile(home, "alpha"), "utf8")).toContain("as the person rewrote you");
  });

  test("a stale record of her bundled plugin that still brings her bot, with her bot's files gone: she gets her record at the first start all the same", async () => {
    const home = tempDir();
    // Her plugin's manifest as an old record holds it (a bot entry), its folder without the bot's files.
    const stale = writePlugin(tempDir(), "alpha", { "moss.json": botManifest("alpha", "Alpha"), "bot/instructions.md": "You are Alpha." });
    const inputs = (await pluginFromFolder(stale, { bundled: true })).inputs;
    expect(inputs.map((i) => i.id)).toEqual(["alpha"]);
    rmSync(join(stale, "bot"), { recursive: true });
    const b = await boot({ home, plugins: inputs, botSource: "records", defaultBot: true });
    expect(b.bots.records!.get("alpha")).toMatchObject({ id: "alpha", madeBy: { kind: "default" } });
    expect(b.bots.list().map((v) => v.id)).toEqual(["alpha"]);
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(join(home, ...BOT_MOVE_JOURNAL.split("/")), "utf8")));
    expect(journal.bots).toEqual([{ outcome: "moved", id: "alpha", plugin: "alpha" }]);
    await b.shutdown();
  });

  test("a new bot never takes an installed plugin's id (its own-bot parts serve the bot of its id)", async () => {
    const tarot = writePlugin(tempDir(), "tarot", { "moss.json": { manifest: 1, id: "tarot", name: "Tarot", scope: "own-bot" } });
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(tarot)).inputs.map((i) => ({ ...i, approved: true })), botSource: "records" });
    const made = await b.bots.createBot({ name: "Tarot" }, { kind: "user" });
    expect(made.id).toBe("tarot-2");
    await b.shutdown();
  });

  test("own-bot reaches a bot only when its record says it was moved from that plugin, never by an equal id, both ways", async () => {
    const root = tempDir();
    const scout = writePlugin(root, "scout", { "moss.json": botManifest("scout", "Scout"), "bot/instructions.md": "You are Scout." });
    // MOSS's own bundled alpha plugin is installed, as in a real home: it serves her room tools (default-bot-owner.test.ts
    // has the home where it is not, or where another plugin has her id).
    const plugins = [...(await pluginFromFolder(scout)).inputs.map((i) => ({ ...i, approved: true })), ...(await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs];
    const b = await boot({ home: tempDir(), plugins, botSource: "records", defaultBot: true });
    const own = (plugin: string, bot: string) => servesScope("own-bot", { kind: "bot", bot }, plugin);
    // Moved from its plugin: that plugin's own parts reach it, another's don't.
    expect(b.bots.records!.get("scout")?.madeBy).toEqual({ kind: "move", plugin: "scout" });
    expect(own("scout", "scout")).toBe(true);
    expect(own("tarot", "scout")).toBe(false);
    // The default bot keeps her old plugin's stage until lane MC2 makes it a pack.
    expect(own("alpha", "alpha")).toBe(true);
    // A bot the person made, whose id a plugin installed afterwards has: no plugin's own-bot parts reach it.
    const made = await b.bots.createBot({ name: "Nova" }, { kind: "user" });
    expect(made.id).toBe("nova");
    expect(own("nova", "nova")).toBe(false);
    // A bot no store knows: none.
    expect(own("ghost", "ghost")).toBe(false);
    await b.shutdown();
    // With no records side running (plugins as the source), a bot's id is its plugin's, as before.
    expect(own("nova", "nova")).toBe(true);
  });
});

