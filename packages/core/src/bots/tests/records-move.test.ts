// The one-time move of plugin bots into records (lane BT), on a fixture home that holds the bundled Alpha (her real
// folder), a bot a person made as a plugin in the user layer (`scout`, with the user's own layer over it), a pack's
// bot (`crew/luna`, its folder `crew--luna`) and a plugin never OK'd (`rogue`). The home first runs as today (plugins as
// the source) so each bot has a conversation and memory; then with records as the source the move runs once: run
// twice, the second changes nothing; cut off in the middle, it picks up where it was.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_MOVE_JOURNAL, BotMoveJournal, type Caller } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import type { FakePluginInput } from "../../contracts/fakes/plugin-registry";
import { projectRecords } from "../../sessions/wire";
import { botPaths } from "../paths";
import { instructionsFile, recordFile } from "../records";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };
const user = (text: string, id = `m-${text}`) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });

async function fixturePlugins(root: string): Promise<FakePluginInput[]> {
  const alpha = (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs;
  const scout = writePlugin(root, "scout", {
    "moss.json": botManifest("scout", "Scout", { model: { default: "acme/small", effort: "low" }, greeting: "bot/greeting.md" }),
    "bot/instructions.md": "You are Scout, made by the person.",
    "bot/greeting.md": "Scout here.",
  });
  const crew = writePlugin(root, "crew", {
    "moss.json": { manifest: 1, id: "crew", name: "A crew" },
    "plugins/luna/moss.json": botManifest(undefined, "Luna"),
    "plugins/luna/bot/instructions.md": "You are Luna.",
  });
  const rogue = writePlugin(root, "rogue", { "moss.json": botManifest("rogue", "Rogue"), "bot/instructions.md": "You are Rogue." });
  return [
    ...alpha,
    ...(await pluginFromFolder(scout)).inputs.map((i) => ({ ...i, approved: true })),
    ...(await pluginFromFolder(crew)).inputs.map((i) => ({ ...i, approved: true })),
    ...(await pluginFromFolder(rogue)).inputs.map((i) => ({ ...i, approved: false })),
  ];
}

const journalPath = (home: string) => join(home, ...BOT_MOVE_JOURNAL.split("/"));

describe("the one-time move", () => {
  test("each plugin bot becomes a record of the same id, with its instructions, model, memory and conversation; once", async () => {
    const root = tempDir();
    const home = tempDir();
    const clock = new FakeClock();
    const plugins = await fixturePlugins(root);

    // Today: the bots come from plugins; each gets a conversation (and Alpha her starter memories).
    const today = await boot({ home, clock, plugins });
    expect(today.bots.list().map((v) => v.id).sort()).toEqual(expect.arrayContaining(["alpha", "scout", "crew/luna"]));
    await today.bots.setUserLayer("scout", { instructions: "You are Scout, as the person rewrote you.", model: "acme/large" }, USER);
    for (const s of ["b_alpha", "b_scout", "b_crew--luna"]) {
      await today.host.sendUser(s, user(`hello ${s}`));
      await flush();
      today.drivers.for(s).end({ text: "hi" });
      await flush();
    }
    expect(existsSync(join(botPaths(home, "alpha").memory, "MEMORY.md"))).toBe(true);
    await today.shutdown();

    // Records as the source: the move runs at start.
    const moved = await boot({ home, clock, plugins, botSource: "records" });
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    const by = Object.fromEntries(journal.bots.map((b) => [b.id, b]));
    expect(by["alpha"]).toEqual({ outcome: "moved", id: "alpha", plugin: "alpha" });
    expect(by["scout"]).toEqual({ outcome: "moved", id: "scout", plugin: "scout" });
    expect(by["crew/luna"]).toEqual({ outcome: "moved", id: "crew/luna", plugin: "crew/luna" });
    // A plugin waiting for its OK: its bot isn't moved (its words were never OK'd), and is tried again at each start.
    expect(by["rogue"]).toMatchObject({ outcome: "failed", why: "its plugin was never OK'd" });
    // Alpha: her plugin's instructions, model and greeting; her memory and conversation where they were.
    const alpha = moved.bots.records!.get("alpha")!;
    expect(alpha).toMatchObject({ id: "alpha", name: "Alpha", madeBy: { kind: "move", plugin: "alpha" }, model: "anthropic/claude-sonnet-5-5", effort: "medium", mainSession: "b_alpha" });
    expect(readFileSync(instructionsFile(home, "alpha"), "utf8").startsWith("You are Alpha")).toBe(true);
    expect(readFileSync(join(botPaths(home, "alpha").memory, "MEMORY.md"), "utf8")).toBe(readFileSync(join(ALPHA_FOLDER, "bot/memory/MEMORY.md"), "utf8"));
    expect(projectRecords(moved.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["hello b_alpha"]);
    // Scout: the person's layer over its plugin's.
    // Its plugin's own effort isn't carried (a third party's, N5); the person's model is.
    expect(moved.bots.records!.get("scout")).toMatchObject({ model: "acme/large", greeting: "Scout here." });
    expect(moved.bots.records!.get("scout")?.effort).toBeUndefined();
    expect(moved.bots.records!.instructions("scout")).toBe("You are Scout, as the person rewrote you.");
    // A pack's bot: its `/` written `--` in its folder, its id kept.
    expect(existsSync(recordFile(home, "crew/luna"))).toBe(true);
    expect(recordFile(home, "crew/luna")).toContain(join("bots", "crew--luna", "bot.json"));
    expect(moved.bots.get("crew/luna")).toMatchObject({ mainSession: "b_crew--luna" });
    expect(projectRecords(moved.host.history("b_crew--luna"), { kind: "bot" }).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["hello b_crew--luna"]);
    // The never-OK'd plugin's bot is neither a record nor a bot.
    expect(existsSync(recordFile(home, "rogue"))).toBe(false);
    expect(moved.bots.list().map((v) => v.id).sort()).toEqual(["alpha", "crew/luna", "scout"]);
    // Its conversation continues: the next turn appends.
    await moved.host.sendUser("b_alpha", user("are you still you?"));
    await flush();
    expect(moved.drivers.for("b_alpha").turns.at(-1)?.input).toMatchObject({ from: "user", text: "are you still you?" });
    expect(moved.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx.current().instructions.startsWith("You are Alpha")).toBe(true);
    moved.drivers.for("b_alpha").end({ text: "yes" });
    await flush();
    const status = moved.side.methods({ localDevice: "x" })["bot.move.status"]!;
    expect(await status({}, { caller: USER } as never)).toEqual({ journal, pending: ["rogue"] });
    await moved.shutdown();

    // Run twice: the second changes nothing.
    const stamp = (id: string) => statSync(recordFile(home, id)).mtimeMs;
    const before = { journal: readFileSync(journalPath(home), "utf8"), alpha: stamp("alpha"), scout: readFileSync(recordFile(home, "scout"), "utf8") };
    const again = await boot({ home, clock, plugins, botSource: "records" });
    expect(readFileSync(journalPath(home), "utf8")).toBe(before.journal);
    expect(stamp("alpha")).toBe(before.alpha);
    expect(readFileSync(recordFile(home, "scout"), "utf8")).toBe(before.scout);
    expect(again.bots.list().map((v) => v.id).sort()).toEqual(["alpha", "crew/luna", "scout"]);
    await again.shutdown();
  });

  test("cut off in the middle (records written, no journal), the move picks up where it was and writes the same outcomes", async () => {
    const root = tempDir();
    const home = tempDir();
    const clock = new FakeClock();
    const plugins = await fixturePlugins(root);
    const first = await boot({ home, clock, plugins, botSource: "records" });
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    await first.shutdown();
    // A crash after Alpha's record but before scout's and the journal.
    rmSync(journalPath(home));
    rmSync(recordFile(home, "scout"));
    const resumed = await boot({ home, clock, plugins, botSource: "records" });
    const second = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    expect(second.bots).toEqual(journal.bots);
    expect(resumed.bots.records!.get("scout")).toMatchObject({ madeBy: { kind: "move", plugin: "scout" } });
    expect(resumed.bots.list().map((v) => v.id).sort()).toEqual(["alpha", "crew/luna", "scout"]);
    await resumed.shutdown();
  });

  test("a bot the person already made under the id is kept; an unreadable journal holds the move", async () => {
    const root = tempDir();
    const home = tempDir();
    const clock = new FakeClock();
    const plugins = await fixturePlugins(root);
    // No plugins first: the person makes their own Scout.
    const own = await boot({ home, clock, plugins: [], botSource: "records" });
    await own.bots.createBot({ name: "Scout", instructions: "mine" }, { kind: "user" });
    rmSync(journalPath(home)); // the empty home's move ran with nothing to move
    await own.shutdown();
    const moved = await boot({ home, clock, plugins, botSource: "records" });
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    expect(journal.bots.find((b) => b.id === "scout")).toEqual({ outcome: "kept", id: "scout", plugin: "scout" });
    expect(moved.bots.records!.instructions("scout")).toBe("mine");
    await moved.shutdown();

    const home2 = tempDir();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(home2, "user-layers", "moved"), { recursive: true });
    writeFileSync(journalPath(home2), "{ broken");
    const held = await boot({ home: home2, clock, plugins, botSource: "records" });
    expect(held.bots.list()).toEqual([]);
    expect(held.warnings.some((w) => w.includes("unreadable"))).toBe(true);
    expect(readFileSync(journalPath(home2), "utf8")).toBe("{ broken");
    await held.shutdown();
  });
});

describe("what the move reads", () => {
  test("a listed bot whose plugin was never OK'd, or whose files don't load, is failed with why; nothing of it is read further", async () => {
    const { pluginBotsForMove } = await import("../move");
    const root = tempDir();
    const ok = writePlugin(root, "okbot", { "moss.json": botManifest("okbot", "Ok"), "bot/instructions.md": "You are Ok." });
    const broken = writePlugin(root, "broken", { "moss.json": botManifest("broken", "Broken") });
    const never = writePlugin(root, "never", { "moss.json": botManifest("never", "Never"), "bot/instructions.md": "x" });
    const rec = (id: string, folder: string, okHash?: string) => ({ id, folder, source: "local", ...(okHash === undefined ? {} : { okHash }) });
    const records: Record<string, unknown> = { okbot: rec("okbot", ok, "h1"), broken: rec("broken", broken, "h2"), never: rec("never", never) };
    const entry = (id: string) => ({ point: "bot", pluginId: id, ref: "bot", state: "active", value: { name: id, instructions: "bot/instructions.md" } });
    const registry = { list: () => [], entries: () => [entry("okbot"), entry("broken"), entry("never"), entry("okbot")], get: (id: string) => records[id] } as never;
    const got = pluginBotsForMove(registry, tempDir());
    expect(got.map((b) => [b.id, b.failed ?? "ok"])).toEqual([
      ["okbot", "ok"],
      ["broken", expect.stringContaining("instructions")],
      ["never", "its plugin was never OK'd"],
    ]);
    expect(got[0]).toMatchObject({ plugin: "okbot", instructions: "You are Ok." });
  });
});

describe("the move, again and held", () => {
  test("a bot whose plugin the person switched off goes straight into the archive, whole; a failed one is tried again at the next start", async () => {
    const root = tempDir();
    const home = tempDir();
    const clock = new FakeClock();
    const sleepy = writePlugin(root, "sleepy", { "moss.json": botManifest("sleepy", "Sleepy"), "bot/instructions.md": "You are Sleepy." });
    const broken = writePlugin(root, "broken", { "moss.json": botManifest("broken", "Broken"), "bot/instructions.md": "" });
    const plugins = [
      ...(await pluginFromFolder(sleepy)).inputs.map((i) => ({ ...i, approved: true, enabled: false })),
      ...(await pluginFromFolder(broken)).inputs.map((i) => ({ ...i, approved: true })),
    ];
    const first = await boot({ home, clock, plugins, botSource: "records" });
    const journal = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    const by = Object.fromEntries(journal.bots.map((b) => [b.id, b]));
    expect(by["sleepy"]).toEqual({ outcome: "moved", id: "sleepy", plugin: "sleepy" });
    expect(by["broken"]).toMatchObject({ outcome: "failed", why: expect.stringContaining("empty") });
    expect(first.bots.list().map((v) => v.id)).toEqual([]);
    expect(first.bots.archivedBots()).toMatchObject([{ id: "sleepy", name: "Sleepy" }]);
    expect(existsSync(join(home, "archive", "bots", "sleepy", "bot", "bot.json"))).toBe(true);
    await first.shutdown();
    // Fixed by its author, the failed one moves at the next start; the archived one stays archived and settled.
    writeFileSync(join(broken, "bot", "instructions.md"), "You are Broken, fixed.");
    const again = await boot({ home, clock, plugins: [...plugins], botSource: "records" });
    const second = BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
    expect(Object.fromEntries(second.bots.map((b) => [b.id, b.outcome]))).toEqual({ sleepy: "moved", broken: "moved" });
    expect(again.bots.list().map((v) => v.id)).toEqual(["broken"]);
    expect(again.bots.archivedBots().map((a) => a.id)).toEqual(["sleepy"]);
    // The person brings Sleepy back on purpose.
    await again.bots.restoreBot("sleepy");
    expect(again.bots.list().map((v) => v.id).sort()).toEqual(["broken", "sleepy"]);
    await again.shutdown();
  });

  test("an unreadable journal holds the move and bot.move.status says why", async () => {
    const home = tempDir();
    mkdirSync(join(home, "user-layers", "moved"), { recursive: true });
    writeFileSync(journalPath(home), "{ broken");
    const b = await boot({ home, plugins: await fixturePlugins(tempDir()), botSource: "records" });
    const status = await b.side.methods({ localDevice: "x" })["bot.move.status"]!({}, { caller: USER } as never) as { held?: { reason: string }; pending: string[] };
    expect(status.held?.reason).toContain("can't be read");
    expect(status.pending.sort()).toEqual(["alpha", "crew/luna", "rogue", "scout"]);
    await b.shutdown();
  });
});

describe("a state that can be passing at a start", () => {
  test("a bot of an invalid or refused plugin isn't moved or archived: it is failed with its state and tried again at the next start", async () => {
    const { pluginBotsForMove } = await import("../move");
    const root = tempDir();
    const folder = writePlugin(root, "flaky", { "moss.json": botManifest("flaky", "Flaky"), "bot/instructions.md": "You are Flaky." });
    const off = writePlugin(root, "offbot", { "moss.json": botManifest("offbot", "Off"), "bot/instructions.md": "You are Off." });
    const manifest = (id: string) => ({ contributes: { bot: { name: id, instructions: "bot/instructions.md" } } });
    const rec = (id: string, f: string, state: string, enabled: boolean, reason?: string) => ({ id, folder: f, source: "local", okHash: "h", state, enabled, manifest: manifest(id), ...(reason === undefined ? {} : { reason }) });
    let records: Record<string, unknown>[] = [rec("flaky", folder, "invalid", true, "its manifest didn't read"), rec("offbot", off, "off", false)];
    const registry = { list: () => records, entries: () => [], get: (id: string) => records.find((r) => r.id === id) } as never;
    const first = pluginBotsForMove(registry, tempDir());
    expect(first.map((b) => [b.id, b.failed ?? "ok", b.archive ?? false])).toEqual([
      ["flaky", "its plugin is invalid (its manifest didn't read); it is tried again at the next start", false],
      ["offbot", "ok", true],
    ]);
    records = [rec("flaky", folder, "refused", true)];
    expect(pluginBotsForMove(registry, tempDir())[0]).toMatchObject({ failed: expect.stringContaining("refused") });
    // Through the store: failed, not archived; once the plugin reads again, moved live at the next start.
    const { BotRecordStore } = await import("../records");
    const home = tempDir();
    const clock = new FakeClock();
    const store = new BotRecordStore({ home, clock });
    records = [rec("flaky", folder, "invalid", true)];
    expect((await store.move(pluginBotsForMove(registry, home))).bots).toMatchObject([{ outcome: "failed", id: "flaky" }]);
    expect(store.archived()).toEqual([]);
    expect(store.get("flaky")).toBeUndefined();
    records = [rec("flaky", folder, "running", true)];
    expect((await store.move(pluginBotsForMove(registry, home))).bots).toEqual([{ outcome: "moved", id: "flaky", plugin: "flaky" }]);
    expect(store.get("flaky")).toMatchObject({ madeBy: { kind: "move", plugin: "flaky" } });
    expect(store.archived()).toEqual([]);
  });
});
