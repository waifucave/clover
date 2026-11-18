// A session's bridge server keeps its name for good (lane TS). The agent's history holds the tools it was offered under that
// name (`mcp__<server>__<tool>`: its frozen tool list, the tools it loaded through `Glossary`), so a session reattached after
// a restart under a NEW name has a history naming a server it no longer has: the runtime answers "No such tool available"
// for every one of those names that is not re-sent, and the tools of the new name are offered beside them.
//
// * a reattach goes on under the name the session was started with;
// * a generated sequence of restarts, plugin changes and turns: the name never moves, and the list the bridge gives is the
//   plugins' list as it is now ("every name the agent is offered is one it can call");
// * the record's name is the daemon's: a name of any other shape is dropped, and a session with none gets one written.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { S5_CURSOR_QUIRKS } from "../../contracts/fakes/agent-backend";
import { FakeSessionHost } from "../../contracts/fakes/session-host";
import { AcpAgentBackend } from "../backend";
import { bridgeMossParts } from "../bridge/handlers";
import { bridgeCommand } from "../bridge/main";
import type { BridgeToolDef, BridgeToolSource } from "../bridge/tools";
import { BridgeTokens } from "../bridge/tokens";
import { AgentManager } from "../manager";
import { agentRecordPath, BRIDGE_NAME_RE, readAgentRecord } from "../records";
import { FAKE_AGENT_PATH, fakeLaunch } from "../testing/harness";
import { serveMoss } from "../testing/moss-endpoint";
import { StallWatchdog } from "../watchdog";
import { fakeAdmissions, waitFor, World } from "./world";

setDefaultTimeout(90_000);

let world: World | undefined;
const later: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of later.splice(0)) await f();
  await world?.close();
  world = undefined;
});

const def = (name: string, version = 1): BridgeToolDef => ({ name, description: `The ${name} tool, version ${version}.`, inputSchema: { type: "object" } });

/** A plugin tool source the test changes: what the plugins would list for any session. */
function plugins() {
  let tools: BridgeToolDef[] = [];
  const watchers = new Set<() => void>();
  const source: BridgeToolSource = {
    settled: async () => {},
    tools: async () => tools.map((t) => ({ ...t })),
    instructions: async () => "",
    call: async (_s, c) => (tools.some((t) => t.name === c.tool)
      ? { content: [{ type: "text", text: `ran ${c.tool}` }], isError: false }
      : { content: [{ type: "text", text: `No tool named ${c.tool} is available to this agent.` }], isError: true }),
  };
  return {
    source,
    set(next: BridgeToolDef[]) { tools = next; },
    watch: (fn: () => void) => { watchers.add(fn); return () => void watchers.delete(fn); },
    fire() { for (const fn of [...watchers]) fn(); },
  };
}

