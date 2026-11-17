// Bots as engine data through the bot side (lane BT), on temp homes, with records as the source (`botSource:
// "records"`): a bot is made and answers in its one conversation, its line and unread state in MOSS's list, its
// instructions read fresh at each turn, a bot making a bot behind the person's card, another bot's instructions behind
// a card, remove and bring back (in one process and across a restart), and a coding task that carries its bot.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_ARCHIVE_DIR, MAKE_BOT_TOOL, type Caller } from "@waifucave/moss-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { sessionLogPath } from "../../sessions/ids";
import { projectRecords } from "../../sessions/wire";
import { activitySubjectOf, botHasCodingWork } from "../activity";
import { instructionsFile, recordFile } from "../records";
import { EDIT_BOT_INSTRUCTIONS_TOOL } from "../records-tools";
import { botSource, DEFAULT_BOT_SOURCE } from "../source";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const USER: Caller = { kind: "user", client: "app" };
const user = (text: string, id = `m-${text}`) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });

async function recordsBoot(home: string, clock = new FakeClock(), broker?: FakeApprovalBroker) {
  // Every model is set up but `acme/unset`.
  return boot({
    home, clock, plugins: [], botSource: "records", ...(broker === undefined ? {} : { approvals: broker }),
    modelOffer: (m) => (m === "acme/unset" ? "absent" : "offered"),
  });
}

/** The methods as a client calls them. */
function methods(b: Awaited<ReturnType<typeof recordsBoot>>) {
  const all = b.side.methods({ localDevice: "studio0000000000000" });
  return (name: string, params: unknown, caller: Caller = USER) => all[name]!(params, { caller } as never) as Promise<Record<string, unknown>>;
}

/** Answers the newest card of `broker` with its first option of `kind`. */
async function press(broker: FakeApprovalBroker, clock: FakeClock, kind: "approve" | "deny"): Promise<ReturnType<FakeApprovalBroker["cards"]>[number]> {
  for (let i = 0; i < 50 && broker.cards().length === 0; i++) await flush();
  const card = broker.cards().at(-1)!;
  const option = card.options.find((o) => o.kind === kind)!;
  const r = await broker.answer(card.id, { optionId: option.id, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: clock.now() } }, { role: "app" });
  expect(r).toBe("accepted");
  return card;
}

describe("the switch", () => {
  test("its default is records (lane MC); MOSS_BOT_SOURCE=plugins turns the old source on, anything else leaves it", () => {
    expect(DEFAULT_BOT_SOURCE).toBe("records");
    expect(botSource({})).toBe("records");
    expect(botSource({ MOSS_BOT_SOURCE: "plugins" })).toBe("plugins");
    expect(botSource({ MOSS_BOT_SOURCE: "yes" })).toBe("records");
  });

  test("with plugins as the source the record methods aren't served (but the move's status is), and no record tool is offered", async () => {
    const b = await boot({ home: tempDir(), plugins: [] });
    const all = b.side.methods({ localDevice: "studio0000000000000" });
    expect(all["bot.create"]).toBeUndefined();
    expect(all["bot.records"]).toBeUndefined();
    expect(await all["bot.move.status"]!({}, { caller: USER } as never)).toEqual({ pending: [] });
    expect(b.bots.records).toBeUndefined();
    await b.shutdown();
  });
});

