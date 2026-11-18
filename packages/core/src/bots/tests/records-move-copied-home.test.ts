// The one-time move on a home copied from the plugin era (lane BT, round 4): which bots it moves is decided from what
// the home holds, not from the moment it first runs (move.ts). The fixture home first runs as the plugin era did
// (plugins as the source), so each bot has its conversation, its state file and its memory, the way an old-app home
// does; then its plugins change as a copy leaves them, and records become the source:
//   sprout      its plugin gone (removed before the split), with the person's layer over it
//   notes/keeper  a pack's bot whose pack is gone (its folder `notes--keeper`)
//   waiter      its plugin there, waiting for its OK again (its files changed for MOSS)
//   sleepy      its plugin there, switched off
//   late        its plugin's folder there, not listed at the first start (found late), listed at the next
//   newbie      a bot plugin installed after the move's first completion: never a bot
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_MOVE_JOURNAL, BotMoveJournal, type Caller } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import type { FakePluginInput } from "../../contracts/fakes/plugin-registry";
import { projectRecords } from "../../sessions/wire";
import { leftoverBotsForMove, pendingPluginBots, pluginBotsForMove, preSplitBots } from "../move";
import { recordFile } from "../records";
import { boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin, type Boot } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };
const user = (text: string, id = `m-${text}`) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });
const journalPath = (home: string) => join(home, ...BOT_MOVE_JOURNAL.split("/"));
const readJournal = (home: string) => BotMoveJournal.parse(JSON.parse(readFileSync(journalPath(home), "utf8")));
const outcomes = (home: string) => Object.fromEntries(readJournal(home).bots.map((b) => [b.id, b.outcome]));
const said = (b: { host: Boot["host"] }, session: string) =>
  projectRecords(b.host.history(session), { kind: "bot" }).filter((e) => e.type === "user_message").map((e) => (e as unknown as { text: string }).text);

async function inputs(dir: string, o: { approved?: boolean; enabled?: boolean } = {}): Promise<FakePluginInput[]> {
  return (await pluginFromFolder(dir)).inputs.map((i) => ({ ...i, approved: o.approved ?? true, ...(o.enabled === undefined ? {} : { enabled: o.enabled }) }));
}

/** A home as the plugin era left it: each bot ran and has a conversation; sprout has the person's layer. */
async function pluginEraHome(clock: FakeClock) {
  const home = tempDir();
  const plugins = join(home, "plugins");
  const dirs = {
    sprout: writePlugin(plugins, "sprout", { "moss.json": botManifest("sprout", "Sprout"), "bot/instructions.md": "You are Sprout." }),
    notes: writePlugin(plugins, "notes", { "moss.json": { manifest: 1, id: "notes", name: "Notes" }, "plugins/keeper/moss.json": botManifest(undefined, "Notes keeper"), "plugins/keeper/bot/instructions.md": "You keep notes." }),
    waiter: writePlugin(plugins, "waiter", { "moss.json": botManifest("waiter", "Waiter"), "bot/instructions.md": "You are Waiter." }),
    sleepy: writePlugin(plugins, "sleepy", { "moss.json": botManifest("sleepy", "Sleepy"), "bot/instructions.md": "You are Sleepy." }),
    late: writePlugin(plugins, "late", { "moss.json": botManifest("late", "Late"), "bot/instructions.md": "You are Late." }),
  };
  const all = [...await inputs(dirs.sprout), ...await inputs(dirs.notes), ...await inputs(dirs.waiter), ...await inputs(dirs.sleepy), ...await inputs(dirs.late)];
  const era = await boot({ home, clock, plugins: all });
  expect(era.bots.list().map((v) => v.id).sort()).toEqual(["late", "notes/keeper", "sleepy", "sprout", "waiter"]);
  await era.bots.setUserLayer("sprout", { name: "Sprout, mine", model: "acme/large" }, USER);
  for (const s of ["b_sprout", "b_notes--keeper", "b_waiter", "b_sleepy", "b_late"]) {
    await era.host.sendUser(s, user(`hello ${s}`));
    await flush();
    era.drivers.for(s).end({ text: "hi" });
    await flush();
  }
  await era.shutdown();
  clock.advance(60_000);
  // The copy: sprout's plugin and the notes pack were removed before it; the rest came over.
  rmSync(dirs.sprout, { recursive: true });
  rmSync(dirs.notes, { recursive: true });
  return { home, dirs };
}