/** The daemon restarting: the manager and the host are made again over the same home, as a new daemon would. */
async function restart(w: World, source: BridgeToolSource, watch: (fn: () => void) => () => void, current?: { close: () => Promise<void> }) {
  if (current !== undefined) await current.close();
  else await w.manager.close();
  const host = new FakeSessionHost({ clock: w.clock, approvals: w.approvals });
  host.open({ id: "s_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, w.parentDriver);
  const tokens = new BridgeTokens();
  let m!: AgentManager;
  const backend = new AcpAgentBackend({
    id: "fake", pluginId: "moss/agent-fake", quirks: fakeLaunch(S5_CURSOR_QUIRKS), clock: w.clock,
    command: { program: process.execPath, prefixArgs: [FAKE_AGENT_PATH, w.agent.config], acpArgs: ["acp"] }, wire: (id) => m.wire(id),
    admissions: fakeAdmissions("protected"),
  });
  m = new AgentManager({
    home: w.mossHome, computer: "Studio", host, approvals: w.approvals, tree: w.tree, fence: w.fence, backends: () => [backend],
    tokens, bridge: { ...bridgeCommand(), socketPath: w.endpoint.socketPath }, watchdog: new StallWatchdog({ clock: w.clock }), clock: w.clock,
    levelOf: () => w.level, pluginTools: source, watchTools: watch,
  });
  const ep = serveMoss(w.endpoint.socketPath, bridgeMossParts(tokens, m.bridgeHandlers()));
  const close = async () => {
    await m.close();
    ep.close();
  };
  later.push(close);
  return { host, m, close };
}

/** The bridge server name the agent was given, from what the scripted agent reported for its session `n`. */
const bridgeNameOf = (w: World, n: number): string => {
  const servers = (w.report("session")[n]?.["servers"] ?? []) as string[];
  const name = servers.find((s) => BRIDGE_NAME_RE.test(s));
  if (name === undefined) throw new Error(`the agent's session ${n} was given no bridge server (it got: ${servers.join(", ") || "none"})`);
  return name;
};

describe("a session's bridge server keeps its name across a restart", () => {
  test("the reattached agent is given the server name it was started with, and the record holds it", async () => {
    const p = plugins();
    p.set([def("plug_a__t")]);
    const w = (world = new World({ quirks: S5_CURSOR_QUIRKS, pluginTools: p.source, watchTools: p.watch, script: [[{ say: "first done" }], [{ say: "second done" }]] }));
    const r = await w.delegate();
    await waitFor(() => w.parentInputs("task-notification")[0], "the first notification");
    const first = bridgeNameOf(w, 0);
    expect(readAgentRecord(w.mossHome, r.sessionId)?.bridge).toBe(first);
    const view = w.host.get(r.sessionId)!;

    const { host, m } = await restart(w, p.source, p.watch);
    expect(m.reattach({ ...view, status: "idle" })).toBe(true);
    await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Now the docs." });
    await waitFor(() => w.report("session").length >= 2, "the agent's second session");
    expect(w.report("session").map((x) => x["how"])).toEqual(["new", "load"]);
    // The history the agent resumed names its tools `mcp__<first>__…`: the same server must be the one it has now.
    expect(bridgeNameOf(w, 1)).toBe(first);
    expect(readAgentRecord(w.mossHome, r.sessionId)?.bridge).toBe(first);
    await host.stop(r.sessionId);
  });

  test("a record's name of any other shape is dropped, and the session is given a new, well-formed one", async () => {
    const p = plugins();
    const w = (world = new World({ quirks: S5_CURSOR_QUIRKS, pluginTools: p.source, watchTools: p.watch, script: [[{ say: "first done" }], [{ say: "second done" }]] }));
    const r = await w.delegate();
    await waitFor(() => w.parentInputs("task-notification")[0], "the first notification");
    const first = bridgeNameOf(w, 0);
    const view = w.host.get(r.sessionId)!;
    // A record a forged name was written into (a name a user's own MCP server could hold, or one with a path in it).
    const file = agentRecordPath(w.mossHome, r.sessionId);
    for (const forged of ["moss", "moss_../x", "moss_ABCDEF0123456789", `${first}0`]) {
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), bridge: forged }));
      expect(readAgentRecord(w.mossHome, r.sessionId)?.bridge).toBeUndefined();
    }
    const { host, m } = await restart(w, p.source, p.watch);
    expect(m.reattach({ ...view, status: "idle" })).toBe(true);
    await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: "Now the docs." });
    await waitFor(() => w.report("session").length >= 2, "the agent's second session");
    const second = bridgeNameOf(w, 1);
    expect(second).toMatch(BRIDGE_NAME_RE);
    // The manager writes the name once the agent's session is open: wait for it (the forged one is on disk until then).
    await waitFor(() => readAgentRecord(w.mossHome, r.sessionId)?.bridge === second, "the record to hold the new name");
    await host.stop(r.sessionId);
  });
});

// A small seeded generator (mulberry32): the same seed, the same sequence.
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

describe("generated sequences of restarts, plugin changes and turns", () => {
  for (const seed of [5, 81]) {
    test(`seed ${seed}: the bridge server's name never moves, and the list the bridge gives is the plugins' list as it is now`, async () => {
      const next = rng(seed);
      const p = plugins();
      p.set([def("plug_a__t")]);
      const w = (world = new World({ quirks: S5_CURSOR_QUIRKS, pluginTools: p.source, watchTools: p.watch, script: Array.from({ length: 12 }, (_, i) => [{ say: `turn ${i}` }]) }));
      const r = await w.delegate();
      await waitFor(() => w.parentInputs("task-notification")[0], "the first notification");
      const name = bridgeNameOf(w, 0);
      let host = w.host;
      let m: AgentManager = w.manager;
      let current: Awaited<ReturnType<typeof restart>> | undefined;
      let sessions = 1;
      let restarts = 0;
      let version = 1;
      let installed = new Set(["a"]);
      for (let step = 0; step < 6; step++) {
        const move = Math.floor(next() * 3);
        if (move === 0 && restarts < 3) {
          const view = host.get(r.sessionId)!;
          current = await restart(w, p.source, p.watch, current);
          host = current.host;
          m = current.m;
          expect(m.reattach({ ...view, status: "idle" })).toBe(true);
          restarts++;
          await host.deliver(r.sessionId, { from: "bot", bot: "alpha", session: "s_alpha", text: `After restart ${restarts}.` });
          sessions++;
          await waitFor(() => w.report("session").length >= sessions, `the agent's session ${sessions}`);
          expect(bridgeNameOf(w, sessions - 1)).toBe(name);
        } else if (move === 1) {
          const n = ["a", "b", "c"][Math.floor(next() * 3)]!;
          if (installed.has(n) && next() < 0.5) installed.delete(n);
          else installed.add(n);
          version += next() < 0.3 ? 1 : 0;
          p.set([...installed].sort().map((x) => def(`plug_${x}__t`, version)));
          p.fire();
          await m.refreshBridgeTools();
        }
        // After any step: the list the bridge gives this session is the plugins' list as it is now, and it is on the
        // server whose name the agent holds (the record's), whatever happened.
        const given = (await m.bridgeHandlers().tools(r.sessionId)).tools.map((t) => t.name).filter((x) => x !== "Glossary" && x !== "SendMessage");
        expect(given).toEqual([...installed].sort().map((x) => `plug_${x}__t`));
        expect(readAgentRecord(w.mossHome, r.sessionId)?.bridge).toBe(name);
      }
      await host.stop(r.sessionId);
    });
  }
});
