// The default bot's rename carried to existing homes (default-bot-refresh.ts): MOSS, coral, the kit's tile; once; the
// person's own changes kept; a later un-pin never overruled.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { DEFAULT_BOT_FACE, DEFAULT_BOT_GREETING, DEFAULT_BOT_INSTRUCTIONS } from "../default-bot";
import { DEFAULT_BOT_REFRESH_FILE, defaultBotRefreshed } from "../default-bot-refresh";
import { instructionsFile, recordFile } from "../records";
import { userLayerFile } from "../paths";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };
const OLD_INSTRUCTIONS = readFileSync(join(import.meta.dir, "old-defaults", "instructions.md"), "utf8");
const OLD_GREETING = readFileSync(join(import.meta.dir, "old-defaults", "greeting.txt"), "utf8");
const PLUGIN_ERA_INSTRUCTIONS = readFileSync(join(import.meta.dir, "plugin-era", "alpha", "bot", "instructions.md"), "utf8");
const marker = (home: string) => join(home, ...DEFAULT_BOT_REFRESH_FILE);

const start = (home: string) => boot({ home, plugins: [], botSource: "records", defaultBot: true });

/** A home as the build before this ruling left it: her record named Alpha with no pins and the earlier words, no marker. */
async function olderHome(change: (record: Record<string, unknown>) => void = () => {}, instructions: string = OLD_INSTRUCTIONS): Promise<string> {
  const home = tempDir();
  const first = await start(home);
  await first.shutdown();
  const file = recordFile(home, "alpha");
  const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  record.name = "Alpha";
  record.greeting = OLD_GREETING;
  delete record.face;
  change(record);
  writeFileSync(file, JSON.stringify(record, null, 2));
  writeFileSync(instructionsFile(home, "alpha"), instructions);
  rmMarker(home);
  return home;
}
const rmMarker = (home: string) => rmSync(marker(home), { force: true });