describe("the move on a home copied from the plugin era", () => {
  test("a bot whose plugin is gone, waiting for its OK, off or found late is moved; a plugin installed after makes no bot; two starts", async () => {
    const clock = new FakeClock();
    const { home, dirs } = await pluginEraHome(clock);
    const waiting = await inputs(dirs.waiter, { approved: false });
    const off = await inputs(dirs.sleepy, { enabled: false });

    // First start: `late`'s folder is there but the registry doesn't list it yet.
    const first = await boot({ home, clock, plugins: [...waiting, ...off], botSource: "records" });
    const j1 = readJournal(home);
    expect(outcomes(home)).toEqual({ waiter: "moved", sleepy: "moved", sprout: "moved", "notes/keeper": "moved", late: "failed" });
    expect(j1.bots.find((b) => b.id === "late")).toMatchObject({ why: expect.stringContaining("hasn't listed it yet") });
    // Each bot is in the journal once.
    expect(new Set(j1.bots.map((b) => b.id)).size).toBe(j1.bots.length);
    // Waiting for its OK: moved now, listed, its files' instructions, its old conversation.
    expect(first.bots.list().map((v) => v.id)).toEqual(["waiter"]);
    expect(first.bots.records!.get("waiter")).toMatchObject({ name: "Waiter", madeBy: { kind: "move", plugin: "waiter" }, mainSession: "b_waiter" });
    expect(first.bots.records!.instructions("waiter")).toBe("You are Waiter.");
    expect(said(first, "b_waiter")).toEqual(["hello b_waiter"]);
    // Off, and gone: in the archive, whole. The gone ones from the plugin era's records: the person's layer, else the
    // conversation's title; no instructions (their file went with the plugin).
    const archived = Object.fromEntries(first.bots.archivedBots().map((a) => [a.id, a.name]));
    expect(archived).toEqual({ sleepy: "Sleepy", sprout: "Sprout, mine", "notes/keeper": "Notes keeper" });
    expect(existsSync(join(home, "archive", "bots", "notes--keeper", "transcripts"))).toBe(true);
    const status = await first.side.methods({ localDevice: "x" })["bot.move.status"]!({}, { caller: USER } as never);
    expect(status).toEqual({ journal: j1, pending: ["late"] });
    await first.shutdown();

    // Second start: `late` is listed now (found late), `waiter` OK'd, and `newbie` installed after the first completion.
    clock.advance(60_000);
    const newbie = writePlugin(join(home, "plugins"), "newbie", { "moss.json": botManifest("newbie", "Newbie"), "bot/instructions.md": "You are Newbie." });
    const plugins2 = [...await inputs(dirs.waiter), ...off, ...await inputs(dirs.late, { approved: false }), ...await inputs(newbie)];
    const second = await boot({ home, clock, plugins: plugins2, botSource: "records" });
    const j2 = readJournal(home);
    expect(outcomes(home)).toEqual({ waiter: "moved", sleepy: "moved", sprout: "moved", "notes/keeper": "moved", late: "moved" });
    expect(j2.at).toBe(j1.at);
    expect(second.bots.list().map((v) => v.id).sort()).toEqual(["late", "waiter"]);
    expect(said(second, "b_late")).toEqual(["hello b_late"]);
    expect(second.bots.records!.instructions("late")).toBe("You are Late.");
    // After its OK, the waiting plugin's bot is still listed with its old conversation.
    expect(said(second, "b_waiter")).toEqual(["hello b_waiter"]);
    expect(second.bots.records!.get("newbie")).toBeUndefined();
    expect(existsSync(recordFile(home, "newbie"))).toBe(false);
    expect((await second.side.methods({ localDevice: "x" })["bot.move.status"]!({}, { caller: USER } as never) as { pending: string[] }).pending).toEqual([]);
    // The gone bot comes back whole when the person restores it.
    await second.bots.restoreBot("sprout");
    expect(second.bots.records!.get("sprout")).toMatchObject({ name: "Sprout, mine", model: "acme/large", madeBy: { kind: "move", plugin: "sprout" } });
    expect(said(second, "b_sprout")).toEqual(["hello b_sprout"]);
    await second.shutdown();

    // Third start, nothing new: the journal is byte for byte the same; newbie is still no bot.
    const bytes = readFileSync(journalPath(home), "utf8");
    const third = await boot({ home, clock, plugins: plugins2, botSource: "records" });
    expect(readFileSync(journalPath(home), "utf8")).toBe(bytes);
    expect(third.bots.list().map((v) => v.id).sort()).toEqual(["late", "sprout", "waiter"]);
    await third.shutdown();
  });

  test("a bot the person archived, or whose files they removed, since the move is not brought back", async () => {
    const clock = new FakeClock();
    const { home, dirs } = await pluginEraHome(clock);
    const plugins = [...await inputs(dirs.waiter), ...await inputs(dirs.sleepy), ...await inputs(dirs.late)];
    const first = await boot({ home, clock, plugins, botSource: "records" });
    expect(first.bots.list().map((v) => v.id).sort()).toEqual(["late", "sleepy", "waiter"]);
    await first.bots.archiveBot("waiter");
    await first.shutdown();
    // The person deletes late's files by hand (record, conversation, archive and all).
    rmSync(join(home, "bots", "late"), { recursive: true });
    rmSync(join(home, "transcripts", "late"), { recursive: true });
    // And sprout's archive.
    rmSync(join(home, "archive", "bots", "sprout"), { recursive: true });
    clock.advance(1000);
    const again = await boot({ home, clock, plugins, botSource: "records" });
    expect(again.bots.list().map((v) => v.id)).toEqual(["sleepy"]);
    expect(again.bots.archivedBots().map((a) => a.id).sort()).toEqual(["notes/keeper", "waiter"]);
    expect(outcomes(home)).toEqual({ waiter: "moved", sleepy: "moved", late: "moved", sprout: "moved", "notes/keeper": "moved" });
    await again.shutdown();
  });

  test("a home whose earlier move took only Alpha (the late reload of an older journal) moves the rest at its next start", async () => {
    const clock = new FakeClock();
    const { home, dirs } = await pluginEraHome(clock);
    // The journal an earlier build wrote at the copy's first start: only the default bot, after every bot's first day.
    mkdirSync(join(home, "user-layers", "moved"), { recursive: true });
    const old = { move: 1, at: clock.now(), bots: [{ outcome: "moved", id: "alpha", plugin: "alpha" }] };
    writeFileSync(journalPath(home), `${JSON.stringify(old, null, 2)}\n`);
    clock.advance(1000);
    const plugins = [...await inputs(dirs.waiter, { approved: false }), ...await inputs(dirs.sleepy), ...await inputs(dirs.late)];
    const b = await boot({ home, clock, plugins, botSource: "records" });
    expect(outcomes(home)).toEqual({ alpha: "moved", waiter: "moved", sleepy: "moved", late: "moved", sprout: "moved", "notes/keeper": "moved" });
    expect(readJournal(home).at).toBe(old.at);
    expect(b.bots.list().map((v) => v.id).sort()).toEqual(["late", "sleepy", "waiter"]);
    expect(b.bots.archivedBots().map((a) => a.id).sort()).toEqual(["notes/keeper", "sprout"]);
    await b.shutdown();
  });
});

