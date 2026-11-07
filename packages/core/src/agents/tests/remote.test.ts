// Agents on other computers (K-M3, remote.ts): a bot on Studio delegates to an agent on Laptop over the fake link.
// Laptop's manager runs the scripted agent with its own backend, root, fence, bridge, level and cards; Studio keeps the
// session, writes the transcript and gets the task notification. Every act carries the fencing token, Studio's pause
// reaches Laptop, and a dropped link holds the agent there.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S5_CURSOR_QUIRKS } from "../../contracts/fakes/agent-backend";
import { isContractError } from "../../contracts/common";
import { readAgentRecord } from "../records";
import { AgentPeers, bootFiles, MAX_BOOT_COUNTER, MAX_STREAM_LINE, nextBootBase, peerLevel, STATE_TIMEOUT_MS } from "../remote";
import { FakeClock } from "../../contracts/fakes/clock";
import type { LinkTransport } from "../../contracts/link-transport";
import { AgentManager } from "../manager";
import { BridgeTokens } from "../bridge/tokens";
import { bridgeCommand } from "../bridge/main";
import { StallWatchdog } from "../watchdog";
import { FakeSessionDriver, FakeSessionHost } from "../../contracts/fakes/session-host";
import { AgentTranscript, REDACTED_TOKEN } from "../transcript";
import { waitFor } from "./world";
import { blockedOn, closePair, delegate, HeldWatch, LAPTOP, make, notification, OTHER, proceed, STUDIO } from "./pair";

setDefaultTimeout(60_000);
afterEach(closePair);