describe("a bot as engine data", () => {
  test("bot.create makes a record and its instructions file; its one conversation opens and answers; its line and unread state follow", async () => {
    const home = tempDir();
    const b = await recordsBoot(home);
    const call = methods(b);
    const made = (await call("bot.create", { name: "Nova", instructions: "You are Nova.", model: "acme/large", face: { color: "lagoon" } })).bot as Record<string, unknown>;
    expect(made).toMatchObject({ id: "nova", model: "acme/large", face: { color: "lagoon" }, madeBy: { kind: "user" }, mainSession: "b_nova", instructionsBytes: 13 });
    expect(JSON.parse(readFileSync(recordFile(home, "nova"), "utf8"))).toMatchObject({ record: 1, id: "nova", name: "Nova" });
    expect(readFileSync(instructionsFile(home, "nova"), "utf8")).toBe("You are Nova.");
    // A bot's call never counts as the person's.
    await expect(call("bot.create", { name: "Rogue" }, { kind: "session", sessionId: "b_nova", sessionKind: "bot", bot: "nova" } as Caller)).rejects.toThrow();
    // The service lists it; its conversation is open on the record's model, with its instructions.
    expect(b.bots.get("nova")).toMatchObject({ id: "nova", name: "Nova", model: "acme/large", mainSession: "b_nova", state: "idle" });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_nova")!.ctx;
    expect(ctx.current()).toMatchObject({ instructions: "You are Nova.", model: "acme/large", modelFrom: "user" });
    // One turn in its one conversation.
    await b.host.sendUser("b_nova", user("hi Nova"));
    await flush();
    const d = b.drivers.for("b_nova");
    d.emit({ type: "assistant_message", text: "Hi! I'm Nova.\nHow can I help?" });
    d.end({ text: "Hi! I'm Nova." });
    await flush();
    const summaries = (await call("bot.summaries", {})).summaries as { id: string; last?: { text: string; from: string; at: number }; unread: boolean }[];
    expect(summaries).toEqual([{ id: "nova", last: { text: "Hi! I'm Nova. How can I help?", from: "bot", at: expect.any(Number) }, unread: true }]);
    await call("bot.markRead", { id: "nova", at: summaries[0]!.last!.at });
    expect(((await call("bot.summaries", {})).summaries as { unread: boolean }[])[0]!.unread).toBe(false);
    // Its instructions, for the person's own client only.
    expect(await call("bot.instructions.get", { id: "nova" })).toEqual({ text: "You are Nova." });
    for (const caller of [{ kind: "plugin", pluginId: "spy" }, { kind: "session", sessionId: "b_nova", sessionKind: "bot", bot: "nova" }, { kind: "session", sessionId: "a_1", sessionKind: "agent", bot: "nova" }, { kind: "peer", device: "d1" }] as Caller[]) {
      await expect(call("bot.instructions.get", { id: "nova" }, caller)).rejects.toThrow();
    }
    // The conversation, a page at a time, newest last.
    const page = await call("bot.conversation", { id: "nova", limit: 1 });
    expect(page).toMatchObject({ session: "b_nova", hasMore: true });
    expect((page.events as { type: string }[]).map((e) => e.type)).toEqual(["turn_completed"]);
    const whole = await call("bot.conversation", { id: "nova", limit: 50 });
    expect((whole.events as { type: string; text?: string }[]).filter((e) => e.type === "user_message" || e.type === "assistant_message").map((e) => e.text)).toEqual(["hi Nova", "Hi! I'm Nova.\nHow can I help?"]);
    // The record events reached the bot side's listeners.
    await b.shutdown();
  });

  test("its instructions are read fresh at each turn: the bot's own Write reaches its next turn; the person's edit too", async () => {
    const home = tempDir();
    const b = await recordsBoot(home);
    await b.bots.createBot({ name: "Nova", instructions: "v1" }, { kind: "user" });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === "b_nova")!.ctx;
    expect(ctx.current().instructions).toBe("v1");
    writeFileSync(instructionsFile(home, "nova"), "v2, as the bot wrote it");
    expect(ctx.current().instructions).toBe("v2, as the bot wrote it");
    await b.bots.editBot("nova", { instructions: "v3", model: "acme/small", name: "Nova Prime" });
    expect(ctx.current()).toMatchObject({ instructions: "v3", model: "acme/small", name: "Nova Prime" });
    expect(b.host.get("b_nova")).toMatchObject({ title: "Nova Prime", model: "acme/small" });
    // Today's Edit page (bot.setUserLayer) changes the record too.
    await b.bots.setUserLayer("nova", { model: null, instructions: "v4" }, USER);
    expect(ctx.current()).toMatchObject({ instructions: "v4", model: "fireworks/kimi-k3", modelFrom: "default" });
    await b.shutdown();
  });

  test("bot.remove archives the bot whole and bot.restore brings it back to the same conversation, in one process and across a restart", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    let b = await recordsBoot(home, clock);
    let call = methods(b);
    await call("bot.create", { name: "Nova", instructions: "You are Nova." });
    await b.host.sendUser("b_nova", user("remember this"));
    await flush();
    b.drivers.for("b_nova").end({ text: "ok" });
    await flush();
    writeFileSync(join(home, "bots", "nova", "memory", "MEMORY.md"), "- the user said remember this\n");
    const before = projectRecords(b.host.history("b_nova"), { kind: "bot" }).length;
    // Its coding task: a code session carrying its id, whose log lives in transcripts/nova/ with its conversation.
    b.host.open({ id: "a_task", kind: "agent", bot: "nova", computer: "Studio", title: "fix it" }, new FakeSessionDriver());
    expect(sessionLogPath(home, "nova", "a_task")).toContain(join("transcripts", "nova"));
    await call("bot.remove", { id: "nova" });
    expect(b.bots.list()).toEqual([]);
    expect((await call("bot.records", {})).bots).toEqual([]);
    expect((await call("bot.archived", {})).bots).toEqual([{ id: "nova", name: "Nova", archivedAt: expect.any(Number) }]);
    // Everything moved, nothing deleted.
    const archive = join(home, ...BOT_ARCHIVE_DIR.split("/"), "nova");
    expect(existsSync(join(archive, "bot", "bot.json"))).toBe(true);
    expect(existsSync(join(archive, "bot", "memory", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(archive, "transcripts", "b_nova.jsonl")) || existsSync(join(archive, "transcripts"))).toBe(true);
    expect(existsSync(sessionLogPath(home, "nova", "b_nova"))).toBe(false);
    expect(b.host.get("b_nova")).toBeUndefined();
    // The task went with it: stopped, let go of, its log in the archive.
    expect(b.host.get("a_task")).toBeUndefined();
    expect(existsSync(join(archive, "transcripts", "a_task.meta.json")) || readdirSync(join(archive, "transcripts")).some((f) => f.startsWith("a_task"))).toBe(true);
    // Its id is held while it is archived.
    expect(((await call("bot.create", { name: "Nova" })).bot as { id: string }).id).toBe("nova-2");
    // Back, in the same process: the same conversation, whole, and the next turn appends to it.
    expect(((await call("bot.restore", { id: "nova" })).bot as { id: string }).id).toBe("nova");
    expect(projectRecords(b.host.history("b_nova"), { kind: "bot" }).length).toBe(before);
    expect(readFileSync(join(home, "bots", "nova", "memory", "MEMORY.md"), "utf8")).toContain("remember this");
    await b.host.sendUser("b_nova", user("still there?"));
    await flush();
    expect(b.drivers.for("b_nova").turns.at(-1)?.input).toMatchObject({ from: "user", text: "still there?" });
    b.drivers.for("b_nova").end({ text: "yes" });
    await flush();
    // Removed again, the daemon restarts, and it comes back after the restart.
    await call("bot.remove", { id: "nova" });
    await b.shutdown();
    b = await recordsBoot(home, clock);
    call = methods(b);
    expect(b.bots.list().map((v) => v.id)).toEqual(["nova-2"]);
    expect((await call("bot.archived", {})).bots).toMatchObject([{ id: "nova" }]);
    await call("bot.restore", { id: "nova" });
    const texts = projectRecords(b.host.history("b_nova"), { kind: "bot" }).filter((e) => e.type === "user_message").map((e) => e.text);
    expect(texts).toEqual(["remember this", "still there?"]);
    const seqs = b.host.history("b_nova").map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(b.host.get("b_nova")).toMatchObject({ kind: "bot", bot: "nova", title: "Nova" });
    // After a restart and the restore, the task is back, ended, still carrying its bot's id.
    expect(b.host.get("a_task")).toMatchObject({ kind: "agent", bot: "nova", status: "stopped" });
    expect(b.warnings.filter((w) => w.includes("no readable meta"))).toEqual([]);
    await b.shutdown();
  });

  test("a bot makes a bot only behind the person's card, which names it and shows the new bot's instructions; a no makes nothing", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const broker = new FakeApprovalBroker({ clock });
    const b = await recordsBoot(home, clock, broker);
    await b.bots.createBot({ name: "Alpha", model: "acme/large" }, { kind: "default" });
    const make = b.side.tools("b_alpha").find((t) => t.name === MAKE_BOT_TOOL)!;
    expect(make).toBeDefined();
    const running = make.run({ name: "Scout", instructions: "Find things.", face: { shape: "drop" } });
    const card = await press(broker, clock, "approve");
    expect(JSON.stringify(card.fields)).toContain("alpha");
    expect(JSON.stringify(card.fields)).toContain("Find things.");
    expect(JSON.stringify(card.fields)).toContain("acme/large");
    expect(await running).toMatchObject({ isError: false });
    expect(b.bots.get("scout")).toMatchObject({ id: "scout", model: "acme/large", state: "idle" });
    expect(b.bots.records!.get("scout")).toMatchObject({ madeBy: { kind: "bot", id: "alpha" }, face: { shape: "drop" } });
    expect(b.bots.records!.instructions("scout")).toBe("Find things.");
    // Its own conversation is open.
    expect(b.host.get("b_scout")).toMatchObject({ kind: "bot", bot: "scout" });
    // A no makes nothing.
    const declined = make.run({ name: "Maybe" });
    await press(broker, clock, "deny");
    expect(await declined).toMatchObject({ isError: true });
    expect(b.bots.records!.get("maybe")).toBeUndefined();
    // A model the person hasn't set up is refused before any card.
    const cards = broker.cards().length;
    expect(await make.run({ name: "Rogue", model: "acme/unset" })).toMatchObject({ isError: true });
    expect(broker.cards().length).toBe(cards);
    expect(b.bots.records!.get("rogue")).toBeUndefined();
    // At most PROPOSALS_PER_MAKER wait at once.
    const waiting = [make.run({ name: "W1" }), make.run({ name: "W2" }), make.run({ name: "W3" })];
    for (let i = 0; i < 50 && b.bots.records!.proposals().length < 3; i++) await flush();
    expect(await make.run({ name: "W4" })).toMatchObject({ isError: true, text: expect.stringContaining("waiting") });
    for (let i = 0; i < 3; i++) await press(broker, clock, "deny");
    await Promise.all(waiting);
    // An agent's session gets no MakeBot.
    b.host.open({ id: "a_task", kind: "agent", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    expect(b.side.tools("a_task").some((t) => t.name === MAKE_BOT_TOOL)).toBe(false);
    await b.shutdown();
  });

  test("another bot's instructions change only behind the person's card; the maker's and its own need none", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const broker = new FakeApprovalBroker({ clock });
    const b = await recordsBoot(home, clock, broker);
    await b.bots.createBot({ name: "Alpha", instructions: "a1" }, { kind: "user" });
    await b.bots.createBot({ name: "Luna", instructions: "l1" }, { kind: "user" });
    const edit = (session: string) => b.side.tools(session).find((t) => t.name === EDIT_BOT_INSTRUCTIONS_TOOL)!;
    const pending = edit("b_alpha").run({ bot: "luna", instructions: "l2, by Alpha" });
    const card = await press(broker, clock, "approve");
    expect(JSON.stringify(card.fields)).toContain("l2, by Alpha");
    expect(await pending).toMatchObject({ isError: false });
    expect(b.bots.records!.instructions("luna")).toBe("l2, by Alpha");
    const denied = edit("b_alpha").run({ bot: "luna", instructions: "l3" });
    await press(broker, clock, "deny");
    expect(await denied).toMatchObject({ isError: true });
    expect(b.bots.records!.instructions("luna")).toBe("l2, by Alpha");
    // Its own: no card.
    const cards = broker.cards().length;
    expect(await edit("b_alpha").run({ bot: "alpha", instructions: "a2" })).toMatchObject({ isError: false });
    expect(broker.cards().length).toBe(cards);
    expect(b.bots.records!.instructions("alpha")).toBe("a2");
    // Too long to show on a card: refused, never cut.
    expect(await edit("b_alpha").run({ bot: "luna", instructions: "x".repeat(70_000) })).toMatchObject({ isError: true });
    expect(b.bots.records!.instructions("luna")).toBe("l2, by Alpha");
    await b.shutdown();
  });

  test("a bot's coding task is a code session that carries its bot's id, and the bot shows it as work", async () => {
    const home = tempDir();
    const b = await recordsBoot(home);
    await b.bots.createBot({ name: "Alpha" }, { kind: "user" });
    const driver = new FakeSessionDriver();
    const view = b.host.open({ id: "a_fix", kind: "agent", bot: "alpha", computer: "Studio", title: "fix the build" }, driver);
    expect(activitySubjectOf(view)).toEqual({ kind: "sessions", id: "a_fix", bot: "alpha" });
    expect(activitySubjectOf(b.host.get("b_alpha")!)).toEqual({ kind: "bots", id: "alpha" });
    expect(botHasCodingWork(b.host.list(), "alpha")).toBe(false);
    await b.host.sendUser("a_fix", user("go"));
    await flush();
    expect(botHasCodingWork(b.host.list(), "alpha")).toBe(true);
    expect(botHasCodingWork(b.host.list(), "luna")).toBe(false);
    driver.end({ text: "done" });
    await flush();
    expect(botHasCodingWork(b.host.list(), "alpha")).toBe(false);
    await b.shutdown();
  });
});

