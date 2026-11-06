// D-M2, "a life": the main computer (the lease, faked until H-M2), the pause switch, memory at its pre-C5 paths and
// in the prompt, `SendMessage` and `ListAgents`, J's placement, and the methods that come with them.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_ERR, SESSIONS_METHODS as M, userMessageHashInput, userMessageSigningInput, type Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../../contracts/common";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, toBase64 } from "../../contracts/fakes/device-registry";
import { FakeLeaseAuthority } from "../../contracts/fakes/lease";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { LeaseMainComputer, type MainComputer } from "../main-computer";
import { botPaths } from "../paths";
import { MEMORY_INDEX_MAX_LINES, memoryBlock, readMemoryIndex } from "../prompt";
import { MethodError, peerSessionMethods, sessionsMethods, type MethodContext } from "../rpc";
import type { BotRelay } from "../service";
import { botToolDefs, sendMessageRefusal } from "../tools";
import { ALPHA_FOLDER, boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin, type Boot } from "./fixtures";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };
const thePhone: Caller = { kind: "user", client: "ios", device: "phone00000000000000" };
const msg = (text: string, id = `m-${text}`, sentAt?: number) => ({ text, clientMessageId: id, ...(sentAt === undefined ? {} : { sentAt }) });

async function alpha() {
  return (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs;
}

async function withLuna() {
  const root = tempDir();
  const luna = writePlugin(root, "luna", {
    "clover.json": botManifest("luna", "Luna"),
    "bot/instructions.md": "You are Luna.",
  });
  return [...(await alpha()), ...(await pluginFromFolder(luna)).inputs];
}

function callerOf(b: Boot, id: string) {
  return b.host.callerOf(id);
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Two computers on one lease: Studio and Laptop, each with its own home and bot side. */
async function twoComputers(opts: { holder?: "Studio" | "Laptop"; main?: "Studio" | "Laptop" } = {}) {
  const clock = new FakeClock();
  const devices: Record<string, string> = { Studio: "devstudio000000000", Laptop: "devlaptop000000000" };
  const names: Record<string, string> = { "devstudio000000000": "Studio", "devlaptop000000000": "Laptop" };
  const authority = new FakeLeaseAuthority({ clock, main: devices[opts.main ?? "Studio"]! });
  const leases = { Studio: authority.lease("devstudio000000000"), Laptop: authority.lease("devlaptop000000000") };
  if (opts.holder !== undefined) await leases[opts.holder].acquire();
  const sides: Partial<Record<"Studio" | "Laptop", Boot & { shutdown(): Promise<void> }>> = {};
  // Lane H's link, faked: a message for the runner goes straight to its methods, as `peer.session.send` would.
  const relayFrom = (from: "Studio" | "Laptop"): BotRelay => ({
    sendUser: async (computer, session, p) => {
      const to = sides[computer as "Studio" | "Laptop"]!;
      const peer = peerSessionMethods({ bots: to.bots, host: to.host, clock });
      return (await peer["peer.session.send"]!({ id: session, ...p }, { caller: { kind: "peer", device: devices[from]! } })) as { seq: number };
    },
    deliver: async (computer, session, input) => sides[computer as "Studio" | "Laptop"]!.host.deliver(session, input),
  });
  for (const name of ["Studio", "Laptop"] as const) {
    const main = new LeaseMainComputer({ lease: leases[name], self: name, computerOf: (d) => names[d] });
    sides[name] = await boot({ home: tempDir(), plugins: await alpha(), clock, computer: name, main, relay: relayFrom(name) });
  }
  return { clock, authority, leases, studio: sides.Studio!, laptop: sides.Laptop! };
}

describe("the main computer (§6.4, the lease faked until H-M2)", () => {
  test("the bots run on the lease's holder; every computer says so, and J's placement follows", async () => {
    const { studio, laptop } = await twoComputers({ holder: "Studio" });
    expect(studio.bots.botsRunHere()).toEqual(["alpha"]);
    expect(laptop.bots.botsRunHere()).toEqual([]);
    for (const b of [studio, laptop]) {
      expect(b.bots.get("alpha")!.computer).toBe("Studio");
      expect(b.host.get("b_alpha")!.computer).toBe("Studio");
      expect(b.bots.placement()).toEqual([{ bot: "alpha", computer: "Studio" }]);
    }
    // Records carry the lease's epoch.
    expect(studio.host.history("b_alpha").every((r) => r.epoch === 1)).toBe(true);
  });

  test("a message sent on a computer that doesn't run the bot is relayed to the one that does", async () => {
    const { studio, laptop } = await twoComputers({ holder: "Studio" });
    const methods = sessionsMethods({ home: laptop.home, bots: laptop.bots, host: laptop.host, clock: laptop.clock, localDevice: "devlaptop000000000" });
    await methods[M.sessionSend.name]!({ id: "b_alpha", message: msg("from the laptop") }, { caller: theUser });
    await flush();
    const turn = studio.drivers.for("b_alpha").turns[0]!;
    expect(turn.input).toMatchObject({ from: "user", text: "from the laptop", device: "devlaptop000000000", relayed: { by: "devlaptop000000000", signed: false } });
    // Unsigned, it is the user's words in a turn that isn't the user's (N3).
    expect(turn.origin).toBe("peer");
    expect(laptop.host.history("b_alpha").some((r) => r.type === "input")).toBe(false);
    // Another session's message on Laptop reaches Studio too.
    await laptop.bots.deliverTo("alpha", { from: "bot", bot: "luna", session: "b_luna", text: "hi Alpha" });
    expect(studio.drivers.for("b_alpha").turns[0]!.folded.map((i) => i.from)).toEqual(["bot"]);
  });

  test("with no link to the runner, the message is refused: the bot is asleep and the draft is kept", async () => {
    const clock = new FakeClock();
    const authority = new FakeLeaseAuthority({ clock, main: "devstudio000000000" });
    await authority.lease("devstudio000000000").acquire();
    const main = new LeaseMainComputer({ lease: authority.lease("devlaptop000000000"), self: "Laptop", computerOf: (d) => (d === "devstudio000000000" ? "Studio" : undefined) });
    const laptop = await boot({ home: tempDir(), plugins: await alpha(), clock, computer: "Laptop", main });
    const err = await thrown(laptop.bots.sendUserTo("alpha", { text: "hi", device: "devlaptop000000000", sentAt: clock.now(), clientMessageId: "h" }, msg("hi", "h")));
    expect(isContractError(err) && err.code).toBe("bot_asleep");
  });

  test("a takeover: the old runner stops what it runs; the new one runs what waits and seeds memory", async () => {
    const { clock, authority, leases, studio, laptop } = await twoComputers({ holder: "Studio" });
    // Laptop never ran Alpha: its memory isn't written there.
    expect(existsSync(join(botPaths(laptop.home, "alpha").memory, "MEMORY.md"))).toBe(false);
    expect(existsSync(botPaths(laptop.home, "alpha").memory)).toBe(true);
    await studio.host.sendUser("b_alpha", { text: "deploy it", device: "devstudio000000000", sentAt: clock.now(), clientMessageId: "d" });
    await flush();
    expect(studio.drivers.for("b_alpha").running).toBe(true);
    // A message waits on Laptop (as one synced there would).
    await laptop.host.deliver("b_alpha", { from: "bot", bot: "luna", session: "b_luna", text: "are you up?" });
    // Studio loses the handshake; its lease lapses.
    authority.cutOff("devstudio000000000");
    clock.advance(authority.ttlMs);
    await flush();
    await studio.bots.settled();
    expect(studio.drivers.for("b_alpha").interrupts).toBe(1);
    expect(studio.bots.botsRunHere()).toEqual([]);
    await leases.Laptop.acquire();
    await flush();
    await laptop.bots.settled();
    await flush();
    expect(laptop.bots.botsRunHere()).toEqual(["alpha"]);
    expect(laptop.bots.get("alpha")!.computer).toBe("Laptop");
    expect(laptop.drivers.for("b_alpha").turns.map((t) => t.input.from)).toEqual(["bot"]);
    expect(existsSync(join(botPaths(laptop.home, "alpha").memory, "MEMORY.md"))).toBe(true);
    expect(laptop.host.history("b_alpha").at(-1)!.epoch).toBe(2);
  });

  test("lane J's hooks: where each bot runs, and a session's scratch folder as a tree path", async () => {
    const user = tempDir();
    const home = join(user, ".clover");
    mkdirSync(home);
    const b = await boot({ home, plugins: await alpha(), computer: "Studio", userHome: user });
    expect(b.bots.computerFor("alpha")).toBe("Studio");
    expect(b.bots.computerFor("nobody")).toBeUndefined();
    b.host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio" }, new FakeSessionDriver());
    b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    expect(b.bots.scratchFor("b_alpha")).toBe("home/Studio/.clover/scratch/alpha");
    expect(b.bots.scratchFor("s_side")).toBe("home/Studio/.clover/scratch/alpha");
    expect(b.bots.scratchFor("s_code")).toBe("home/Studio/.clover/scratch/_/s_code");
    expect(existsSync(join(home, "scratch", "_", "s_code"))).toBe(true);
    await b.shutdown();
    // A Clover home outside the user's home has no tree path.
    const lone = await boot({ home: tempDir(), plugins: await alpha(), userHome: user });
    expect(isContractError(await thrown(Promise.resolve().then(() => lone.bots.scratchFor("b_alpha"))))).toBe(true);
    await lone.shutdown();
  });

  test("handing back: no new turn starts, the running one ends where it is, then the lease goes", async () => {
    const { clock, leases, laptop } = await twoComputers({ holder: "Laptop", main: "Studio" });
    await laptop.host.sendUser("b_alpha", { text: "long job", device: "devlaptop000000000", sentAt: clock.now(), clientMessageId: "l" });
    await flush();
    const d = laptop.drivers.for("b_alpha");
    expect(d.running).toBe(true);
    let handedBack = false;
    const back = laptop.bots.handBack().then(() => {
      handedBack = true;
    });
    await flush();
    expect(laptop.gate.handingBack).toBe(true);
    await laptop.host.deliver("b_alpha", { from: "bot", bot: "luna", session: "b_luna", text: "one more" });
    // The lease renews meanwhile: the running turn goes on.
    await leases.Laptop.renew();
    await flush();
    await laptop.bots.settled();
    expect(handedBack).toBe(false);
    expect(d.interrupts).toBe(0);
    d.end();
    await back;
    await flush();
    expect(d.turns).toHaveLength(1);
    expect(leases.Laptop.state().holder).toBeNull();
    expect(laptop.bots.botsRunHere()).toEqual([]);
    // Studio, the main, takes it.
    await leases.Studio.acquire();
    expect(leases.Studio.canAct()).toBe(true);
  });

  test("the driver's context: the caller names the bot, mayAct follows the gate, the memory block names the paths", async () => {
    const { studio, laptop } = await twoComputers({ holder: "Studio" });
    const ctx = studio.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx;
    expect(ctx.caller).toEqual({ kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" });
    expect(ctx.mayAct()).toBe(true);
    expect(laptop.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx.mayAct()).toBe(false);
    const block = ctx.memoryBlock();
    const paths = botPaths(studio.home, "alpha");
    expect(block).toContain(`${paths.memory}/`);
    expect(block).toContain(`${paths.agents}/`);
    expect(block).toContain(`${paths.scratch}/ on Studio`);
    expect(block).toContain("<memory-index>");
    expect(ctx.cacheCold()).toBe(true);
  });
});

describe("the pause switch (§9.2)", () => {
  test("on: what runs stops, nothing new starts, routines refuse; it outlives a restart; off: what waited runs", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const b = await boot({ home, plugins: await alpha(), clock });
    const events: string[] = [];
    b.bots.onEvent((e) => {
      if (e.type === "bots_paused") events.push(`paused=${e.paused}`);
    });
    await b.host.sendUser("b_alpha", { text: "go", device: "studio", sentAt: clock.now(), clientMessageId: "g" });
    await flush();
    const err = await thrown(b.bots.setPaused(true, { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" }));
    expect(isContractError(err) && err.code).toBe("refused");
    await b.bots.setPaused(true, theUser);
    expect(b.drivers.for("b_alpha").interrupts).toBe(1);
    expect(b.bots.get("alpha")!.state).toBe("paused");
    expect(events).toEqual(["paused=true"]);
    expect((await b.host.sendUser("b_alpha", { text: "hello?", device: "studio", sentAt: clock.now(), clientMessageId: "h" })).disposition).toBe("queued");
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(1);
    const run = await thrown(b.bots.runSideThread("alpha", { routine: "r1", name: "Brief", text: "go" }));
    expect(isContractError(run) && run.message).toContain("paused");
    expect(b.drivers.made.find((m) => m.ctx.sessionId === "b_alpha")!.ctx.mayAct()).toBe(false);
    await b.shutdown();

    const again = await boot({ home, plugins: await alpha(), clock });
    expect(again.bots.paused).toBe(true);
    expect(again.bots.get("alpha")!.state).toBe("paused");
    await flush();
    expect(again.drivers.for("b_alpha").turns).toHaveLength(0);
    await again.bots.setPaused(false, theUser);
    await flush();
    expect(again.drivers.for("b_alpha").turns.map((t) => (t.input.from === "user" ? t.input.text : ""))).toEqual(["hello?"]);
    expect(again.bots.get("alpha")!.state).toBe("thinking");
    await again.shutdown();
  });

  test("background agents aren't paused; their reports wait for their bot", async () => {
    const b = await boot({ home: tempDir(), plugins: await alpha() });
    const agent = new FakeSessionDriver({ canFold: false });
    b.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, agent);
    await b.bots.setPaused(true, theUser);
    await b.host.deliver("s_agent", { from: "bot", bot: "alpha", session: "b_alpha", text: "fix the tests" });
    await flush();
    expect(agent.turns).toHaveLength(1);
    agent.end({ text: "Fixed." });
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(0);
    expect(b.host.history("b_alpha").some((r) => r.type === "input" && r.input.from === "task-notification" && r.disposition === "queued")).toBe(true);
    await b.bots.setPaused(false, theUser);
    await flush();
    expect(b.drivers.for("b_alpha").turns.map((t) => t.input.from)).toEqual(["task-notification"]);
    await b.shutdown();
  });

  test("bots.pause is the user's", async () => {
    const b = await boot({ home: tempDir(), plugins: await alpha() });
    const methods = sessionsMethods({ home: b.home, bots: b.bots, host: b.host, clock: b.clock, localDevice: "studio" });
    const plugin: MethodContext = { caller: { kind: "plugin", pluginId: "clover/sidebar" } };
    const err = await thrown(methods[M.botsPause.name]!({ paused: true }, plugin));
    expect(err instanceof MethodError && err.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(await methods[M.botsPause.name]!({ paused: true }, { caller: thePhone })).toEqual({ ok: true });
    expect(b.bots.paused).toBe(true);
    await b.shutdown();
  });
});

describe("SendMessage and ListAgents (§6.7, §9.3)", () => {
  test("a bot messages another by id or name; it folds into a running turn, never as the user's", async () => {
    const b = await boot({ home: tempDir(), plugins: await withLuna() });
    const [send] = botToolDefs({ host: b.host, bots: b.bots }, "b_alpha");
    let r = await send!.run({ to: "luna", message: "Can you take the deploy?" });
    expect(r).toEqual({ text: "Sent to Luna (b_luna): it starts their next turn now.", isError: false });
    await flush();
    expect(b.drivers.for("b_luna").turns[0]!.input).toEqual({ from: "bot", bot: "alpha", session: "b_alpha", text: "Can you take the deploy?" });
    expect(b.drivers.for("b_luna").turns[0]!.origin).toBe("bot");
    r = await send!.run({ to: "LUNA", message: "And the release notes." });
    expect(r.text).toContain("joins their running turn after its next tool call");
    await flush();
    expect(b.drivers.for("b_luna").turns[0]!.folded.map((i) => (i.from === "bot" ? i.text : ""))).toEqual(["And the release notes."]);
    await b.shutdown();
  });

  test("a side thread sends as its bot; a session id of its bot reaches an agent as its next prompt", async () => {
    const b = await boot({ home: tempDir(), plugins: await withLuna() });
    b.host.open({ id: "s_side", kind: "side-thread", bot: "alpha", parent: "b_alpha", computer: "Studio", routine: "r1" }, new FakeSessionDriver());
    const agent = new FakeSessionDriver({ canFold: false });
    b.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, agent);
    const [send] = botToolDefs({ host: b.host, bots: b.bots }, "s_side");
    expect(callerOf(b, "s_side").bot).toBe("alpha");
    const r = await send!.run({ to: "s_agent", message: "Also run the linter." });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("agent of Alpha");
    await flush();
    expect(agent.turns[0]!.input).toEqual({ from: "bot", bot: "alpha", session: "s_side", text: "Also run the linter." });
    await b.shutdown();
  });

  test("the one rule: another bot only through its conversation, otherwise only its own bot's sessions, never itself", async () => {
    const b = await boot({ home: tempDir(), plugins: await withLuna() });
    b.host.open({ id: "s_lunas", kind: "agent", bot: "luna", parent: "b_luna", computer: "Studio", backend: "gemini" }, new FakeSessionDriver({ canFold: false }));
    b.host.open({ id: "s_lunaside", kind: "side-thread", bot: "luna", parent: "b_luna", computer: "Studio", routine: "r2" }, new FakeSessionDriver());
    b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    const mine = new FakeSessionDriver({ canFold: false });
    b.host.open({ id: "s_mine", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, mine);
    const [send] = botToolDefs({ host: b.host, bots: b.bots }, "b_alpha");
    expect((await send!.run({ to: "s_lunas", message: "hi" })).text).toContain('belongs to the bot luna; message that bot\'s conversation instead');
    expect((await send!.run({ to: "s_lunaside", message: "hi" })).isError).toBe(true);
    expect((await send!.run({ to: "s_code", message: "hi" })).text).toContain("the user's own coding session");
    // Another bot's conversation, by its session id too.
    expect((await send!.run({ to: "b_luna", message: "hi" })).isError).toBe(false);
    // An agent, through the same door: never itself, its own bot yes, as the agent's own message; another bot's agent no.
    const [agentSend] = botToolDefs({ host: b.host, bots: b.bots }, "s_mine");
    expect((await agentSend!.run({ to: "s_mine", message: "hi" })).text).toContain("this conversation");
    expect((await agentSend!.run({ to: "s_lunas", message: "hi" })).isError).toBe(true);
    expect((await agentSend!.run({ to: "alpha", message: "Halfway there." })).isError).toBe(false);
    await flush();
    expect(b.drivers.for("b_alpha").turns[0]!.input).toEqual({ from: "agent", agent: "s_mine", text: "Halfway there." });
    expect(sendMessageRefusal({ sessionId: "s_x", bot: "alpha" }, { id: "s_y", kind: "agent", bot: "alpha" })).toBeUndefined();
    await b.shutdown();
  });

  test("refused: no target, itself, an ended session, an unknown name, an empty or huge message", async () => {
    const b = await boot({ home: tempDir(), plugins: await withLuna() });
    b.host.open({ id: "s_done", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    await b.host.stop("s_done");
    const [send] = botToolDefs({ host: b.host, bots: b.bots }, "b_alpha");
    expect((await send!.run({ message: "hi" })).isError).toBe(true);
    expect((await send!.run({ to: "alpha", message: "hi" })).text).toContain("this conversation");
    expect((await send!.run({ to: "Alpha", message: "hi" })).text).toContain("this conversation");
    expect((await send!.run({ to: "s_done", message: "hi" })).text).toContain("has ended");
    expect((await send!.run({ to: "nobody", message: "hi" })).text).toContain("ListAgents");
    expect((await send!.run({ to: "luna", message: "  " })).isError).toBe(true);
    expect((await send!.run({ to: "luna", message: "x".repeat(100_001) })).text).toContain("at most");
    await b.shutdown();
  });

  test("ListAgents lists the running sessions, the caller's own first, and filters", async () => {
    const b = await boot({ home: tempDir(), plugins: await withLuna() });
    b.host.open({ id: "s_lunas", kind: "agent", bot: "luna", parent: "b_luna", computer: "Studio", backend: "gemini" }, new FakeSessionDriver({ canFold: false }));
    b.host.open({ id: "s_mine", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex", root: "home/Studio/app" }, new FakeSessionDriver({ canFold: false }));
    b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    const list = botToolDefs({ host: b.host, bots: b.bots }, "b_alpha")[1]!;
    const lines = (await list.run({})).text.split("\n");
    expect(lines[0]).toStartWith("- s_mine · agent · bot Alpha (alpha)");
    expect(lines[0]).toContain("in home/Studio/app");
    expect(lines.slice(1, 3).map((l) => l.split(" · ")[0])).toEqual(["- b_alpha", "- b_luna"]);
    expect(lines[1]).toEndWith("(this conversation)");
    expect(lines.at(-1)).toStartWith("- s_code · coding");
    expect((await list.run({ kind: "agent", bot: "luna" })).text).toStartWith("- s_lunas · agent");
    expect((await list.run({ kind: "side-thread" })).text).toBe("No running sessions match.");
    // With lane K's rows, its agents are listed in place of the host's.
    const row = { ...b.host.get("s_mine")!, id: "s_remote", computer: "Laptop", status: "prompting" as const };
    const withK = botToolDefs({ host: b.host, bots: b.bots, agents: { list: () => [row] } }, "b_alpha")[1]!;
    const kLines = (await withK.run({ kind: "agent" })).text.split("\n");
    expect(kLines).toHaveLength(1);
    expect(kLines[0]).toContain("s_remote · agent");
    expect(kLines[0]).toContain("on Laptop");
    await b.shutdown();
  });
});

describe("the memory block (§6.5, pre-C5 paths)", () => {
  function paths() {
    const home = tempDir();
    const p = botPaths(home, "alpha");
    mkdirSync(p.memory, { recursive: true });
    return p;
  }

  test("it holds the index, cut at its first lines", () => {
    const p = paths();
    writeFileSync(join(p.memory, "MEMORY.md"), Array.from({ length: MEMORY_INDEX_MAX_LINES + 5 }, (_, i) => `- line ${i}`).join("\n"));
    const index = readMemoryIndex(p)!;
    expect(index.cut).toBe(true);
    expect(index.text.split("\n")).toHaveLength(MEMORY_INDEX_MAX_LINES);
    expect(memoryBlock({ paths: p, computer: "Studio" })).toContain("(cut here; read the file for the rest)");
  });

  test("it never reads a link, a second name, or through a swapped folder", () => {
    const p = paths();
    const secret = join(p.root, "..", "..", "secret.txt");
    writeFileSync(secret, "the key");
    symlinkSync(secret, join(p.memory, "MEMORY.md"));
    expect(readMemoryIndex(p)).toBeUndefined();
    expect(memoryBlock({ paths: p, computer: "Studio" })).not.toContain("the key");
    rmSync(join(p.memory, "MEMORY.md"));
    linkSync(secret, join(p.memory, "MEMORY.md"));
    expect(readMemoryIndex(p)).toBeUndefined();
    const q = paths();
    rmSync(q.memory, { recursive: true });
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "MEMORY.md"), "the key");
    symlinkSync(elsewhere, q.memory);
    expect(readMemoryIndex(q)).toBeUndefined();
    expect(memoryBlock({ paths: q, computer: "Studio" })).toContain("is empty so far");
  });
});

describe("a restart's dormant agents", () => {
  test("background agents and coding sessions left dormant are handed over to be reattached; ended ones aren't", async () => {
    const home = tempDir();
    const clock = new FakeClock();
    const first = await boot({ home, plugins: await alpha(), clock });
    first.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    first.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    first.host.open({ id: "s_done", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    await first.host.stop("s_done");
    await first.shutdown();
    const handed: string[] = [];
    const again = await boot({ home, plugins: await alpha(), clock, reattach: (views) => {
      handed.push(...views.map((v) => v.id));
    } });
    expect(handed.sort()).toEqual(["s_agent", "s_code"]);
    await again.shutdown();
  });
});

describe("the new sessions methods", () => {
  test("session.setModel: an agent's or coding session's, never a bot's", async () => {
    const b = await boot({ home: tempDir(), plugins: await alpha() });
    const set: { id: string; model: string; effort?: string }[] = [];
    const methods = sessionsMethods({
      home: b.home, bots: b.bots, host: b.host, clock: b.clock, localDevice: "studio",
      setAgentModel: async (id, model, effort) => {
        set.push({ id, model, ...(effort === undefined ? {} : { effort }) });
      },
    });
    b.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex", model: "gpt-5" }, new FakeSessionDriver({ canFold: false }));
    await methods[M.sessionSetModel.name]!({ id: "s_agent", model: "gpt-5.5", effort: "high" }, { caller: theUser });
    expect(set).toEqual([{ id: "s_agent", model: "gpt-5.5", effort: "high" }]);
    expect(b.host.get("s_agent")).toMatchObject({ model: "gpt-5.5", effort: "high" });
    const bot = await thrown(methods[M.sessionSetModel.name]!({ id: "b_alpha", model: "x/y" }, { caller: theUser }));
    expect(bot instanceof MethodError && bot.message).toContain("user layer");
    const notUser = await thrown(methods[M.sessionSetModel.name]!({ id: "s_agent", model: "x/y" }, { caller: { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" } }));
    expect(notUser instanceof MethodError && notUser.code).toBe(CLOVER_ERR.NOT_THE_USER);
    await b.shutdown();
  });

  test("session.compact: refused for a driver that compacts itself", async () => {
    const b = await boot({ home: tempDir(), plugins: await alpha() });
    const methods = sessionsMethods({ home: b.home, bots: b.bots, host: b.host, clock: b.clock, localDevice: "studio" });
    const err = await thrown(methods[M.sessionCompact.name]!({ id: "b_alpha" }, { caller: theUser }));
    expect(err instanceof MethodError && err.message).toContain("compacts its own conversation");
    await b.shutdown();
  });

  test("peer.session.send: only from another computer, only for a bot this one runs, the user's turn only when signed", async () => {
    const clock = new FakeClock();
    const b = await boot({ home: tempDir(), plugins: await alpha(), clock });
    const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
    const phone = await makeFakeDevice();
    await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey }, { via: "account", account: "acct_1" });
    const peer = peerSessionMethods({ bots: b.bots, host: b.host, clock, devices: registry })["peer.session.send"]!;
    const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
    const m = { text: "ship it", clientMessageId: "m-ship", sentAt: clock.now() };
    const signature = toBase64(await phone.sign(new TextEncoder().encode(userMessageSigningInput({ session: "b_alpha", clientMessageId: m.clientMessageId, hash: sha256(userMessageHashInput(m)), sentAt: m.sentAt }))));
    const fromLaptop: MethodContext = { caller: { kind: "peer", device: "devlaptop000000000" } };
    const notPeer = await thrown(peer({ id: "b_alpha", message: m, device: phone.id, sentAt: clock.now() }, { caller: theUser }));
    expect(notPeer instanceof MethodError && notPeer.code).toBe(CLOVER_ERR.ROLE_REFUSED);
    await peer({ id: "b_alpha", message: { ...m, signature }, device: phone.id, sentAt: clock.now() }, fromLaptop);
    await flush();
    const d = b.drivers.for("b_alpha");
    expect(d.turns[0]!.origin).toBe("user");
    expect(d.turns[0]!.input).toMatchObject({ device: phone.id, relayed: { by: "devlaptop000000000", signed: true } });
    d.end();
    await flush();
    await peer({ id: "b_alpha", message: { ...m, text: "delete it", clientMessageId: "m-del", signature }, device: phone.id, sentAt: clock.now() }, fromLaptop);
    await flush();
    expect(d.turns[1]!.origin).toBe("peer");
    await b.shutdown();
    // A computer that doesn't run the bot refuses it.
    const elsewhere: MainComputer = { self: "Studio", runner: () => "Laptop", main: () => "Laptop", runsHere: () => false, epoch: () => 3, release: async () => {}, watch: () => () => {} };
    const other = await boot({ home: tempDir(), plugins: await alpha(), clock, main: elsewhere });
    const otherPeer = peerSessionMethods({ bots: other.bots, host: other.host, clock, devices: registry })["peer.session.send"]!;
    const notMain = await thrown(otherPeer({ id: "b_alpha", message: { ...m, clientMessageId: "m-3" }, device: phone.id, sentAt: clock.now() }, fromLaptop));
    expect(notMain instanceof MethodError && notMain.code).toBe(CLOVER_ERR.NOT_MAIN);
    await other.shutdown();
  });
});
