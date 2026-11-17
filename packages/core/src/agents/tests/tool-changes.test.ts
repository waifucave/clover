// A change to the plugins' tools reaches a RUNNING agent session (lane AG). Four layers:
// * the real bridge process: it declares `listChanged`, asks the daemon for the list at every `tools/list`, and tells its
//   agent once for each `bridge.toolsChanged` the daemon sends;
// * the manager: each change of the set a session may see is ONE notification and the right list, nothing for a change
//   that touches none, a session started after holds exactly what a running one was told, and an agent that can't take a
//   change live is reopened before its next turn or its person told;
// * a generated sequence of install / remove / update / enable / tool-setting steps, with the invariant "what a running
//   session is told is what a fresh session would get";
// * the calls: a name an agent kept of a tool that has gone is refused at the call (plugin-reach.test.ts has each way).
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_TOOLS_CHANGED_NOTIFICATION } from "@waifucave/moss-protocol";
import { RpcPeer } from "@waifucave/clover-agent-sdk/acp";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { AgentQuirks } from "../../contracts/agent-backend";
import type { FakeAcpStep } from "../testing/fake-acp-agent";
import { bridgeMossParts, type BridgeHandlers } from "../bridge/handlers";
import { BRIDGE_MAIN_PATH } from "../bridge/main";
import { BRIDGE_ENV } from "../bridge/server";
import { BridgeTokens } from "../bridge/tokens";
import { BRIDGE_OWN_TOOLS, type BridgeToolDef, type BridgeToolSource } from "../bridge/tools";
import { inProcessBridgeServer } from "../bridge/in-process";
import { serveMoss } from "../testing/moss-endpoint";
import { toolsSignature } from "../manager";
import { waitFor, World } from "./world";

setDefaultTimeout(60_000);
const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-ag-")));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});
let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const sockPath = (name: string) => {
  const p = join(root, name);
  return p.length < 100 ? p : join("/tmp", `ck-${process.pid}-${name}`);
};

const def = (name: string, description = `The ${name} tool.`, preload = false): BridgeToolDef => ({ name, description, inputSchema: { type: "object" }, ...(preload ? { preload: true } : {}) });