describe("a bot builds a bot as a record, never as a plugin", () => {
  test("with records as the source, PluginInstall refuses a folder that brings a bot (or a child that does) and names MakeBot", async () => {
    const { refuseBotPlugins } = await import("../wiring");
    const { writePlugin, botManifest } = await import("./fixtures");
    const root = tempDir();
    const botty = writePlugin(root, "botty", { "moss.json": botManifest("botty", "Botty"), "bot/instructions.md": "x" });
    const packy = writePlugin(root, "packy", { "moss.json": { manifest: 1, id: "packy", name: "P" }, "plugins/kid/moss.json": botManifest(undefined, "Kid") });
    const tool = writePlugin(root, "tooly", { "moss.json": { manifest: 1, id: "tooly", name: "T" } });
    const ran: unknown[] = [];
    const install = refuseBotPlugins({ name: "PluginInstall", description: "", inputSchema: {}, run: async (i) => { ran.push(i); return { text: "installed", isError: false }; } },
      { resolveFolder: (_c, f) => join(root, f) }, { bot: "alpha", sessionId: "b_alpha" });
    expect(await install.run({ folder: "botty" })).toMatchObject({ isError: true, text: expect.stringContaining(MAKE_BOT_TOOL) });
    expect(await install.run({ folder: "packy" })).toMatchObject({ isError: true });
    expect(await install.run({ folder: "tooly" })).toEqual({ text: "installed", isError: false });
    expect(ran).toEqual([{ folder: "tooly" }]);
    void botty; void packy; void tool;
  });
});