describe("MOSS, the default bot", () => {
  test("a fresh home's first bot is MOSS: her name, face, instructions and greeting; the id stays alpha", async () => {
    const home = tempDir();
    const b = await start(home);
    const bot = b.bots.records!.get("alpha")!;
    expect(bot).toMatchObject({ id: "alpha", name: "MOSS", face: { shape: "tile", color: "coral", eyes: "round" }, greeting: DEFAULT_BOT_GREETING, madeBy: { kind: "default" }, mainSession: "b_alpha" });
    expect(bot.face).toEqual(DEFAULT_BOT_FACE);
    expect(b.bots.records!.instructions("alpha")).toBe(DEFAULT_BOT_INSTRUCTIONS);
    expect(DEFAULT_BOT_INSTRUCTIONS).toStartWith("You are MOSS, the first bot people meet in the MOSS app.");
    expect(DEFAULT_BOT_INSTRUCTIONS).not.toContain("Alpha");
    expect(DEFAULT_BOT_GREETING).toStartWith("Hi, I'm MOSS.");
    expect(DEFAULT_BOT_GREETING).not.toContain("Alpha");
    // The step is recorded at that first start too, so a later un-pin is never overruled.
    expect(defaultBotRefreshed(home)).toBe(true);
    await b.shutdown();
  });

  test("a default-made home that is untouched takes the new default, field by field, at the next start", async () => {
    const home = await olderHome();
    expect(defaultBotRefreshed(home)).toBe(false);
    const b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ id: "alpha", name: "MOSS", greeting: DEFAULT_BOT_GREETING, face: DEFAULT_BOT_FACE, madeBy: { kind: "default" } });
    expect(b.bots.records!.instructions("alpha")).toBe(DEFAULT_BOT_INSTRUCTIONS);
    expect(JSON.parse(readFileSync(marker(home), "utf8"))).toMatchObject({ refresh: 1, id: "alpha", changed: ["name", "instructions", "greeting", "face"] });
    await b.shutdown();
  });

  test("a name, instructions, greeting, colour or model the person changed is kept; the rest is refreshed", async () => {
    // A bot they renamed keeps its name.
    let home = await olderHome((r) => { r.name = "Juno"; });
    let b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "Juno", face: DEFAULT_BOT_FACE, greeting: DEFAULT_BOT_GREETING });
    expect(b.bots.records!.instructions("alpha")).toBe(DEFAULT_BOT_INSTRUCTIONS);
    await b.shutdown();
    // A name in their layer wins whatever the record says.
    home = await olderHome();
    writeFileSync(userLayerFile(home, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { name: "Alpha" } }));
    b = await start(home);
    expect(b.bots.records!.get("alpha")!.name).toBe("Alpha");
    await b.shutdown();
    // Their own instructions.
    home = await olderHome(() => {}, "You are Alpha, my way.");
    b = await start(home);
    expect(b.bots.records!.instructions("alpha")).toBe("You are Alpha, my way.");
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "MOSS", face: DEFAULT_BOT_FACE });
    await b.shutdown();
    // Their own greeting.
    home = await olderHome((r) => { r.greeting = "Hello there."; });
    b = await start(home);
    expect(b.bots.records!.get("alpha")!.greeting).toBe("Hello there.");
    await b.shutdown();
    // A colour they pinned stays; a pin they never made is filled.
    home = await olderHome((r) => { r.face = { color: "mint" }; });
    b = await start(home);
    expect(b.bots.records!.get("alpha")!.face).toEqual({ color: "mint" });
    expect(b.bots.records!.get("alpha")!.name).toBe("MOSS");
    await b.shutdown();
    // Their model.
    home = await olderHome((r) => { r.model = "acme/large"; });
    b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ model: "acme/large", name: "MOSS" });
    await b.shutdown();
  });

  test("a home moved from the plugin era: her plugin's earlier words are recognised, with and without a layer", async () => {
    // Moved by an earlier build: her record is the move's, with the plugin's instructions.
    let home = await olderHome((r) => { r.madeBy = { kind: "move", plugin: "alpha" }; }, PLUGIN_ERA_INSTRUCTIONS);
    let b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "MOSS", face: DEFAULT_BOT_FACE, madeBy: { kind: "move", plugin: "alpha" } });
    expect(b.bots.records!.instructions("alpha")).toBe(DEFAULT_BOT_INSTRUCTIONS);
    await b.shutdown();
    // The same, but the person's layer holds instructions: those were the record's, and are kept.
    home = await olderHome((r) => { r.madeBy = { kind: "move", plugin: "alpha" }; }, PLUGIN_ERA_INSTRUCTIONS);
    writeFileSync(userLayerFile(home, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { instructions: PLUGIN_ERA_INSTRUCTIONS } }));
    b = await start(home);
    expect(b.bots.records!.instructions("alpha")).toBe(PLUGIN_ERA_INSTRUCTIONS);
    expect(b.bots.records!.get("alpha")!.name).toBe("MOSS");
    await b.shutdown();
  });

  test("a bot of the person's own under the id is not hers: untouched, and no marker", async () => {
    const home = await olderHome((r) => { r.madeBy = { kind: "user" }; });
    const b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "Alpha", madeBy: { kind: "user" } });
    expect(b.bots.records!.get("alpha")!.face).toBeUndefined();
    expect(b.bots.records!.instructions("alpha")).toBe(OLD_INSTRUCTIONS);
    expect(existsSync(marker(home))).toBe(false);
    await b.shutdown();
  });

  test("archived by the person: stays archived, untouched and unmarked; brought back, she is refreshed at the next start", async () => {
    const home = await olderHome();
    let b = await start(home);
    // The refresh ran at this start (she was live). Start over: archive her in an older home first.
    await b.shutdown();
    const older = await olderHome();
    const pre = await boot({ home: older, plugins: [], botSource: "records", defaultBot: false });
    await pre.bots.archiveBot("alpha");
    await pre.shutdown();
    b = await start(older);
    expect(b.bots.list()).toEqual([]);
    expect(b.bots.archivedBots().map((a) => a.id)).toEqual(["alpha"]);
    expect(existsSync(marker(older))).toBe(false);
    await b.bots.restoreBot("alpha");
    await b.shutdown();
    b = await start(older);
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "MOSS", face: DEFAULT_BOT_FACE });
    await b.shutdown();
  });

  test("it never runs twice: a second start changes nothing, and a person's later un-pin or rename survives a restart", async () => {
    const home = await olderHome();
    let b = await start(home);
    const once = readFileSync(recordFile(home, "alpha"), "utf8");
    const markerOnce = readFileSync(marker(home), "utf8");
    await b.shutdown();
    b = await start(home);
    expect(readFileSync(recordFile(home, "alpha"), "utf8")).toBe(once);
    expect(readFileSync(marker(home), "utf8")).toBe(markerOnce);
    // The person un-pins her face, renames her and puts the old words back; none is overruled at the next start.
    await b.bots.records!.edit("alpha", { face: null, name: "Alpha", greeting: OLD_GREETING });
    await b.shutdown();
    b = await start(home);
    expect(b.bots.records!.get("alpha")).toMatchObject({ name: "Alpha", greeting: OLD_GREETING });
    expect(b.bots.records!.get("alpha")!.face).toBeUndefined();
    await b.shutdown();
    void USER;
  });
});