describe("an agent on another computer", () => {
  test("runs there, in that computer's folder; the session, the transcript and the task notification are the bot's computer's", async () => {
    const p = make({ b: { script: [[{ say: "Working. " }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "All 12 tests pass." }]] } });
    const r = await delegate(p);
    expect(p.a.host.get(r.sessionId)).toMatchObject({ kind: "agent", bot: "alpha", parent: "s_alpha", backend: "fake", computer: "Laptop", root: "home/Laptop/project1" });
    const n = await waitFor(() => notification(p.a), "the task notification");
    expect(n).toEqual({ from: "task-notification", agent: r.sessionId, backend: "fake", stopReason: "end_turn", text: "All 12 tests pass.", transcript: `bots/alpha/agents/${r.sessionId}/acp.ndjson` });
    // The agent ran on Laptop, in Laptop's folder, with Laptop's bridge.
    expect(p.b.report("session")[0]).toMatchObject({ how: "new", cwd: p.b.project, servers: [expect.stringMatching(/^clover_[0-9a-f]{16}$/)] });
    // Studio wrote the transcript from what Laptop streamed: the wire with Laptop's token redacted, the permission
    // Laptop's level answered, and who the agent is.
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    await waitFor(() => existsSync(join(dir, "calls.ndjson")) && readFileSync(join(dir, "acp.ndjson"), "utf8").includes("All 12 tests pass"), "the streamed transcript");
    const wire = readFileSync(join(dir, "acp.ndjson"), "utf8");
    expect(wire).toContain("session/prompt");
    expect(wire).toContain(REDACTED_TOKEN);
    expect(readFileSync(join(dir, "calls.ndjson"), "utf8")).toContain('"by":"level"');
    expect(JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"))).toMatchObject({ backend: "fake", computer: "Laptop", root: "home/Laptop/project1", agentSessionId: "fake-session-1" });
    expect(readAgentRecord(p.a.cloverHome, r.sessionId)).toMatchObject({ computer: "Laptop", bot: "alpha", parent: "s_alpha", agentSessionId: "fake-session-1" });
    // Laptop keeps no transcript and no record of its own: the bot's folder is Studio's.
    expect(existsSync(join(p.b.cloverHome, "bots", "alpha", "agents", r.sessionId))).toBe(false);
    expect(readAgentRecord(p.b.cloverHome, r.sessionId)).toBeUndefined();
    // The live transcript is Studio's session log.
    const log = p.a.host.history(r.sessionId).filter((x) => x.type === "driver").map((x) => (x as { event: { type: string } }).event.type);
    expect(log).toEqual(expect.arrayContaining(["agent_started", "agent_text", "agent_tool_call", "agent_tool_call_update"]));
    // ListAgents on Studio lists it.
    expect(p.a.manager.list().map((v) => v.id)).toContain(r.sessionId);
  });

  test("a backend the other computer hasn't, or a root on another computer, refuses the start at once", async () => {
    const p = make();
    expect(isContractError(await delegate(p, { backend: "nope" }).catch((e: unknown) => e), "not_installed")).toBe(true);
    expect(isContractError(await delegate(p, { root: "home/Studio/project1" }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(p.a.host.list().filter((v) => v.kind === "agent")).toEqual([]);
  });

  test("its SendMessage reaches its own bot on the bot's computer, and nothing else", async () => {
    const p = make({ b: { quirks: S5_CURSOR_QUIRKS, level: "ask", script: [[{ mcp: { server: "$bridge", tool: "SendMessage", input: { message: "Halfway: 6 of 12 fixed." } } }, { say: "Done." }]] } });
    const r = await delegate(p);
    expect((await waitFor(() => notification(p.a), "the task notification")).text).toBe("Done.");
    expect(p.a.parentInputs("agent").map((x) => x.input)).toEqual([{ from: "agent", agent: r.sessionId, text: "Halfway: 6 of 12 fixed." }]);
    // Another bot's session, through Studio's own check.
    p.a.host.open({ id: "s_beta", kind: "bot", bot: "beta", computer: "Studio" }, p.a.parentDriver);
    expect(isContractError(await p.a.manager.remoteMessage(r.sessionId, "hi", "s_beta").catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("the other computer judges at its own level: the bot's routine level counts only when it isn't above it", async () => {
    expect(peerLevel("automatic", "ask")).toBe("ask");
    expect(peerLevel("read-only", "automatic")).toBe("read-only");
    expect(peerLevel(undefined, "accept-edits")).toBe("accept-edits");
    const p = make({ a: { level: "automatic" }, b: { level: "ask", script: [[{ tool: { kind: "edit", title: "Edit notes", paths: [] } }, { say: "Done." }], [{ tool: { kind: "edit", title: "Edit more", paths: [] } }, { say: "Done again." }]] } });
    const r = await delegate(p, { level: "automatic" });
    // A routine's "automatic" doesn't cross: Laptop's "ask" puts the call on a card there, from the bot's turn.
    const card = await waitFor(() => p.b.approvals.pending()[0], "Laptop's card");
    expect(card).toMatchObject({ kind: "agent-permission", computer: "Laptop", session: r.sessionId, origin: "bot" });
    expect(p.a.approvals.pending()).toEqual([]);
    p.b.approvals.cancelSession(r.sessionId);
    await waitFor(() => notification(p.a), "the first turn's end");
    // The user's own message on Studio is a peer's turn on Laptop: Laptop can't check that the user sent it.
    await p.a.host.sendUser(r.sessionId, { text: "Edit more.", device: STUDIO, clientMessageId: "m1", sentAt: p.a.clock.now() });
    const second = await waitFor(() => p.b.approvals.pending().find((c) => c.id !== card.id), "the second card");
    expect(second).toMatchObject({ origin: "peer" });
  });

  test("the bot's pause on its own computer holds a tool call already running on the other", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent's long step");
    // Studio's pause reaches Laptop while the turn runs there.
    p.pauseA.set(true);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "the pause on Laptop");
    proceed(p.b);
    await waitFor(() => blockedOn(p.b, "permission"), "the agent's call");
    await Bun.sleep(400);
    expect(p.b.report("answer")).toEqual([]);
    p.pauseA.set(false);
    await waitFor(() => p.b.report("answer").length === 1, "the call answered once resumed");
    expect((await waitFor(() => notification(p.a), "the task notification")).text).toBe("Done.");
  });

  test("a dropped link holds the agent's next call until the bot's computer is back, and the turn goes on", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent's long step");
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    proceed(p.b);
    await waitFor(() => blockedOn(p.b, "permission"), "the agent's call");
    await Bun.sleep(400);
    expect(p.b.report("answer")).toEqual([]);
    expect(notification(p.a)).toBeUndefined();
    // Back: Studio says it isn't paused, the call goes on, and what Laptop kept meanwhile arrives in order.
    p.net.heal(STUDIO, LAPTOP);
    const n = await waitFor(() => notification(p.a), "the task notification");
    expect(n).toMatchObject({ stopReason: "end_turn", text: "Done." });
  });

  test("TaskStop on the bot's computer stops the agent on the other", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    expect(p.b.manager.peerHosted(r.sessionId)).toBeDefined();
    await p.a.manager.stop(r.sessionId, { bot: "alpha" });
    await waitFor(() => p.b.manager.peerHosted(r.sessionId) === undefined, "the agent gone from Laptop");
    expect(p.a.host.get(r.sessionId)?.status).toBe("stopped");
  });

  test("the other computer restarted: the bot's next message opens the agent there again, resuming its own session", async () => {
    const p = make({ b: { script: [[{ say: "First." }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    // Laptop's daemon closes (its agents' processes end; their sessions stay with Studio).
    await p.b.manager.close();
    expect(p.b.manager.peerHosted(r.sessionId)).toBeUndefined();
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    await waitFor(() => p.a.parentInputs("task-notification").length === 2, "the second turn's end");
    expect(p.b.report("session").map((x) => x["how"])).toEqual(["new", "resume"]);
    expect(p.b.report("session")[1]).toMatchObject({ sessionId: "fake-session-1", cwd: p.b.project });
  });

  test("the bot's computer restarted: it reattaches the session from its own record, and the agent there goes on", async () => {
    const p = make({ b: { script: [[{ say: "First." }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    const view = p.a.host.get(r.sessionId)!;
    // Studio's daemon goes; a new one starts on the same home, with a fresh host.
    p.peersA.close();
    await p.a.manager.close();
    const host = new FakeSessionHost({ clock: p.a.clock, approvals: p.a.approvals });
    host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    const manager = new AgentManager({
      home: p.a.cloverHome, computer: "Studio", host, approvals: p.a.approvals, tree: p.a.tree, fence: p.a.fence, backends: () => [],
      tokens: new BridgeTokens(), bridge: { ...bridgeCommand(), socketPath: join(p.a.root, "unused.sock") }, watchdog: new StallWatchdog({ clock: p.a.clock }), clock: p.a.clock,
    });
    const devices: Record<string, string> = { Laptop: LAPTOP };
    const peers = new AgentPeers(manager, { transport: p.net.endpoint(STUDIO), computer: (n) => (devices[n] ? { device: devices[n]!, online: true } : undefined), mayCall: () => true, fence: p.fenceA, clock: p.a.clock, home: p.a.cloverHome });
    try {
      expect(manager.reattach(view)).toBe(true);
      expect(host.get(r.sessionId)).toMatchObject({ computer: "Laptop", kind: "agent", bot: "alpha" });
      await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
      await waitFor(() => host.history("s_alpha").some((x) => x.type === "input" && x.input.from === "task-notification"), "the notification on the new daemon");
      // Laptop kept the agent: the same process ran the second turn.
      expect(p.b.report("session").map((x) => x["how"])).toEqual(["new"]);
      expect(p.b.report("prompt").length).toBe(2);
    } finally {
      peers.close();
      await manager.close();
    }
  });

  test("the bot's computer restarted during an outage: the old turn there ends, its held call cancelled, before anything goes on", async () => {
    const p = make({ graceMs: 300, graceMsB: 60_000, b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }], [{ say: "new" }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => notification(p.a), "the turn ended at Studio's grace");
    // Studio's daemon goes mid-outage, taking its owed interrupt with it; a new one reattaches the session.
    const view = p.a.host.get(r.sessionId)!;
    p.peersA.close();
    await p.a.manager.close();
    const host = new FakeSessionHost({ clock: p.a.clock, approvals: p.a.approvals });
    host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    const manager = new AgentManager({
      home: p.a.cloverHome, computer: "Studio", host, approvals: p.a.approvals, tree: p.a.tree, fence: p.a.fence, backends: () => [],
      tokens: new BridgeTokens(), bridge: { ...bridgeCommand(), socketPath: join(p.a.root, "unused.sock") }, watchdog: new StallWatchdog({ clock: p.a.clock }), clock: p.a.clock,
    });
    const peers = new AgentPeers(manager, { transport: p.net.endpoint(STUDIO), computer: (n) => (n === "Laptop" ? { device: LAPTOP, online: true } : undefined), mayCall: () => true, fence: p.fenceA, clock: p.a.clock, home: p.a.cloverHome });
    try {
      expect(manager.reattach({ ...view, status: "idle" })).toBe(true);
      // The old turn reaches its next call while the link is still cut: held (a dropped link holds the device's agents).
      proceed(p.b);
      await waitFor(() => blockedOn(p.b, "permission"), "the old turn's next call");
      // The link comes back: the new daemon's state, a newer base, ends the old turn and cancels its held call (or the
      // fresh open below does, whichever comes first). The bot's next message then runs.
      p.net.heal(STUDIO, LAPTOP);
      await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
      await waitFor(() => host.history("s_alpha").some((x) => x.type === "input" && x.input.from === "task-notification"), "the new message's turn");
      const n = host.history("s_alpha").find((x) => x.type === "input" && x.input.from === "task-notification")!;
      expect((n as { input: { text: string; stopReason: string } }).input).toMatchObject({ stopReason: "end_turn", text: "new" });
      // The old turn's call was cancelled, never allowed, and its tool never reached the session.
      expect(p.b.report("answer").map((a) => (a["answer"] as { outcome: string }).outcome)).toEqual(["cancelled"]);
      expect(JSON.stringify(host.history(r.sessionId))).not.toContain("npm test");
    } finally {
      peers.close();
      await manager.close();
    }
  });

  test("a turn whose answer the link lost is owed its closing interrupt: it never goes on there, and the next message runs", async () => {
    const p = make({ graceMsB: 60_000, b: { script: [[{ say: "First." }], [{ say: "new" }], [{ say: "never" }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    // Laptop takes the next `agent.turn`, and the link drops before Studio hears it was taken.
    const peerHosted = p.b.manager.peerHosted.bind(p.b.manager);
    let armed = true;
    p.b.manager.peerHosted = (id: string) => {
      if (armed) {
        armed = false;
        p.net.partition(STUDIO, LAPTOP);
      }
      return peerHosted(id);
    };
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Next." });
    await waitFor(() => p.a.parentInputs("task-notification").length === 2, "the turn ended on Studio");
    expect(armed).toBe(false);
    // Laptop holds the turn it took (the link dropped; the state on that request doesn't lift the hold).
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // Back inside Laptop's grace: the closing interrupt goes before Studio's state.
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state on Laptop");
    await Bun.sleep(600);
    // The turn Laptop took never reached the agent.
    expect(p.b.report("prompt")).toHaveLength(1);
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    await waitFor(() => p.a.parentInputs("task-notification").length === 3, "the next message's turn");
    expect((p.a.parentInputs("task-notification")[2]!.input as { text: string }).text).toBe("new");
    expect(p.b.report("prompt")).toHaveLength(2);
  });

  test("an owed interrupt to a computer that no longer has the agent is done: the next message re-opens it and runs", async () => {
    const p = make({ graceMs: 300, graceMsB: 60_000, b: { script: [[{ say: "Working." }, { wait: true }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => notification(p.a), "the turn ended at Studio's grace");
    // Laptop's daemon closes: it no longer has the agent.
    await p.b.manager.close();
    expect(p.b.manager.peerHosted(r.sessionId)).toBeUndefined();
    p.net.heal(STUDIO, LAPTOP);
    // The owed interrupt answers `not_found`, which settles it: Studio's state goes, unpaused.
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state on Laptop");
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    // The next message opens the agent there again (a new process, resuming), and runs.
    await waitFor(() => p.b.report("started").length === 2 && p.b.report("blocked").filter((x) => x["on"] === "wait").length === 2, "the agent opened again");
    process.kill(Number(p.b.report("started")[1]!["pid"]), "SIGUSR2");
    await waitFor(() => p.a.parentInputs("task-notification").length === 2, "the next message's turn");
    expect(p.a.parentInputs("task-notification")[1]!.input).toMatchObject({ stopReason: "end_turn" });
    expect(p.b.report("session").map((x) => x["how"])).toEqual(["new", "resume"]);
  });

  test("a hold lifts when the opener's state comes before this computer's watch says the link is back", async () => {
    const held = new HeldWatch();
    const p = make({ heldWatchB: held, b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    // The link is back, but Laptop's watch hasn't said so yet; Studio's unpaused state arrives first. The transport
    // says the link is up, so the authenticated message runs the link-up steps.
    held.held = true;
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by Studio's state");
    held.release();
  });

  test("a message taken before a drop and handled after it lifts nothing: the hold stays and the grace still ends the turn", async () => {
    const p = make({ graceMsB: 300, b: { script: [[{ say: "First." }], [{ say: "never" }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    const before = p.peersA.epochFor(LAPTOP);
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    // An `agent.turn {paused:false}` Studio sent before the drop, handled only now.
    await p.net.endpoint(LAPTOP).serve("agent.turn", { id: r.sessionId, turn: 2, prompt: { text: "Next." }, origin: "bot", paused: false, epoch: before, fence: p.fenceA.token() }, STUDIO);
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // Laptop's grace still runs: the held turn ends there without reaching the agent.
    await Bun.sleep(700);
    expect(p.b.report("prompt")).toHaveLength(1);
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state over the link that's back");
    await Bun.sleep(400);
    expect(p.b.report("prompt")).toHaveLength(1);
  });

  test("a state from the old link, handled after a fast re-dial, lifts nothing; the new link epoch's state does", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    const old = p.peersA.epochFor(LAPTOP);
    // The link drops and comes back at once; Studio is paused now, so its new state holds the agent.
    p.net.partition(STUDIO, LAPTOP);
    p.pauseA.set(true);
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => p.peersA.epochFor(LAPTOP) !== old, "Studio's new link epoch");
    await Bun.sleep(100);
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // A message of the old link, handled only now (the transport truthfully says the link is up): it lifts nothing.
    p.net.endpoint(LAPTOP).deliverNotify("agent.pause", { paused: false, epoch: old, fence: p.fenceA.token() }, STUDIO);
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // Studio resumes: its state, in the new epoch, lifts the hold.
    p.pauseA.set(false);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by the new epoch's state");
  });

  test("after a flap only this side saw, it asks for the opener's state again until it gets one, and the hold lifts", async () => {
    const heldA = new HeldWatch();
    const p = make({ heldWatchA: heldA, resyncBaseMs: 150, b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    // Studio never hears of the flap; Laptop holds the agent.
    heldA.held = true;
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    // Laptop's first ask fails: Studio refuses it (its view of the lease moved for a moment).
    const view = p.fenceA.view;
    p.fenceA.view = { ...view, epoch: 99 };
    p.net.heal(STUDIO, LAPTOP);
    await Bun.sleep(250);
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // Studio's view is back: a later ask succeeds and the hold lifts, though Studio never said anything on its own.
    p.fenceA.view = view;
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by a later ask");
    heldA.release();
  });

  test("a direct reply handled only after the link dropped and came back is not taken; the next ask on the live link is", async () => {
    const heldA = new HeldWatch();
    const p = make({ heldWatchA: heldA, resyncBaseMs: 1_500, b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    // Laptop's replies to its state questions are handed to it only when the test lets them go.
    let release = () => {};
    let gate: Promise<void> | undefined = new Promise<void>((r) => (release = r));
    let asked = 0;
    const real = p.peersB.request.bind(p.peersB);
    (p.peersB as unknown as { request: typeof real }).request = (async (device: string, method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) => {
      const r = await real(device, method, params, signal, timeoutMs);
      if (method === "agent.state") {
        asked++;
        if (gate) await gate;
      }
      return r;
    }) as typeof real;
    // Studio never hears of the flap; Laptop holds the agent and asks again at link-up.
    heldA.held = true;
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => asked === 1, "Laptop's first ask answered");
    // The link drops and comes back while that answer is still in hand: it belongs to the old link.
    p.net.partition(STUDIO, LAPTOP);
    await Bun.sleep(50);
    p.net.heal(STUDIO, LAPTOP);
    await Bun.sleep(50);
    gate = undefined;
    release();
    await Bun.sleep(300);
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    // The next ask, on the link as it is now, is taken and the hold lifts.
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by the next ask");
    expect(asked).toBeGreaterThanOrEqual(2);
    heldA.release();
  });

  test("an ask for the state that never gets an answer (a half-open connection) times out after 10 s, and the next ask lifts the hold", async () => {
    const heldA = new HeldWatch();
    const netClock = new FakeClock();
    let hung = 0;
    // Studio's first answer to a state question never comes.
    const wrapA = (t: LinkTransport): LinkTransport => new Proxy(t, {
      get: (target, prop, recv) => {
        if (prop === "handle") {
          return (method: string, fn: (params: unknown, from: string) => unknown) => target.handle(method, method !== "agent.state" ? fn : (params, from) => {
            if (hung++ === 0) return new Promise(() => {});
            return fn(params, from);
          });
        }
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const p = make({ heldWatchA: heldA, netClock, wrapA, resyncBaseMs: 100, b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    heldA.held = true;
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding the agent");
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => hung === 1, "Laptop's first ask, left unanswered");
    netClock.advance(STATE_TIMEOUT_MS - 1);
    await Bun.sleep(300);
    expect([hung, p.peersB.peerPaused(STUDIO)]).toEqual([1, true]);
    // The ask times out; the next one is answered and the hold lifts.
    netClock.advance(1);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by the next ask");
    expect(hung).toBe(2);
    heldA.release();
  });

  test("a stale message with an older daemon's base, seen or not, is dropped: the newer daemon's turn goes on", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }, { say: "Done." }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    // Studio's base is its daemon's boot; a message from an earlier daemon (never seen here) arrives late.
    const now = p.peersA.epochFor(LAPTOP);
    const boot = Number(now.slice(0, now.indexOf("-")));
    const older = `${boot - 1}-deadbeefdeadbeef:9`;
    p.net.endpoint(LAPTOP).deliverNotify("agent.pause", { paused: true, epoch: older, fence: p.fenceA.token() }, STUDIO);
    expect(p.peersB.peerPaused(STUDIO)).toBe(false);
    // Studio's turn wasn't ended, and Studio isn't refused: the turn finishes.
    proceed(p.b);
    expect((await waitFor(() => notification(p.a), "the turn's end")).stopReason).toBe("end_turn");
    p.pauseA.set(true);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Studio's own state still taken");
  });

  test("a daemon's base orders by its home's boot counter: a clock stepped back across a restart still gives a newer one", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-k-boot-"));
    const realNow = Date.now;
    try {
      const boot = (b: string) => Number(b.slice(0, b.indexOf("-")));
      const first = nextBootBase(home);
      // The clock steps back a day before the next start.
      Date.now = () => realNow() - 86_400_000;
      const second = nextBootBase(home);
      expect(boot(second)).toBeGreaterThan(boot(first));
      // The counter file is lost: the last base sent keeps it from going back, whatever the clock says.
      rmSync(bootFiles(home).counter);
      const third = nextBootBase(home);
      expect(boot(third)).toBeGreaterThan(boot(second));
      // A broken counter, and no last base either: it starts from the wall clock's seconds.
      writeFileSync(bootFiles(home).counter, "not a number");
      rmSync(bootFiles(home).lastBase);
      Date.now = realNow;
      expect(boot(nextBootBase(home))).toBeGreaterThanOrEqual(Math.floor(realNow() / 1000) - 1);
    } finally {
      Date.now = realNow;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the boot counter never goes back: loose formats and an empty file are broken, never below the last base, and it stays at its cap", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-k-boot2-"));
    try {
      const boot = (b: string) => Number(b.slice(0, b.indexOf("-")));
      const files = bootFiles(home);
      nextBootBase(home);
      const high = Math.floor(Date.now() / 1000) + 10_000;
      for (const text of ["", " ", "1e15", "0x10", "-1", "12.5", "+7", `${MAX_BOOT_COUNTER + 1}`, "99999999999999999999"]) {
        writeFileSync(files.counter, text);
        writeFileSync(files.lastBase, `${high}-aa\n`);
        // Broken: the larger of the clock's seconds and one above the last base sent; never below that.
        expect([text, boot(nextBootBase(home))]).toEqual([text, high + 1]);
      }
      // Both files emptied: the clock's seconds (a peer that saw a higher base takes this daemon's direct reply).
      writeFileSync(files.counter, "");
      writeFileSync(files.lastBase, "");
      expect(boot(nextBootBase(home))).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 1);
      // MAX−1, then two restarts: it reaches the cap and stays there, never going back.
      writeFileSync(files.counter, `${MAX_BOOT_COUNTER - 1}`);
      writeFileSync(files.lastBase, `${MAX_BOOT_COUNTER - 1}-aa`);
      const a = boot(nextBootBase(home));
      const b = boot(nextBootBase(home));
      expect([a, b]).toEqual([MAX_BOOT_COUNTER, MAX_BOOT_COUNTER]);
      expect(readFileSync(files.counter, "utf8").trim()).toBe(`${MAX_BOOT_COUNTER}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a restarted daemon whose base ranks older (both boot files lost, the clock stepped back) still takes over through the direct reply; the daemon it replaced stays retired", async () => {
    const p = make({ b: { script: [[{ say: "First." }], [{ say: "new" }, { wait: true }, { say: "done" }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    const view = p.a.host.get(r.sessionId)!;
    const replaced = p.peersA.epochFor(LAPTOP);
    // Studio's daemon goes; its boot files are emptied and its clock is a day behind when the next one starts.
    p.peersA.close();
    await p.a.manager.close();
    // The link drops meanwhile: Laptop holds Studio's agents until Studio's new daemon gives its state.
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => p.peersB.peerPaused(STUDIO), "Laptop holding Studio's agents");
    writeFileSync(bootFiles(p.a.cloverHome).counter, "");
    writeFileSync(bootFiles(p.a.cloverHome).lastBase, "");
    const realNow = Date.now;
    Date.now = () => realNow() - 86_400_000;
    const host = new FakeSessionHost({ clock: p.a.clock, approvals: p.a.approvals });
    host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver());
    const manager = new AgentManager({
      home: p.a.cloverHome, computer: "Studio", host, approvals: p.a.approvals, tree: p.a.tree, fence: p.a.fence, backends: () => [],
      tokens: new BridgeTokens(), bridge: { ...bridgeCommand(), socketPath: join(p.a.root, "unused.sock") }, watchdog: new StallWatchdog({ clock: p.a.clock }), clock: p.a.clock,
    });
    let peers: AgentPeers | undefined;
    try {
      peers = new AgentPeers(manager, { transport: p.net.endpoint(STUDIO), computer: (n) => (n === "Laptop" ? { device: LAPTOP, online: true } : undefined), mayCall: () => true, fence: p.fenceA, clock: p.a.clock, home: p.a.cloverHome });
      Date.now = realNow;
      const before = peers.epochFor(LAPTOP);
      expect(Number(before.slice(0, before.indexOf("-")))).toBeLessThan(Number(p.peersA.epochFor(LAPTOP).split("-")[0]));
      // Its state message ranks older than the base Laptop last saw and is refused; the direct reply to Laptop's own
      // question on the live link is taken, and the hold lifts.
      p.net.heal(STUDIO, LAPTOP);
      await waitFor(() => !p.peersB.peerPaused(STUDIO), "the hold lifted by the new daemon's direct reply");
      expect(manager.reattach({ ...view, status: "idle" })).toBe(true);
      await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
      await waitFor(() => blockedOn(p.b, "wait"), "the new daemon's turn at work");
      // A late, reordered message of the daemon it replaced (ranked newer): retired, it ends nothing and holds nothing.
      const late = `${replaced.slice(0, replaced.indexOf(":"))}:99`;
      p.net.endpoint(LAPTOP).deliverNotify("agent.pause", { paused: true, epoch: late, fence: p.fenceA.token() }, STUDIO);
      await Bun.sleep(100);
      expect(p.peersB.peerPaused(STUDIO)).toBe(false);
      proceed(p.b);
      await waitFor(() => host.history("s_alpha").some((x) => x.type === "input" && x.input.from === "task-notification"), "the next message's turn");
      expect(p.peersB.peerPaused(STUDIO)).toBe(false);
      const n = host.history("s_alpha").find((x) => x.type === "input" && x.input.from === "task-notification")!;
      expect((n as { input: { stopReason: string } }).input.stopReason).toBe("end_turn");
    } finally {
      Date.now = realNow;
      peers?.close();
      await manager.close();
    }
  });

  test("a re-open goes on only with the plugin whose backend ran the agent there", async () => {
    const p = make({ b: { script: [[{ say: "First." }], [{ say: "never" }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the first turn's end");
    expect(readAgentRecord(p.a.cloverHome, r.sessionId)).toMatchObject({ pluginId: "clover/agent-fake" });
    // Laptop restarts, and another plugin holds the backend's id there now.
    await p.b.manager.close();
    (p.b.backend as unknown as { pluginId: string }).pluginId = "someone/agents";
    const started = p.b.report("started").length;
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    await waitFor(() => p.a.parentInputs("task-notification").length === 2, "the refused turn");
    expect(p.a.parentInputs("task-notification")[1]!.input).toMatchObject({ stopReason: "refusal", text: expect.stringContaining("plugin changed") });
    expect(p.b.report("started")).toHaveLength(started);
  });

  test("a re-open from the same computer while a turn runs there ends that turn: nothing more of it lands", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }, { say: "AFTER-REOPEN" }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const studio = await p.net.endpoint(STUDIO).connect(LAPTOP);
    await studio.request("agent.open", { id: r.sessionId, backend: "fake", root: "home/Laptop/project1", bot: "alpha", parent: "s_alpha", paused: false, epoch: p.peersA.epochFor(LAPTOP), fence: p.fenceA.token() });
    const before = readFileSync(join(dir, "acp.ndjson"), "utf8").length;
    proceed(p.b);
    await Bun.sleep(600);
    expect(blockedOn(p.b, "permission")).toBe(false);
    expect(readFileSync(join(dir, "acp.ndjson"), "utf8").length).toBe(before);
    expect(JSON.stringify(p.a.host.history(r.sessionId))).not.toContain("AFTER-REOPEN");
  });

  test("a computer whose view of the lease is behind can't place or drive an agent", async () => {
    const p = make({ b: { script: [[{ say: "Done." }]] } });
    // Laptop saw a takeover Studio missed.
    p.fenceB.view = { scope: "acct_1", epoch: 4, holder: OTHER };
    const err = await delegate(p).catch((e: unknown) => e);
    expect(isContractError(err, "not_main")).toBe(true);
    expect(p.a.host.list().filter((v) => v.kind === "agent")).toEqual([]);
  });

  test("only the computer that opened an agent drives it; another opens it again first, which moves it", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    const other = await p.net.endpoint(OTHER).connect(LAPTOP);
    const fence = p.fenceB.token();
    for (const [method, params] of [["agent.stop", { id: r.sessionId }], ["agent.interrupt", { id: r.sessionId }], ["agent.setModel", { id: r.sessionId, model: "m" }]] as const) {
      expect(isContractError(await other.request(method, { ...params, fence }).catch((e: unknown) => e), "refused")).toBe(true);
    }
    expect(p.b.manager.peerHosted(r.sessionId)?.peer.device).toBe(STUDIO);
    // Without the token, nothing.
    expect(isContractError(await other.request("agent.open", { id: r.sessionId, backend: "fake", root: "home/Laptop/project1", bot: "alpha", paused: false, epoch: "other:1" }).catch((e: unknown) => e), "not_main")).toBe(true);
    // A paired computer with a current token that isn't the lease's holder can't take it over (the ruling: a token
    // proves only that its view is current, not that it is the main).
    const open = { id: r.sessionId, backend: "fake", root: "home/Laptop/project1", bot: "alpha", parent: "s_alpha", paused: false, epoch: "other:1" };
    expect(isContractError(await other.request("agent.open", { ...open, fence }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(p.b.manager.peerHosted(r.sessionId)?.peer.device).toBe(STUDIO);
    // It became the main (Laptop's own lease says so): it opens the agent again, which moves it there, and Studio's acts
    // are refused (its token is now stale, and it isn't the opener).
    p.fenceB.view = { scope: "acct_1", epoch: 4, holder: OTHER };
    await other.request("agent.open", { ...open, fence: p.fenceB.token() });
    expect(p.b.manager.peerHosted(r.sessionId)?.peer.device).toBe(OTHER);
    const studio = await p.net.endpoint(STUDIO).connect(LAPTOP);
    expect(isContractError(await studio.request("agent.interrupt", { id: r.sessionId, fence: p.fenceB.token() }).catch((e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await studio.request("agent.interrupt", { id: r.sessionId, fence }).catch((e: unknown) => e), "not_main")).toBe(true);
  });

  test("a transcript file name is one of the three logs exactly: never a name the prototype has", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const laptop = await p.net.endpoint(LAPTOP).connect(STUDIO);
    const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "toLocaleString", "__defineGetter__"];
    for (const file of names) laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file, text: "x".repeat(1024), fence: p.fenceA.token() });
    // A real line after them, so the ones before have been handled.
    laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "calls.ndjson", text: "{\"mark\":1}\n", fence: p.fenceA.token() });
    await waitFor(() => existsSync(join(dir, "calls.ndjson")) && readFileSync(join(dir, "calls.ndjson"), "utf8").includes("mark"), "the real line");
    for (const file of names) expect(existsSync(join(dir, file))).toBe(false);
    const t = new AgentTranscript(p.a.cloverHome, r.sessionId, "alpha");
    for (const file of names) expect(t.appendFromPeer(file, "x")).toBe(false);
  });

  test("a streamed line with no turn running is dropped", async () => {
    const p = make({ b: { script: [[{ say: "Done." }]] } });
    const r = await delegate(p);
    await waitFor(() => notification(p.a), "the turn's end");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const laptop = await p.net.endpoint(LAPTOP).connect(STUDIO);
    laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "calls.ndjson", text: "{\"late\":1}\n", fence: p.fenceA.token() });
    laptop.notify("agent.event", { id: r.sessionId, turn: 1, event: { type: "agent_text", text: "late" }, fence: p.fenceA.token() });
    await Bun.sleep(200);
    expect(existsSync(join(dir, "calls.ndjson")) ? readFileSync(join(dir, "calls.ndjson"), "utf8") : "").not.toContain("late");
    expect(JSON.stringify(p.a.host.history(r.sessionId))).not.toContain("late");
  });

  test("a turn the bot's computer ended at the link's grace never goes on there once the link is back", async () => {
    const p = make({ graceMs: 300, graceMsB: 60_000, b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    const n = await waitFor(() => notification(p.a), "the turn ended at the grace");
    expect(n.stopReason).not.toBe("end_turn");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const sizes = () => ["acp.ndjson", "calls.ndjson"].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)).length : 0));
    const before = { files: sizes(), log: p.a.host.history(r.sessionId).length };
    // Back: Studio interrupts that turn there, closed, before its pause state lets anything go on.
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state on Laptop");
    proceed(p.b);
    await Bun.sleep(600);
    expect(blockedOn(p.b, "permission")).toBe(false);
    expect(sizes()).toEqual(before.files);
    expect(p.a.host.history(r.sessionId).length).toBe(before.log);
  });

  test("a closing interrupt lost to a link flap stays owed: the old turn stays held, and the interrupt goes at the next link-up", async () => {
    const p = make({ graceMs: 300, graceMsB: 60_000, b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    await waitFor(() => notification(p.a), "the turn ended at Studio's grace");
    // A flap: the link is back for an instant, and the interrupt Studio sends then is lost with it.
    p.net.heal(STUDIO, LAPTOP);
    p.net.partition(STUDIO, LAPTOP);
    await Bun.sleep(300);
    // Laptop got no state from Studio: the old turn's next call is held.
    expect(p.peersB.peerPaused(STUDIO)).toBe(true);
    proceed(p.b);
    await waitFor(() => blockedOn(p.b, "permission"), "the old turn's next call");
    await Bun.sleep(300);
    expect(p.b.report("answer")).toEqual([]);
    // Back for good: the interrupt goes first, then Studio's state; the call is cancelled, never allowed.
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state on Laptop");
    await waitFor(() => p.b.report("answer").length === 1, "the held call answered");
    expect(p.b.report("answer")[0]).toMatchObject({ answer: { outcome: "cancelled" } });
    expect(p.a.parentInputs("task-notification")).toHaveLength(1);
    expect(JSON.stringify(p.a.host.history(r.sessionId))).not.toContain("npm test");
  });

  test("only the latest pause state waits for a device whose link is down", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    for (let i = 0; i < 50; i++) p.pauseA.set(i % 2 === 0);
    p.pauseA.set(true);
    const seen: boolean[] = [];
    const off = p.net.endpoint(LAPTOP).onNotify("agent.pause", (raw) => seen.push((raw as { paused: boolean }).paused));
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => seen.length > 0, "the pause state");
    await Bun.sleep(200);
    off();
    expect(seen).toEqual([true]);
  });

  test("a closed turn's lines still queued there never land in the next turn", async () => {
    const p = make({ graceMs: 300, graceMsB: 60_000, b: { script: [[{ say: "Working." }, { wait: true }, { say: "OLD-LINE" }, { wait: true }], [{ say: "new" }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    proceed(p.b);
    // The old turn says more while the link is down: it waits in Laptop's outbox.
    await waitFor(() => p.b.report("blocked").filter((x) => x["on"] === "wait").length === 2, "the old turn's second wait");
    await waitFor(() => notification(p.a), "the old turn ended at Studio's grace");
    p.net.heal(STUDIO, LAPTOP);
    // The next turn starts at once.
    await p.a.host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Go on." });
    await waitFor(() => p.a.parentInputs("task-notification").length === 2, "the next turn's end");
    expect((p.a.parentInputs("task-notification")[1]!.input as { text: string }).text).toBe("new");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    expect(readFileSync(join(dir, "acp.ndjson"), "utf8")).not.toContain("OLD-LINE");
    expect(JSON.stringify(p.a.host.history(r.sessionId))).not.toContain("OLD-LINE");
  });

  test("the other computer ends a turn whose opener stays away past the grace; its end reaches the opener once back", async () => {
    const p = make({ graceMs: 60_000, graceMsB: 300, b: { script: [[{ say: "Working." }, { wait: true }, { tool: { kind: "execute", title: "npm test", rawInput: { command: "npm test" } } }, { say: "Done." }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    await Bun.sleep(600);
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => !p.peersB.peerPaused(STUDIO), "Studio's state on Laptop");
    // Laptop ended it at its grace, and its end was kept for Studio.
    const n = await waitFor(() => notification(p.a), "the turn's end from Laptop");
    expect(n.stopReason).not.toBe("end_turn");
    proceed(p.b);
    await Bun.sleep(600);
    expect(blockedOn(p.b, "permission")).toBe(false);
    expect(JSON.stringify(p.a.host.history(r.sessionId))).not.toContain("npm test");
  });

  test("past the outbox's bound a turn fails closed: interrupted there, one marker in order, recorded here", async () => {
    const big = (c: string) => ({ say: c.repeat(40_000) });
    const p = make({ outboxBytes: 64 * 1024, b: { script: [[{ say: "Working." }, { wait: true }, big("x"), big("y"), big("z"), { say: "Done." }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    p.net.partition(STUDIO, LAPTOP);
    proceed(p.b);
    await Bun.sleep(800);
    p.net.heal(STUDIO, LAPTOP);
    await waitFor(() => notification(p.a), "the turn's end");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const calls = readFileSync(join(dir, "calls.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(calls.filter((c) => c["type"] === "stream-truncated")).toEqual([expect.objectContaining({ by: "outbox" })]);
    const events = p.a.host.history(r.sessionId).filter((x) => x.type === "driver").map((x) => (x as { event: Record<string, unknown> }).event);
    expect(events.filter((e) => e["type"] === "agent_stream_truncated")).toHaveLength(1);
    // Nothing past the marker: the text the outbox couldn't take never arrived.
    expect(JSON.stringify(events)).not.toContain("z".repeat(1000));
  });

  test("streamed lines are taken only for an agent this computer opened there, and within the bounds", async () => {
    const p = make({ b: { script: [[{ say: "Working." }, { wait: true }]] } });
    const r = await delegate(p);
    await waitFor(() => blockedOn(p.b, "wait"), "the agent at work");
    const dir = join(p.a.cloverHome, "bots", "alpha", "agents", r.sessionId);
    const laptop = await p.net.endpoint(LAPTOP).connect(STUDIO);
    const other = await p.net.endpoint(OTHER).connect(STUDIO);
    const fence = p.fenceA.token();
    // From a device that didn't run it, and for an agent Studio never placed: dropped.
    other.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "calls.ndjson", text: "{\"forged\":1}\n", fence });
    laptop.notify("agent.transcript", { id: "agent_unknown123", turn: 1, file: "calls.ndjson", text: "{\"forged\":2}\n", fence });
    // Without the token, or past a line's bound: dropped, the second one said so.
    laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "calls.ndjson", text: "{\"forged\":3}\n" });
    laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "calls.ndjson", text: "x".repeat(MAX_STREAM_LINE + 1), fence });
    // Not one of the three logs: dropped.
    laptop.notify("agent.transcript", { id: r.sessionId, turn: 1, file: "agent.json", text: "{\"forged\":4}\n", fence });
    await waitFor(() => existsSync(join(dir, "calls.ndjson")) && readFileSync(join(dir, "calls.ndjson"), "utf8").includes("stream-refused"), "the refused line's record");
    expect(readFileSync(join(dir, "calls.ndjson"), "utf8")).not.toContain("forged");
    expect(readFileSync(join(dir, "agent.json"), "utf8")).not.toContain("forged");
    expect(existsSync(join(p.a.cloverHome, "bots", "alpha", "agents", "agent_unknown123"))).toBe(false);
  });
});