describe("what tells a pre-split bot from a later one", () => {
  test("the plugin era's state file and conversation meta, as the old app wrote them, dated before the first completion", () => {
    const home = tempDir();
    const put = (seg: string, name: string, body: object) => {
      mkdirSync(join(home, "transcripts", seg), { recursive: true });
      writeFileSync(join(home, "transcripts", seg, name), `${JSON.stringify(body, null, 2)}\n`);
    };
    // Shaped as the old app (build 3a3e247e3) left them in its home.
    put("ws-sprout", "bot.json", { bot: "ws-sprout", firstSeen: 1794911669042, seededMemory: true });
    put("ws-sprout", "b_ws-sprout.meta.json", { meta: 1, id: "b_ws-sprout", kind: "bot", startedAt: 1794911669059, computer: "Delta", title: "Workshop sprout", model: "anthropic/claude-fable-5", bot: "ws-sprout" });
    put("example-notes--bot", "bot.json", { bot: "example-notes/bot", firstSeen: 1794911426040, seededMemory: true });
    put("example-notes--bot", "b_example-notes--bot.meta.json", { meta: 1, id: "b_example-notes--bot", kind: "bot", startedAt: 1794911426054, computer: "Delta", title: "Notes keeper", model: "anthropic/claude-sonnet-5-5", effort: "low", bot: "example-notes/bot" });
    // A conversation meta alone (a computer that didn't run the bots writes no state file).
    put("acc-juniper", "b_acc-juniper.meta.json", { meta: 1, id: "b_acc-juniper", kind: "bot", startedAt: 1794911324834, title: "Juniper", bot: "acc-juniper" });
    // Not a bot's: a state file naming another folder's bot, a coding session's folder, a routine folder.
    put("impostor", "bot.json", { bot: "someone-else", firstSeen: 1 });
    put("_", "agent_x.meta.json", { meta: 1, id: "agent_x", kind: "agent", startedAt: 1 });
    put("routines", "state.json", {});
    // A bot made after the first completion (a record bot of the records era, its files gone): not pre-split.
    put("nova", "b_nova.meta.json", { meta: 1, id: "b_nova", kind: "bot", startedAt: 1794984400000, title: "Nova", bot: "nova" });
    const before = 1794984372928;
    const found = preSplitBots(home, before);
    expect([...found.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "acc-juniper", at: 1794911324834, title: "Juniper" },
      { id: "example-notes/bot", at: 1794911426040, title: "Notes keeper" },
      { id: "ws-sprout", at: 1794911669042, title: "Workshop sprout" },
    ]);
    // With no journal yet, every date counts.
    expect([...preSplitBots(home, undefined).keys()].sort()).toEqual(["acc-juniper", "example-notes/bot", "nova", "ws-sprout"]);
    // A link in place of a state file is no record of a bot.
    rmSync(join(home, "transcripts", "acc-juniper", "b_acc-juniper.meta.json"));
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(home, "transcripts", "ws-sprout", "b_ws-sprout.meta.json"), join(home, "transcripts", "acc-juniper", "b_acc-juniper.meta.json"));
    expect(preSplitBots(home, before).has("acc-juniper")).toBe(false);
  });

  test("with a journal, a listed plugin the journal doesn't name and the home holds no record of is never a bot to move", () => {
    const home = tempDir();
    const folder = writePlugin(join(home, "plugins"), "later", { "moss.json": botManifest("later", "Later"), "bot/instructions.md": "You are Later." });
    const record = { id: "later", folder, source: "local", okHash: "h", state: "running", enabled: true, manifest: { contributes: { bot: { name: "Later", instructions: "bot/instructions.md" } } } };
    const registry = { list: () => [record], entries: () => [], get: (id: string) => (id === "later" ? record : undefined) } as never;
    // No journal: the first run, so it is.
    expect(pluginBotsForMove(registry, home, undefined).map((b) => b.id)).toEqual(["later"]);
    const journal = BotMoveJournal.parse({ move: 1, at: 1000, bots: [] });
    expect(pluginBotsForMove(registry, home, journal)).toEqual([]);
    expect(leftoverBotsForMove(registry, home, journal)).toEqual([]);
    expect(pendingPluginBots(registry, home, () => false, journal)).toEqual([]);
    // The person's own bot of the records era, dated before a journal an older build kept rewriting (its `at` the last
    // change): its conversation is no plugin bot's, so it isn't one to move, live or archived.
    mkdirSync(join(home, "transcripts", "nova"), { recursive: true });
    writeFileSync(join(home, "transcripts", "nova", "b_nova.meta.json"), JSON.stringify({ meta: 1, id: "b_nova", kind: "bot", startedAt: 500, title: "Nova", bot: "nova" }));
    mkdirSync(join(home, "bots", "nova"), { recursive: true });
    writeFileSync(join(home, "bots", "nova", "bot.json"), JSON.stringify({ record: 1, id: "nova", name: "Nova", madeBy: { kind: "user" }, createdAt: 500 }));
    expect(leftoverBotsForMove(registry, home, journal)).toEqual([]);
    rmSync(join(home, "bots", "nova"), { recursive: true });
    mkdirSync(join(home, "archive", "bots", "nova", "bot"), { recursive: true });
    writeFileSync(join(home, "archive", "bots", "nova", "bot", "bot.json"), JSON.stringify({ record: 1, id: "nova", name: "Nova", madeBy: { kind: "user" }, createdAt: 500 }));
    expect(leftoverBotsForMove(registry, home, journal)).toEqual([]);
    // Its files gone with no record anywhere, it would be read as the plugin era's (the date rule is what holds then).
    rmSync(join(home, "archive"), { recursive: true });
    expect(leftoverBotsForMove(registry, home, journal).map((b) => b.id)).toEqual(["nova"]);
    rmSync(join(home, "transcripts", "nova"), { recursive: true });
    // Named by the journal (a failed entry of a run before): it is.
    const named = BotMoveJournal.parse({ move: 1, at: 1000, bots: [{ outcome: "failed", id: "later", plugin: "later", why: "x" }] });
    expect(pluginBotsForMove(registry, home, named).map((b) => b.id)).toEqual(["later"]);
    expect(pendingPluginBots(registry, home, () => false, named)).toEqual(["later"]);
  });
});
