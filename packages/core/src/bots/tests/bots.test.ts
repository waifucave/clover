// The bot service (../service.ts) end to end: a plugin declares a bot, the core loads it from the registry, lists it
// with its state, and runs its one conversation and its side threads, on a temp home that survives restarts.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BotView, CLOVER_ERR, RoutineRunView, SESSIONS_EVENTS, SessionView } from "@waifucave/clover-protocol";
import { isContractError } from "../../contracts/common";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import type { FakePluginInput } from "../../contracts/fakes/plugin-registry";
import { sessionLogPath } from "../../sessions/ids";
import { projectRecords } from "../../sessions/wire";
import { botPaths, userLayerFile } from "../paths";
import type { BotServiceEvent } from "../service";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(removeTemps);

const user = (text: string, id = `m-${text}`) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: id });

async function alphaInputs(): Promise<FakePluginInput[]> {
  return (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs;
}

/** A pack of two bots in child plugins (`pack/luna`, `pack/nova`), each in its own folder. */
function packFolder(root: string): string {
  const child = (name: string) => ({
    [`plugins/${name}/clover.json`]: botManifest(undefined, name[0]!.toUpperCase() + name.slice(1)),
    [`plugins/${name}/bot/instructions.md`]: `You are ${name}.`,
  });
  return writePlugin(root, "pack", { "clover.json": { manifest: 1, id: "pack", name: "A pack of bots" }, ...child("luna"), ...child("nova") });
}

describe("Alpha", () => {
  test("Alpha's folder is a valid plugin with one bot, and nothing outside its own tab", async () => {
    const { report } = await pluginFromFolder(ALPHA_FOLDER, { bundled: true });
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.top.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.top.bot).toBe(true);
    expect(report.top.class).toBe("data");
    expect(report.children).toEqual([]);
  });

  test("Alpha's manifest names lane G's look as soon as it is in the folder", () => {
    // Lane G ships Alpha's tab look and assets (plan §4 G): `tab/theme.json`, `tab/layout.json`, `assets/alpha.vrm`
    // and the portrait. Alpha's manifest is D's and must name each one that exists, as spec §5.9's example does.
    const manifest = JSON.parse(readFileSync(join(ALPHA_FOLDER, "clover.json"), "utf8")) as {
      icon?: string; contributes: { bot: Record<string, unknown>; themes?: { id: string; file: string }[] };
    };
    const has = (p: string) => existsSync(join(ALPHA_FOLDER, ...p.split("/")));
    const bot = manifest.contributes.bot as { theme?: string; layout?: string; avatar?: { file: string; format: string; portrait?: string } };
    if (has("tab/theme.json")) {
      expect(manifest.contributes.themes).toContainEqual({ id: "alpha", file: "tab/theme.json" });
      expect(bot.theme).toBe("alpha");
    } else expect(bot.theme).toBeUndefined();
    if (has("tab/layout.json")) expect(bot.layout).toBe("tab/layout.json");
    else expect(bot.layout).toBeUndefined();
    if (has("assets/alpha.vrm")) expect(bot.avatar).toMatchObject({ file: "assets/alpha.vrm", format: "vrm" });
    else expect(bot.avatar).toBeUndefined();
    for (const portrait of ["assets/portrait.webp", "assets/portrait.svg", "assets/portrait.png"]) {
      if (has(portrait)) expect(bot.avatar?.portrait).toBe(portrait);
    }
  });

  test("the core loads Alpha and lists it with its state; its one conversation opens with its greeting", async () => {
    const home = tempDir();
    const b = await boot({ home, plugins: await alphaInputs() });
    const views = b.bots.list();
    expect(views).toHaveLength(1);
    const alpha = BotView.parse(views[0]);
    expect(alpha).toEqual({
      id: "alpha", name: "Alpha", model: "anthropic/claude-sonnet-5-5", effort: "medium", userLayer: [], state: "idle",
      computer: "Studio", mainSession: "b_alpha",
    });
    expect(b.host.get("b_alpha")).toMatchObject({ kind: "bot", bot: "alpha", title: "Alpha", model: "anthropic/claude-sonnet-5-5", effort: "medium" });
    const events = projectRecords(b.host.history("b_alpha"), { kind: "bot" });
    expect(events).toMatchObject([{ type: "assistant_message", text: readFileSync(join(ALPHA_FOLDER, "bot/greeting.md"), "utf8").trim() }]);
    expect(readFileSync(join(botPaths(home, "alpha").memory, "MEMORY.md"), "utf8")).toBe(readFileSync(join(ALPHA_FOLDER, "bot/memory/MEMORY.md"), "utf8"));
    expect(b.drivers.made.map((m) => [m.ctx.sessionId, m.ctx.kind, m.ctx.current().instructions.startsWith("You are Alpha")])).toEqual([["b_alpha", "bot", true]]);
    expect(b.warnings).toEqual([]);
    await b.shutdown();
  });

  test("Alpha keeps one conversation across restarts: the same session, the whole history, no second greeting", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const first = await boot({ home, clock, plugins: await alphaInputs() });
    await first.host.sendUser("b_alpha", user("hi, I'm Sam"));
    await flush();
    const d = first.drivers.for("b_alpha");
    d.emit({ type: "assistant_message", text: "Nice to meet you, Sam." });
    d.end({ text: "Nice to meet you, Sam.", usage: { inputTokens: 900, outputTokens: 12 } });
    await flush();
    await first.shutdown();
    rmSync(join(botPaths(home, "alpha").memory, "MEMORY.md"));

    const second = await boot({ home, clock, plugins: await alphaInputs() });
    expect(second.bots.get("alpha")?.mainSession).toBe("b_alpha");
    const texts = projectRecords(second.host.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "user_message" || e.type === "assistant_message").map((e) => e.text);
    expect(texts).toEqual([readFileSync(join(ALPHA_FOLDER, "bot/greeting.md"), "utf8").trim(), "hi, I'm Sam", "Nice to meet you, Sam."]);
    // Starter memories are copied once: the bot's own deletion stands.
    expect(existsSync(join(botPaths(home, "alpha").memory, "MEMORY.md"))).toBe(false);
    await second.host.sendUser("b_alpha", user("what's my name?"));
    await flush();
    expect(second.drivers.for("b_alpha").turns.map((t) => t.input)).toMatchObject([{ from: "user", text: "what's my name?" }]);
    const seqs = second.host.history("b_alpha").map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(existsSync(sessionLogPath(home, "alpha", "b_alpha"))).toBe(true);
    await second.shutdown();
  });
});