describe("a plugin's bot-scoped settings, per bot", () => {
  test("read from the plugin host's own file and set through its setByUser; only bot-scoped fields; bot.pluginSettings lists them with their schema", async () => {
    const { pluginBotSettings } = await import("../plugin-bot-settings");
    const { memoryPluginSettings } = await import("../../plugin-host/api/settings");
    const backend = memoryPluginSettings();
    backend.write("speech-kit", { account: {}, device: {}, bot: { nova: { style: "bright" } } });
    const setCalls: unknown[][] = [];
    const registry = {
      list: () => [{ id: "speech-kit", manifest: { name: "Speech kit", settings: { style: { type: "string", scope: "bot", default: "plain" }, region: { type: "string" } } } }, { id: "plain", manifest: { name: "Plain" } }],
      get: (id: string) => (id === "speech-kit" ? { manifest: { name: "Speech kit" } } : undefined),
    } as never;
    const port = pluginBotSettings({
      registry, backend,
      settings: () => ({
        setByUser: async (...a: unknown[]) => { setCalls.push(a); return { applied: true }; },
        views: async () => [{ key: "style", type: "string", title: "Style", scope: "bot", required: false, value: "bright", set: true }, { key: "region", type: "string", title: "Region", scope: "account", required: false, set: false }],
      }) as never,
    });
    const home = tempDir();
    const b = await boot({ home, plugins: [], botSource: "records", pluginSettings: port });
    await b.bots.createBot({ name: "Nova" }, { kind: "user" });
    await b.bots.createBot({ name: "Luna" }, { kind: "user" });
    expect(b.bots.records!.pluginSettings("nova")).toEqual([{ pluginId: "speech-kit", settings: [{ key: "style", value: "bright", set: true }] }]);
    expect(b.bots.records!.pluginSettings("luna")).toEqual([{ pluginId: "speech-kit", settings: [{ key: "style", value: "plain", set: false }] }]);
    await b.bots.records!.setPluginSetting("luna", "speech-kit", "style", "soft");
    expect(setCalls).toEqual([["speech-kit", "style", "soft", "luna"]]);
    await expect(b.bots.records!.setPluginSetting("luna", "speech-kit", "region", "eu")).rejects.toThrow("isn't a setting per bot");
    const call = methods(b);
    expect(await call("bot.pluginSettings", { id: "nova" })).toEqual({ plugins: [{ pluginId: "speech-kit", name: "Speech kit", settings: [{ key: "style", type: "string", title: "Style", scope: "bot", required: false, value: "bright", set: true }] }] });
    await b.shutdown();
  });
});