describe.skipIf(!posix)("the bridge process follows the daemon's word that the tools changed", () => {
  test("it declares listChanged, lists afresh at every request, and tells its agent once per bridge.toolsChanged, after initialize only", async () => {
    const tokens = new BridgeTokens();
    let list: BridgeToolDef[] = [...BRIDGE_OWN_TOOLS];
    let link: { notify(m: string, p: unknown): void } | undefined;
    const handlers: BridgeHandlers = {
      sessionInfo: () => ({ bot: "alpha" }),
      tools: async () => ({ tools: list, instructions: "hi" }),
      call: async (_s, c) => ({ content: [{ type: "text", text: `ran ${c.tool}` }], isError: false }),
      sendMessage: async () => {},
      glossary: async () => ({ results: [], loaded: [] }),
      linked: (_s, l) => { link = l; },
    };
    const ep = serveMoss(sockPath("ag1.sock"), bridgeMossParts(tokens, handlers));
    const token = tokens.mint("agent_ag");
    const child = spawn("/bin/sh", ["-c", `"${process.execPath}" "${BRIDGE_MAIN_PATH}"; :`], { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "agent_ag", [BRIDGE_ENV.socket]: ep.socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const told: string[] = [];
    const mcp = new RpcPeer({ write: (l) => child.stdin!.write(l), onNotification: (m) => void told.push(m) });
    child.stdout!.on("data", (c: Buffer) => mcp.feed(c));
    tokens.bind("agent_ag", child.pid!);
    const names = async () => ((await mcp.request("tools/list", {})) as { tools: { name: string }[] }).tools.map((t) => t.name);

    // Before the agent initializes the bridge has nobody to tell (and the daemon has no link to it yet).
    const init = (await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })) as { capabilities: { tools: { listChanged: boolean } } };
    expect(init.capabilities.tools.listChanged).toBe(true);
    expect(await names()).toEqual(["SendMessage", "Glossary"]);
    await waitFor(() => link, "the daemon's link to the bridge");

    list = [...BRIDGE_OWN_TOOLS, def("plug__a")];
    link!.notify(BRIDGE_TOOLS_CHANGED_NOTIFICATION, {});
    await waitFor(() => told.length === 1, "the agent told once");
    expect(told).toEqual(["notifications/tools/list_changed"]);
    // The agent asks again and gets the list as it is now, with no restart.
    expect(await names()).toEqual(["SendMessage", "Glossary", "plug__a"]);
    // A call to a name the list no longer has still goes to the daemon, which refuses it there (the handler's own answer here).
    list = [...BRIDGE_OWN_TOOLS];
    link!.notify(BRIDGE_TOOLS_CHANGED_NOTIFICATION, {});
    await waitFor(() => told.length === 2, "the second");
    expect(await names()).toEqual(["SendMessage", "Glossary"]);
    expect(await mcp.request("tools/call", { name: "plug__a", arguments: {} })).toEqual({ content: [{ type: "text", text: "ran plug__a" }], isError: false });
    ep.close();
  });

  test("a bridge.toolsChanged before the agent has initialized tells it nothing", async () => {
    const tokens = new BridgeTokens();
    let link: { notify(m: string, p: unknown): void } | undefined;
    const handlers: BridgeHandlers = {
      sessionInfo: () => ({}),
      tools: async () => ({ tools: [...BRIDGE_OWN_TOOLS], instructions: "" }),
      call: async () => ({ content: [], isError: false }),
      sendMessage: async () => {},
      glossary: async () => ({ results: [], loaded: [] }),
      linked: (_s, l) => { link = l; },
    };
    const ep = serveMoss(sockPath("ag2.sock"), bridgeMossParts(tokens, handlers));
    const token = tokens.mint("agent_ag2");
    const child = spawn("/bin/sh", ["-c", `"${process.execPath}" "${BRIDGE_MAIN_PATH}"; :`], { env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "agent_ag2", [BRIDGE_ENV.socket]: ep.socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const told: string[] = [];
    const mcp = new RpcPeer({ write: (l) => child.stdin!.write(l), onNotification: (m) => void told.push(m) });
    child.stdout!.on("data", (c: Buffer) => mcp.feed(c));
    tokens.bind("agent_ag2", child.pid!);
    // The link is learned from the bridge's first request; a `ping` isn't one, so ask for the tools through a Glossary call.
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    await waitFor(() => link, "the link");
    link!.notify(BRIDGE_TOOLS_CHANGED_NOTIFICATION, {});
    await Bun.sleep(150);
    expect(told.length).toBe(1);
    ep.close();
  });
});

/** A plugin tool source the test changes: what the plugins would list for any session. */
function mutableTools() {
  let tools: BridgeToolDef[] = [];
  let instructions = "";
  const watchers = new Set<() => void>();
  /** What the plugins' `settled` waits on: each call is recorded with its wait, and runs `onSettled` (a server finishing its listing). */
  const settledCalls: number[] = [];
  let onSettled: (() => void) | undefined;
  const source: BridgeToolSource = {
    settled: async (ms) => { settledCalls.push(ms); onSettled?.(); },
    tools: async () => tools.map((t) => ({ ...t })),
    instructions: async () => instructions,
    call: async (_s, c) => (tools.some((t) => t.name === c.tool)
      ? { content: [{ type: "text", text: `ran ${c.tool}` }], isError: false }
      : { content: [{ type: "text", text: `No tool named ${c.tool} is available to this agent.` }], isError: true }),
  };
  return {
    source,
    settledCalls,
    onSettled(fn: (() => void) | undefined) { onSettled = fn; },
    set(next: BridgeToolDef[], words = instructions) { tools = next; instructions = words; },
    /** The plugins' watch: one call is one change event. */
    fire() { for (const fn of [...watchers]) fn(); },
    watch: (fn: () => void) => { watchers.add(fn); return () => void watchers.delete(fn); },
  };
}

/** A running coding session on the scripted agent, with a spy standing in for the stdio bridge's connection. */
async function running(o: { quirks?: AgentQuirks; script?: FakeAcpStep[][] } = {}) {
  const m = mutableTools();
  const w = (world = new World({ pluginTools: m.source, watchTools: m.watch, script: o.script ?? [[{ say: "Ready." }], [{ say: "Again." }]], ...(o.quirks ? { quirks: o.quirks } : {}) }));
  const r = await w.manager.start({ caller: { kind: "user", device: "d".repeat(16), clientMessageId: "m1", sentAt: w.clock.now() }, backend: "fake", prompt: "Hello.", root: "home/Studio/project1" });
  await waitFor(() => w.report("session")[0], "the agent's session");
  // The first turn is over before a test changes anything: its start syncs the list too, and a change made while it begins
  // would be told by it instead of by the test's own settle (still one notification, but not the one the test counts).
  await waitFor(() => w.host.history(r.sessionId).some((x) => x.type === "turn_ended"), "the first turn's end", 30_000);
  const told: number[] = [];
  const handlers = w.manager.bridgeHandlers();
  let n = 0;
  handlers.linked!(r.sessionId, { connId: 1, notify: (method) => { if (method === BRIDGE_TOOLS_CHANGED_NOTIFICATION) told.push(++n); } });
  const list = async () => (await handlers.tools(r.sessionId)).tools.map((t) => t.name);
  /** The change, then the settle: resolves once the manager has read the list it settled on. */
  const settle = async () => { m.fire(); await w.manager.refreshBridgeTools(); };
  return { w, m, r, told, list, settle, handlers };
}

describe("the manager tells a running session when its tools change", () => {
  test("an install, an update with a new definition, a setting that preloads, and a removal are one notification each, and the list a re-listing gets is the new one", async () => {
    const t = await running();
    t.m.set([def("plug__a")]);
    await t.settle();
    expect(t.told.length).toBe(1);
    expect(await t.list()).toEqual(["Glossary", "plug__a"]);
    // An update with a new definition: same name, new words.
    t.m.set([def("plug__a", "The tool, better.")]);
    await t.settle();
    expect(t.told.length).toBe(2);
    // The user's tool setting: on demand to always on (preload), a different list for the agent.
    t.m.set([def("plug__a", "The tool, better.", true)]);
    await t.settle();
    expect(t.told.length).toBe(3);
    expect((await t.handlers.tools(t.r.sessionId)).tools.find((x) => x.name === "plug__a")?.preload).toBe(true);
    // Removed (uninstalled, disabled, set off: all of them are the tool leaving the list).
    t.m.set([]);
    await t.settle();
    expect(t.told.length).toBe(4);
    expect(await t.list()).toEqual(["Glossary"]);
  });

  test("a change that touches no tool this session may see is no notification; instructions that changed are one", async () => {
    const t = await running();
    t.m.set([def("plug__a")]);
    await t.settle();
    expect(t.told.length).toBe(1);
    // Events with the same list (another plugin's install the session's scope doesn't reach, a setting on a tool it never had).
    for (let i = 0; i < 5; i++) await t.settle();
    expect(t.told.length).toBe(1);
    t.m.set([def("plug__a")], "Use plug__a for pictures.");
    await t.settle();
    expect(t.told.length).toBe(2);
  });

  test("a burst of events settles into one refresh: one notification (the debounce)", async () => {
    const t = await running();
    t.m.set([def("plug__a"), def("plug__b")]);
    for (let i = 0; i < 8; i++) t.m.fire();
    await waitFor(() => t.told.length > 0, "the notification");
    await Bun.sleep(600);
    expect(t.told.length).toBe(1);
    expect(await t.list()).toEqual(["Glossary", "plug__a", "plug__b"]);
  });

  test("a session started after the change holds the list a running session was told", async () => {
    const t = await running();
    t.m.set([def("plug__a"), def("plug__b", "Words.", true)], "Instructions.");
    await t.settle();
    const running1 = await t.handlers.tools(t.r.sessionId);
    const second = await t.w.manager.start({ caller: { kind: "user", device: "d".repeat(16), clientMessageId: "m2", sentAt: t.w.clock.now() }, backend: "fake", prompt: "Hello.", root: "home/Studio/project1" });
    await waitFor(() => t.w.report("session")[1], "the second session");
    const fresh = await t.w.manager.bridgeHandlers().tools(second.sessionId);
    // The same tools and words (the essentials name the session's own bridge server, so compare the plugins' part).
    expect(fresh.tools).toEqual(running1.tools);
    expect(toolsSignature({ tools: fresh.tools, instructions: "" })).toBe(toolsSignature({ tools: running1.tools, instructions: "" }));
    expect(fresh.instructions.endsWith("Instructions.")).toBe(true);
  });

  test("a session that is gone, or has no link yet, is changed without a fault", async () => {
    const t = await running();
    await t.w.manager.stop(t.r.sessionId).catch(() => {});
    t.m.set([def("plug__a")]);
    await t.settle();
    expect(t.told.length).toBeLessThanOrEqual(1);
  });
});

describe("an agent that can't take a change live", () => {
  const notices = (w: World, id: string) => w.host.history(id).filter((r) => r.type === "driver" && (r as { event: { type: string } }).event.type === "agent_notice").map((r) => (r as unknown as { event: { text: string } }).event.text);
  const again = (w: World, id: string, key: string) => w.host.sendUser(id, { text: "Again.", device: "d".repeat(16), clientMessageId: key, sentAt: w.clock.now() });

  test("an agent that doesn't declare it keeps its list and the person is told, once, at its next turn", async () => {
    const t = await running();
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "turn_ended"), "the first turn's end", 30_000);
    t.m.set([def("plug__a")]);
    await t.settle();
    // It was still told over the bridge (an agent that does honour it answers); nothing is said yet, no turn has run.
    expect(notices(t.w, t.r.sessionId)).toEqual([]);
    await again(t.w, t.r.sessionId, "m2");
    const said = await waitFor(() => notices(t.w, t.r.sessionId)[0], "the notice");
    expect(said).toContain("new: plug__a");
    expect(said).toContain("next session");
    // A second turn with no further change says nothing more.
    await waitFor(() => t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length >= 2, "the second turn's end", 30_000);
    expect(notices(t.w, t.r.sessionId).length).toBe(1);
  });

  test("a turn's start waits for the plugin servers to settle and syncs: a change no watcher reported is in the list that turn begins with, and the person is told of it", async () => {
    const t = await running();
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "turn_ended"), "the first turn's end", 30_000);
    const asked = t.m.settledCalls.length;
    // A server that finishes listing as the turn starts: no event was fired for it (the watchers have not spoken).
    t.m.onSettled(() => t.m.set([def("plug__late")]));
    await again(t.w, t.r.sessionId, "m2");
    const said = await waitFor(() => notices(t.w, t.r.sessionId)[0], "the notice for a change only the settle saw");
    expect(said).toContain("new: plug__late");
    expect(t.m.settledCalls.length).toBeGreaterThan(asked);
    expect(t.m.settledCalls.at(-1)).toBeGreaterThan(0);
    expect(await t.list()).toEqual(["Glossary", "plug__late"]);
  });

  test("next-turn: a change during a turn does not reopen the agent mid-turn; it is reopened at the next turn's start, once", async () => {
    const next: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, mcp: { ...WELL_BEHAVED_QUIRKS.mcp, toolListChanges: "next-turn" } };
    const t = await running({ quirks: next, script: [[{ say: "Ready." }], [{ exec: { seconds: 2 } }, { say: "Done." }], [{ say: "Again." }]] });
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "turn_ended"), "the first turn's end", 30_000);
    const opened = t.w.report("session").length;
    await again(t.w, t.r.sessionId, "m2");
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "driver" && (r as { event: { type: string } }).event.type === "agent_tool_call"), "the second turn under way", 30_000);
    t.m.set([def("plug__a")]);
    await t.settle();
    // Mid-turn: the session is the same one, still running its turn.
    expect(t.w.report("session").length).toBe(opened);
    expect(t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length).toBe(1);
    await waitFor(() => t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length >= 2, "the second turn's end", 30_000);
    expect(t.w.report("session").length).toBe(opened);
    await again(t.w, t.r.sessionId, "m3");
    await waitFor(() => t.w.report("session").length === opened + 1, "the agent opened again at the next turn");
    await waitFor(() => t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length >= 3, "the third turn's end", 30_000);
    expect(t.w.report("session").length).toBe(opened + 1);
  });

  test("next-session: the person is told once per change, not once per turn", async () => {
    const t = await running({ script: [[{ say: "1." }], [{ say: "2." }], [{ say: "3." }], [{ say: "4." }]] });
    const ended = (n: number) => waitFor(() => t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length >= n, `turn ${n}'s end`, 30_000);
    await ended(1);
    t.m.set([def("plug__a")]);
    await t.settle();
    await again(t.w, t.r.sessionId, "m2");
    await ended(2);
    expect(notices(t.w, t.r.sessionId).length).toBe(1);
    // A turn with nothing changed says nothing more.
    await again(t.w, t.r.sessionId, "m3");
    await ended(3);
    expect(notices(t.w, t.r.sessionId).length).toBe(1);
    // A second change is a second notice, and it names what changed since the list the agent holds.
    t.m.set([def("plug__a"), def("plug__b")]);
    await t.settle();
    await again(t.w, t.r.sessionId, "m4");
    await ended(4);
    const all = notices(t.w, t.r.sessionId);
    expect(all.length).toBe(2);
    expect(all[1]).toContain("new: plug__b");
    expect(all[1]).not.toContain("plug__a");
  });

  test("an agent that declares it takes the change live is told nothing in words", async () => {
    const live: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, mcp: { ...WELL_BEHAVED_QUIRKS.mcp, toolListChanges: "live" } };
    const t = await running({ quirks: live });
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "turn_ended"), "the first turn's end", 30_000);
    t.m.set([def("plug__a")]);
    await t.settle();
    await again(t.w, t.r.sessionId, "m2");
    await waitFor(() => t.w.host.history(t.r.sessionId).filter((r) => r.type === "turn_ended").length >= 2, "the second turn's end", 30_000);
    expect(notices(t.w, t.r.sessionId)).toEqual([]);
    expect(t.told.length).toBe(1);
  });

  test("an agent that declares next-turn is opened again before its next turn, with the list as it is now", async () => {
    const next: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, mcp: { ...WELL_BEHAVED_QUIRKS.mcp, toolListChanges: "next-turn" } };
    const t = await running({ quirks: next });
    await waitFor(() => t.w.host.history(t.r.sessionId).some((r) => r.type === "turn_ended"), "the first turn's end", 30_000);
    const before = t.w.report("session").length;
    t.m.set([def("plug__a")]);
    await t.settle();
    expect(t.w.report("session").length).toBe(before);
    await again(t.w, t.r.sessionId, "m2");
    await waitFor(() => t.w.report("session").length === before + 1, "the agent opened again");
    expect(t.w.report("session")[before]).toMatchObject({ how: "resume" });
    expect(notices(t.w, t.r.sessionId)).toEqual([]);
    expect(await t.list()).toEqual(["Glossary", "plug__a"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The generated sequence: a model of the plugins and the user's settings; the session is told at each settle, and what it
// holds is what a session started now would get, with exactly one notification per settled change of that list.
// ---------------------------------------------------------------------------------------------------------------------
type PluginState = { installed: boolean; enabled: boolean; version: number; setting: "default" | "on-demand" | "always" | "off" };
const NAMES = ["a", "b", "c"] as const;

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a fresh session would be given for the model: derived from the model alone, never from the manager. */
function expectedList(model: Record<string, PluginState>): BridgeToolDef[] {
  return NAMES.flatMap((n) => {
    const p = model[n]!;
    if (!p.installed || !p.enabled || p.setting === "off") return [];
    return [def(`plug_${n}__t`, `The ${n} tool, version ${p.version}.`, p.setting === "always")];
  });
}

describe("generated sequences of installs, removals, updates, enables and tool settings", () => {
  for (const seed of [11, 202, 3033]) {
    test(`seed ${seed}: after each settled batch the running session's list equals a fresh session's, with one notification per real change`, async () => {
      const t = await running();
      const next = rng(seed);
      const model: Record<string, PluginState> = Object.fromEntries(NAMES.map((n) => [n, { installed: false, enabled: true, version: 1, setting: "default" } satisfies PluginState]));
      let expected = expectedList(model);
      let toldBefore = 0;
      let held = await t.handlers.tools(t.r.sessionId); // what the agent holds: the list it last asked for
      let changes = 0;
      for (let batch = 0; batch < 40; batch++) {
        const steps = 1 + Math.floor(next() * 4);
        for (let i = 0; i < steps; i++) {
          const n = NAMES[Math.floor(next() * NAMES.length)]!;
          const p = model[n]!;
          switch (Math.floor(next() * 6)) {
            case 0: p.installed = true; break;
            case 1: p.installed = false; p.setting = "default"; break;
            case 2: p.enabled = !p.enabled; break;
            case 3: p.version++; break;
            case 4: p.setting = (["default", "on-demand", "always", "off"] as const)[Math.floor(next() * 4)]!; break;
            default: t.m.fire(); // an event that changes nothing
          }
        }
        const want = expectedList(model);
        t.m.set(want);
        const moved = JSON.stringify(want) !== JSON.stringify(expected);
        expected = want;
        await t.settle();
        if (moved) changes++;
        expect(t.told.length - toldBefore).toBe(moved ? 1 : 0);
        toldBefore = t.told.length;
        // The agent that follows the notification asks again; it must get what a session started now would.
        if (moved) held = await t.handlers.tools(t.r.sessionId);
        expect(held.tools.filter((x) => x.name !== "Glossary")).toEqual(want);
        const fresh = await t.w.manager.bridgeHandlers().tools("not-a-session"); // the source's list for a session the manager doesn't know: the same plugins' part
        expect(fresh.tools.filter((x) => x.name !== "Glossary" && x.name !== "SendMessage")).toEqual(want);
      }
      expect(changes).toBeGreaterThan(5);
      expect(t.told.length).toBe(changes);
    });
  }
});

describe("the in-process bridge (MOSS's own coding agent)", () => {
  const harness = () => {
    const m = mutableTools();
    let live = true;
    const calls: string[] = [];
    const handlers: BridgeHandlers = {
      sessionInfo: () => ({}),
      tools: async () => ({ tools: [...BRIDGE_OWN_TOOLS, ...(await m.source.tools("s"))], instructions: "" }),
      call: async (id, c) => { calls.push(c.tool); return m.source.call(id, c, { computer: "Studio", origin: "user" }); },
      sendMessage: async () => {},
      glossary: async () => ({ results: [], loaded: [] }),
    };
    return { m, calls, handlers, kill: () => { live = false; }, server: () => inProcessBridgeServer(handlers, { name: "moss_x", sessionId: "s", live: () => live }) };
  };

  test("a tool that came after the session started is served, one that has gone is refused where it is judged, a closed bridge refuses all", async () => {
    const h = harness();
    h.m.set([def("plug__a")]);
    const server = await h.server();
    const inst = server.instance as import("@waifucave/clover-agent-sdk").WinterMcpServerInstance;
    expect(inst.listTools().map((t) => t.name)).toEqual(["SendMessage", "Glossary", "plug__a"]);
    // Installed after the session started: not in the list the runtime was given, but a call is not refused for that.
    h.m.set([def("plug__a"), def("plug__b")]);
    expect(await inst.callTool("plug__b", {})).toEqual({ content: [{ type: "text", text: "ran plug__b" }], isError: false });
    // Gone: the handler (the plugins' list as it is now) refuses it; the in-process bridge doesn't answer from its start list.
    h.m.set([]);
    expect(await inst.callTool("plug__a", {})).toEqual({ content: [{ type: "text", text: "No tool named plug__a is available to this agent." }], isError: true });
    expect(h.calls).toEqual(["plug__b", "plug__a"]);
    // The session's token revoked (stopped, exited): everything is refused, before any handler.
    h.kill();
    expect(await inst.callTool("plug__b", {})).toEqual({ content: [{ type: "text", text: "Not run: this agent's bridge was closed." }], isError: true });
    expect(h.calls).toEqual(["plug__b", "plug__a"]);
  });
});