describe("bots from plugins", () => {
  test("one bot per plugin: a pack keeps each bot in a child plugin, with pack ids and their own files", async () => {
    const root = tempDir();
    const home = tempDir();
    const pack = await pluginFromFolder(packFolder(root));
    expect(pack.report.ok).toBe(true);
    const b = await boot({ home, plugins: pack.inputs });
    expect(b.bots.list().map((v) => [v.id, v.mainSession])).toEqual([["pack/luna", "b_pack--luna"], ["pack/nova", "b_pack--nova"]]);
    for (const v of b.bots.list()) BotView.parse(v);
    await b.host.sendUser("b_pack--luna", user("hello Luna"));
    await flush();
    expect(existsSync(sessionLogPath(home, "pack/luna", "b_pack--luna"))).toBe(true);
    expect(sessionLogPath(home, "pack/luna", "b_pack--luna")).toContain(join("transcripts", "pack--luna"));
    expect(b.bots.paths("pack/luna").memory).toBe(join(home, "bots", "pack--luna", "memory"));
    await b.shutdown();
  });

  test("a manifest can't hold two bots: `bot` is one entry", async () => {
    const root = tempDir();
    const dir = writePlugin(root, "twins", {
      "clover.json": { manifest: 1, id: "twins", name: "Twins", contributes: { bot: [{ name: "A", instructions: "a.md" }, { name: "B", instructions: "b.md" }] } },
      "a.md": "You are A.",
      "b.md": "You are B.",
    });
    const { report, inputs } = await pluginFromFolder(dir);
    expect(report.top.issues.some((i) => i.severity === "error" && i.path === "/contributes/bot")).toBe(true);
    const b = await boot({ home: tempDir(), plugins: inputs });
    expect(b.bots.list()).toEqual([]);
    await b.shutdown();
  });

  test("a bot goes when its plugin goes off, and comes back to the same conversation; its memory and transcript stay", async () => {
    const root = tempDir();
    const home = tempDir();
    const b = await boot({ home, plugins: (await pluginFromFolder(packFolder(root))).inputs });
    const events: BotServiceEvent[] = [];
    b.bots.onEvent((e) => events.push(e));
    await b.host.sendUser("b_pack--luna", user("remember the plants"));
    await flush();
    await b.registry.setEnabled("pack/luna", false);
    await b.bots.settled();
    expect(b.bots.list().map((v) => v.id)).toEqual(["pack/nova"]);
    expect(events.filter((e) => e.type === "bot_removed")).toEqual([{ type: "bot_removed", ts: b.clock.now(), id: "pack/luna" }]);
    expect(b.host.isAttached("b_pack--luna")).toBe(false);
    expect(b.drivers.for("b_pack--luna").stopped).toBe(true);
    SESSIONS_EVENTS.botRemoved.schema.parse(events.find((e) => e.type === "bot_removed"));

    await b.registry.setEnabled("pack", false);
    await b.bots.settled();
    expect(b.bots.list()).toEqual([]);

    await b.registry.setEnabled("pack", true);
    await b.registry.setEnabled("pack/luna", true);
    await b.bots.settled();
    expect(b.bots.list().map((v) => v.id).sort()).toEqual(["pack/luna", "pack/nova"]);
    const inputs = b.host.history("b_pack--luna").filter((r) => r.type === "input").map((r) => (r.type === "input" && r.input.from === "user" ? r.input.text : ""));
    expect(inputs).toEqual(["remember the plants"]);
    expect(b.host.history("b_pack--luna").filter((r) => r.type === "turn_ended")).toMatchObject([{ end: { reason: "interrupted" } }]);
    await b.shutdown();
  });

  test("a bot whose instructions can't be read isn't loaded, and says why", async () => {
    const root = tempDir();
    const dir = writePlugin(root, "ghost", { "clover.json": botManifest("ghost", "Ghost"), "bot/instructions.md": "You are Ghost." });
    const { inputs } = await pluginFromFolder(dir);
    rmSync(join(dir, "bot", "instructions.md"));
    const b = await boot({ home: tempDir(), plugins: inputs });
    expect(b.bots.list()).toEqual([]);
    expect(b.warnings.join("\n")).toContain("the bot ghost isn't loaded: its instructions");
    await b.shutdown();
  });

  test("a plugin's change applies live: new instructions reach the driver, and the view follows", async () => {
    const root = tempDir();
    const dir = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "You are Luna." });
    const first = await pluginFromFolder(dir);
    const b = await boot({ home: tempDir(), plugins: first.inputs });
    const ctx = b.drivers.made[0]!.ctx;
    expect(ctx.current().instructions).toBe("You are Luna.");
    writeFileSync(join(dir, "bot", "instructions.md"), "You are Luna, and you love the night sky.");
    writeFileSync(join(dir, "clover.json"), JSON.stringify(botManifest("luna", "Luna Moon")));
    const changed = await pluginFromFolder(dir);
    b.registry.put(changed.inputs[0]!);
    await b.bots.settled();
    expect(ctx.current().instructions).toBe("You are Luna, and you love the night sky.");
    expect(b.bots.get("luna")?.name).toBe("Luna Moon");
    expect(b.host.get("b_luna")?.title).toBe("Luna Moon");
    expect(b.drivers.made).toHaveLength(1);
    await b.shutdown();
  });
});