describe("the instructions file is the bot's to write, so the core reads it as untrusted", () => {
  test("a link or a hard link planted at instructions.md is read as empty, never followed; a file past the cap isn't read", async () => {
    const { linkSync, rmSync, symlinkSync, mkdirSync } = await import("node:fs");
    const home = tempDir();
    const b = await recordsBoot(home);
    await b.bots.createBot({ name: "Nova", instructions: "mine" }, { kind: "user" });
    const file = instructionsFile(home, "nova");
    mkdirSync(join(home, "credentials"), { recursive: true });
    const secret = join(home, "credentials", "index.json");
    writeFileSync(secret, "PROBE_SECRET=dummy123");
    rmSync(file);
    symlinkSync(secret, file);
    const read1 = b.bots.records!.instructions("nova");
    rmSync(file);
    linkSync(secret, file);
    const read2 = b.bots.records!.instructions("nova");
    rmSync(file);
    writeFileSync(file, "x".repeat(900_000));
    const read3 = b.bots.records!.instructions("nova");
    // Only whether the dummy value was visible.
    expect([read1.includes("dummy123"), read2.includes("dummy123"), read3.length]).toEqual([false, false, 0]);
    expect(b.warnings.filter((w) => w.includes("instructions file wasn't read")).length).toBe(3);
    await b.shutdown();
  });
});