describe("the user layer", () => {
  async function luna(opts: { hasKeyFor?: (m: string) => boolean } = {}) {
    const root = tempDir();
    const dir = writePlugin(root, "luna", {
      "clover.json": botManifest("luna", "Luna", { model: { default: "anthropic/claude-sonnet-5-5", effort: "high" }, voice: { provider: "fish-audio", voice: "v1", model: "s2.1-pro-free" } }),
      "bot/instructions.md": "You are Luna.",
    });
    const home = tempDir();
    const inputs = (await pluginFromFolder(dir)).inputs;
    return { home, inputs, b: await boot({ home, plugins: inputs, ...opts }) };
  }

  const theUser = { kind: "user", client: "app" } as const;

  test("a field the user sets wins over the plugin's; Reset clears it; drivers see it on their next turn", async () => {
    const { b } = await luna();
    const ctx = b.drivers.made[0]!.ctx;
    expect(await b.bots.setUserLayer("luna", { name: "Moon", model: "openai/gpt-6.1-sol", effort: "low", instructions: "You are Moon." }, theUser)).toEqual({ applied: true });
    expect(b.bots.get("luna")).toMatchObject({ name: "Moon", model: "openai/gpt-6.1-sol", effort: "low", userLayer: ["name", "instructions", "model", "effort"] });
    expect(ctx.current()).toMatchObject({ name: "Moon", model: "openai/gpt-6.1-sol", effort: "low", instructions: "You are Moon." });
    expect(b.host.get("b_luna")).toMatchObject({ title: "Moon", model: "openai/gpt-6.1-sol", effort: "low" });
    await b.bots.setUserLayer("luna", { name: null, model: null, effort: null, instructions: null }, theUser);
    expect(b.bots.get("luna")).toMatchObject({ name: "Luna", model: "anthropic/claude-sonnet-5-5", effort: "high", userLayer: [] });
    expect(ctx.current().instructions).toBe("You are Luna.");
    expect(existsSync(userLayerFile(b.home, "luna"))).toBe(false);
    await b.shutdown();
  });

  test("bots and plugins can't write it, and it sits in the fenced set", async () => {
    const { b } = await luna();
    const asBot = await b.bots.setUserLayer("luna", { model: "openai/gpt-6.1-sol" }, { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" }).catch((e: unknown) => e);
    expect(isContractError(asBot, "refused")).toBe(true);
    expect((asBot as { detail?: { rpc?: number } }).detail?.rpc).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(isContractError(await b.bots.setUserLayer("luna", { name: "X" }, { kind: "plugin", pluginId: "weather" }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(b.bots.get("luna")?.userLayer).toEqual([]);
    await b.bots.setUserLayer("luna", { theme: "night" }, theUser);
    const fence = new FakeFence({ home: "/home/sam", cloverHome: b.home });
    expect(fence.check({ op: "write", path: userLayerFile(b.home, "luna") })).toMatchObject({ allowed: false, reason: "user-layers" });
    await b.shutdown();
  });

  test("a bad change is refused whole", async () => {
    const { b } = await luna();
    for (const bad of [{ model: "gpt" }, { effort: "very high" }, { instructions: "   " }, { name: 7 }, { unknown: true }]) {
      expect(isContractError(await b.bots.setUserLayer("luna", bad, theUser).catch((e: unknown) => e), "invalid")).toBe(true);
    }
    expect(b.bots.userLayer("luna")).toEqual({});
    await b.shutdown();
  });

  test("the layer survives a restart", async () => {
    const { home, inputs, b } = await luna();
    await b.bots.setUserLayer("luna", { voice: { provider: "fish-audio", voice: "v2" } }, theUser);
    await b.shutdown();
    const again = await boot({ home, plugins: inputs });
    expect(again.bots.get("luna")).toMatchObject({ voice: { provider: "fish-audio", voice: "v2" }, userLayer: ["voice"] });
    await again.shutdown();
  });

  test("with no key for the plugin's model the bot uses the user's default; the user's own pick always stands", async () => {
    const { b } = await luna({ hasKeyFor: (m) => !m.startsWith("anthropic/") });
    expect(b.bots.get("luna")).toMatchObject({ model: "fireworks/kimi-k3" });
    expect(b.bots.get("luna")?.effort).toBeUndefined();
    await b.bots.setUserLayer("luna", { model: "anthropic/claude-opus-5-5" }, theUser);
    expect(b.bots.get("luna")?.model).toBe("anthropic/claude-opus-5-5");
    await b.shutdown();
  });
});

describe("a bot's state and its sessions", () => {
  test("thinking while its conversation runs a turn, idle after, asleep without its computer; each change is a bot_changed", async () => {
    const home = tempDir();
    const b = await boot({ home, plugins: await alphaInputs() });
    const events: BotServiceEvent[] = [];
    b.bots.onEvent((e) => events.push(e));
    await b.host.sendUser("b_alpha", user("hi"));
    await flush();
    expect(b.bots.get("alpha")?.state).toBe("thinking");
    b.drivers.for("b_alpha").end({ text: "hey" });
    await flush();
    expect(b.bots.get("alpha")?.state).toBe("idle");
    b.host.setAsleep("b_alpha", true);
    expect(b.bots.get("alpha")?.state).toBe("asleep");
    const states = events.filter((e) => e.type === "bot_changed").map((e) => (e.type === "bot_changed" ? e.bot.state : ""));
    expect(states).toEqual(["thinking", "idle"]);
    for (const e of events) {
      if (e.type === "bot_changed") SESSIONS_EVENTS.botChanged.schema.parse(e);
      if (e.type === "session_changed") SESSIONS_EVENTS.sessionChanged.schema.parse(e);
    }
    expect(events.some((e) => e.type === "session_changed" && e.session.id === "b_alpha" && e.session.status === "prompting")).toBe(true);
    await b.shutdown();
  });

  test("a routine runs in a side thread with the bot's instructions, and posts its short result without waking the conversation", async () => {
    const home = tempDir();
    const b = await boot({ home, plugins: await alphaInputs() });
    const run = b.bots.runSideThread("alpha", { routine: "r_morning", name: "Morning brief", text: "Check my inbox and summarise." });
    await flush();
    const side = b.drivers.made.at(-1)!;
    expect(side.ctx).toMatchObject({ botId: "alpha", kind: "side-thread" });
    expect(side.ctx.current().instructions).toBe(b.bots.effective("alpha").instructions);
    const sideView = SessionView.parse(b.host.get(side.ctx.sessionId));
    expect(sideView).toMatchObject({ kind: "side-thread", bot: "alpha", parent: "b_alpha", routine: "r_morning", title: "Morning brief", status: "prompting" });
    expect(side.driver.turns).toMatchObject([{ origin: "routine", input: { from: "routine", text: "Check my inbox and summarise." } }]);
    // The user's interrupt of the conversation never touches the side thread.
    await b.host.sendUser("b_alpha", user("hello"));
    await b.host.sendUser("b_alpha", user("hello again"));
    await flush();
    expect(side.driver.interrupts).toBe(0);
    expect(b.drivers.for("b_alpha").turns.map((t) => (t.input.from === "user" ? t.input.text : ""))).toEqual(["hello", "hello again"]);
    b.drivers.for("b_alpha").end();
    await flush();
    side.driver.end({ text: "3 new messages; one from the landlord about Friday." });
    const view = RoutineRunView.parse(await run);
    expect(view).toMatchObject({ routine: "r_morning", session: side.ctx.sessionId, outcome: "done", summary: "3 new messages; one from the landlord about Friday." });
    expect(b.host.get(side.ctx.sessionId)?.status).toBe("stopped");
    const main = projectRecords(b.host.history("b_alpha"), { kind: "bot" });
    expect(main.at(-1)).toMatchObject({ type: "routine_result", routine: "r_morning", name: "Morning brief", sideThread: side.ctx.sessionId, text: "3 new messages; one from the landlord about Friday." });
    SESSIONS_EVENTS.routineResult.schema.parse(main.at(-1));
    expect(b.drivers.for("b_alpha").turns).toHaveLength(2);
    expect(b.bots.get("alpha")?.state).toBe("idle");
    // The result reaches the conversation's next turn.
    await b.host.sendUser("b_alpha", user("anything new?"));
    await flush();
    expect(b.drivers.for("b_alpha").turns.at(-1)!.folded).toMatchObject([{ from: "routine", name: "Morning brief" }]);
    // The side thread's own log keeps the run, and both survive a restart.
    const sideEvents = projectRecords(b.host.history(side.ctx.sessionId), { kind: "side-thread" });
    expect(sideEvents[0]).toMatchObject({ type: "note", from: { kind: "core" }, label: "Morning brief", text: "Check my inbox and summarise." });
    await b.shutdown();
    const again = await boot({ home, plugins: await alphaInputs() });
    expect(again.host.list({ bot: "alpha", kind: "side-thread" }).map((v) => [v.id, v.status, v.parent])).toEqual([[side.ctx.sessionId, "stopped", "b_alpha"]]);
    await again.shutdown();
  });

  test("a failed run says so in the conversation", async () => {
    const b = await boot({ home: tempDir(), plugins: await alphaInputs() });
    const run = b.bots.runSideThread("alpha", { routine: "r_x", name: "Deploy check", text: "Check the deploy." });
    await flush();
    b.drivers.made.at(-1)!.driver.end({ reason: "failed", failure: "error", text: "the provider is down" });
    expect(await run).toMatchObject({ outcome: "failed", summary: "The run failed (error): the provider is down" });
    expect(projectRecords(b.host.history("b_alpha"), { kind: "bot" }).at(-1)).toMatchObject({ type: "routine_result", text: "The run failed (error): the provider is down" });
    await b.shutdown();
  });
});