describe("read-only is absolute", () => {
  test("at the read-only level neither MakeBot nor EditBotInstructions runs, and no card is raised", async () => {
    const clock = new FakeClock();
    const broker = new FakeApprovalBroker({ clock });
    const b = await boot({ home: tempDir(), clock, plugins: [], botSource: "records", approvals: broker, levelOf: () => "read-only" });
    await b.bots.createBot({ name: "Alpha" }, { kind: "user" });
    await b.bots.createBot({ name: "Luna", instructions: "l1" }, { kind: "user" });
    const tools = b.side.tools("b_alpha");
    expect(await tools.find((t) => t.name === MAKE_BOT_TOOL)!.run({ name: "Scout" })).toMatchObject({ isError: true, text: expect.stringContaining("read-only") });
    expect(await tools.find((t) => t.name === EDIT_BOT_INSTRUCTIONS_TOOL)!.run({ bot: "luna", instructions: "l2" })).toMatchObject({ isError: true, text: expect.stringContaining("read-only") });
    expect(broker.cards()).toEqual([]);
    expect(b.bots.records!.instructions("luna")).toBe("l1");
    await b.shutdown();
  });

  test("the instructions rule from the store's own records: a record forged on the disk names no maker; a second name for a bot.json neither erases nor forges it", async () => {
    const { linkSync, mkdirSync, statSync } = await import("node:fs");
    const home = tempDir();
    const b = await recordsBoot(home);
    await b.bots.createBot({ name: "Alpha" }, { kind: "user" });
    await b.bots.createBot({ name: "Luna" }, { kind: "user" });
    expect(b.bots.records!.instructionsReach("alpha")).toEqual(["alpha"]);
    // Luna's record rewritten on the disk to name Alpha as maker (as only a second name for it could): the store's own
    // copy, the one the fence asks, is unchanged.
    const original = readFileSync(recordFile(home, "luna"), "utf8");
    const forged = JSON.parse(original);
    writeFileSync(recordFile(home, "luna"), JSON.stringify({ ...forged, madeBy: { kind: "bot", id: "alpha" } }));
    expect(b.bots.records!.instructionsReach("alpha")).toEqual(["alpha"]);
    writeFileSync(recordFile(home, "luna"), original);
    // A second name planted for Luna's bot.json: at the next start the core rewrites the record as its own file, so Luna
    // stays a bot and the planted name is no longer her record.
    mkdirSync(join(home, "bots", "alpha", "memory"), { recursive: true });
    const planted = join(home, "bots", "alpha", "memory", "luna.json");
    linkSync(recordFile(home, "luna"), planted);
    await b.shutdown();
    const again = await recordsBoot(home);
    expect(again.bots.records!.get("luna")).toMatchObject({ id: "luna", madeBy: { kind: "user" } });
    expect(statSync(recordFile(home, "luna")).nlink).toBe(1);
    writeFileSync(planted, JSON.stringify({ ...forged, madeBy: { kind: "bot", id: "alpha" } }));
    expect(JSON.parse(readFileSync(recordFile(home, "luna"), "utf8")).madeBy).toEqual({ kind: "user" });
    expect(again.warnings.some((w) => w.includes("had a second name"))).toBe(true);
    await again.shutdown();
  });

  test("a record the store couldn't read back is never written: an oversized greeting is refused with a plain reason", async () => {
    const b = await recordsBoot(tempDir());
    await b.bots.createBot({ name: "Nova" }, { kind: "user" });
    await expect(b.bots.editBot("nova", { greeting: "\u0001".repeat(15_000) })).rejects.toThrow("more than the 65536 a record may hold");
    expect(b.bots.records!.get("nova")?.greeting).toBeUndefined();
    await b.shutdown();
  });

  test("a MakeBot whose card can't be asked leaves no proposal behind", async () => {
    const clock = new FakeClock();
    const b = await boot({
      home: tempDir(), clock, plugins: [], botSource: "records",
      approvals: { withdrawSession: () => {}, cancelSession: () => {}, request: async () => { throw new Error("broker gone"); } } as never,
    });
    await b.bots.createBot({ name: "Alpha" }, { kind: "user" });
    const make = b.side.tools("b_alpha").find((t) => t.name === MAKE_BOT_TOOL)!;
    for (let i = 0; i < 4; i++) await make.run({ name: `S${i}` }).catch(() => undefined);
    expect(b.bots.records!.proposals()).toEqual([]);
    await b.shutdown();
  });
});
