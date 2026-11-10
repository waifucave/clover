// Lane A's in-process subagents (`clover`, A-M3) as the core registers them (`inProcessBackend`, K-M3): every
// delegation gets the pause gate, and the whole Clover home is out of its reach, by the manager's fence for its Bash
// sandbox and as private folders for its file tools, as #208 asks of every agent backend.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { HookCallbackMatcher, Options } from "@waifucave/clover-agent-sdk";
import { join } from "node:path";
import { IN_PROCESS_BACKEND_ID } from "../../runtime-sdk/turn-loop/subagent-backend";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { createAgents, inProcessBackend } from "../index";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const MODEL = "winter-test/calls";
// The backend's sandbox is macOS-only for now, and off macOS it reports itself not available. These tests check what
// holds on every OS (no command of theirs needs the sandbox to run), so the backend is told the sandbox can run; the
// refusal itself is pinned in remote-in-process.test.ts.
const SANDBOX_READY = () => true;

function make(spawn: Parameters<Parameters<typeof describeWithEmbeddedRuntime>[1]>[0], o: WorldOptions = {}): World {
  let w!: World;
  w = new World({
    ...o,
    extraBackends: (_wire, self) => [inProcessBackend({ home: self.cloverHome, spawn, defaultModel: () => MODEL }, { home: self.cloverHome, sandboxReady: SANDBOX_READY, ...(o.pause ? { pause: o.pause } : {}) })],
  });
  world = w;
  return w;
}

const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as { stopReason?: string; text?: string } | undefined;

test("the delegating bot's pause reaches every tool call, and with no switch the gate is open, never missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "clover-k-inproc-"));
  try {
    let paused = false;
    const listeners = new Set<() => void>();
    const pause = { mayAct: () => !paused, watch: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) };
    const seen: Options[] = [];
    // The runtime itself isn't needed: the options the backend builds carry the hook the pause holds at.
    const query = ((args: { options: Options }) => {
      seen.push(args.options);
      const ac = args.options.abortController!;
      return Object.assign((async function* () { await new Promise((r) => ac.signal.addEventListener("abort", r, { once: true })); })(), { interrupt: async () => {} });
    }) as unknown as typeof import("@waifucave/clover-agent-sdk").query;
    const spec = { sessionId: "s_agent", root, bridge: { name: "b", command: "/bin/sh", args: [], env: {}, tools: [] }, fence: { allowWrite: [root], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" as const } };
    const hold = async (o: Options, signal: AbortSignal) => {
      const m = (o.hooks!.PreToolUse as HookCallbackMatcher[])[0]!;
      return m.hooks[0]!({ hook_event_name: "PreToolUse" } as never, "t1", { signal });
    };
    for (const withSwitch of [true, false]) {
      const home = join(root, `home-${withSwitch}`);
      const session = await inProcessBackend({ home, query, spawn: (() => { throw new Error("not spawned"); }) as never, defaultModel: () => "winter-test/calls" }, { home, ...(withSwitch ? { pause } : {}) }).start(spec);
      const options = seen.at(-1)!;
      // The whole home is a private folder: its file tools are denied it by rule.
      expect(options.permissions?.deny).toContain(`Read(/${home}/**)`);
      paused = true;
      let done = false;
      const p = hold(options, new AbortController().signal).then((r) => { done = true; return r; });
      await Bun.sleep(150);
      // Held while paused when the bot has a switch; never held (an open gate) when it has none.
      expect(done).toBe(!withSwitch);
      paused = false;
      for (const fn of listeners) fn();
      expect(await p).toEqual({});
      await session.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describeWithEmbeddedRuntime("the in-process subagents, as the core registers them", (spawn) => {
  test("the Clover home is out of reach: a direct Read, a Read through a link from the root, Bash cat and searches", async () => {
    const w = make(spawn);
    const MARK = "the-bot-remembers-a-secret";
    const files = [
      join(w.cloverHome, "bots", "alpha", "memory", "MEMORY.md"),
      join(w.cloverHome, "transcripts", "beta", "s_beta.jsonl"),
      join(w.cloverHome, "diffs", "s_beta", "1.diff"),
      join(w.cloverHome, "sdk", "file-history", "s_beta", "MEMORY.md"),
      join(w.cloverHome, "sessions", "bots", "s_beta.jsonl"),
      join(w.cloverHome, "bots", "beta", "agents", "agent_other", "acp.ndjson"),
      // The file secret store's file (Linux and Windows), and another session's log.
      join(w.cloverHome, "secrets.enc"),
      join(w.cloverHome, "sessions", "s_gamma.jsonl"),
    ];
    const links: string[] = [];
    for (const [i, f] of files.entries()) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, `{"text":"${MARK}"}\n`);
      const link = join(w.project, `link-${i}`);
      symlinkSync(f, link);
      links.push(link);
    }
    symlinkSync(join(w.cloverHome, "transcripts"), join(w.project, "link-dir"));
    const calls = files.flatMap((f, i) => [
      `${i === 0 ? "" : "+"}CALL Read {"file_path":${JSON.stringify(f)}}`,
      `+CALL Read {"file_path":${JSON.stringify(links[i])}}`,
      `+CALL Bash {"command":${JSON.stringify(`cat '${f}' '${links[i]}'`)}}`,
    ]);
    calls.push(`+CALL Grep {"pattern":"remembers","path":${JSON.stringify(join(w.project, "link-dir"))}}`);
    calls.push(`+CALL Glob {"pattern":${JSON.stringify(`${w.cloverHome}/**/*.jsonl`)}}`);
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: IN_PROCESS_BACKEND_ID, root: "home/Studio/project1", title: "Probe",
      prompt: calls.join("\n"), model: MODEL,
    });
    await waitFor(() => notification(w), "the task notification");
    const history = w.host.history(r.sessionId);
    const events = history.flatMap((x) => (x.type === "driver" ? [(x as unknown as { event: Record<string, unknown> }).event] : []));
    // Every probe ran to its end.
    expect(events.filter((e) => e["type"] === "agent_tool_call_update" && (e["status"] === "completed" || e["status"] === "failed")).length).toBe(files.length * 3 + 2);
    expect(JSON.stringify(history)).not.toContain(MARK);
    // What each call really returned is in the runtime's own record of the session: none of it is the home's.
    const agentSessionId = events.find((e) => e["type"] === "agent_started")?.["agentSessionId"] as string;
    const record = [...new Bun.Glob(`**/${agentSessionId}.jsonl`).scanSync({ cwd: w.cloverHome, absolute: true })];
    expect(record.length).toBe(1);
    const results = readFileSync(record[0]!, "utf8");
    if (process.env["LANE_K_DUMP"]) await Bun.write(process.env["LANE_K_DUMP"], results);
    expect(results.match(/"type":"tool_result"/g)?.length).toBe(files.length * 3 + 2);
    // Each Read, direct or through a link from the root, is refused by the home's rule; a search finds nothing there.
    expect(results.match(/Denied by permission rule: Read\(/g)?.length).toBeGreaterThanOrEqual(files.length * 2);
    expect(results).not.toContain(MARK);
    expect(JSON.stringify(notification(w))).not.toContain(MARK);
  });

  test("an allow that arrives after its turn was interrupted doesn't count: the tool never runs", async () => {
    const w = make(spawn, { level: "ask" });
    const file = join(w.project, "never.txt");
    let id = "";
    const request = w.approvals.request.bind(w.approvals);
    // The card is answered "allow" while the user interrupts the turn: the allow is already on its way.
    w.approvals.request = async (req, opts) => {
      if (req.kind !== "agent-permission") return request(req, opts);
      void w.host.interrupt(id);
      return { allowed: true, by: "card", cardId: "card_late" };
    };
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: IN_PROCESS_BACKEND_ID, root: "home/Studio/project1", title: "Write", model: MODEL,
      prompt: `CALL Write {"file_path":${JSON.stringify(file)},"content":"no"}`,
    });
    id = r.sessionId;
    await waitFor(() => w.host.get(r.sessionId)?.status === "idle" || notification(w), "the turn's end");
    await Bun.sleep(300);
    expect(existsSync(file)).toBe(false);
    const calls = readFileSync(join(w.cloverHome, "bots", "alpha", "agents", r.sessionId, "calls.ndjson"), "utf8");
    expect(calls).toContain('"by":"cancelled"');
  });

  test("createAgents offers it beside the ACP backends", async () => {
    const w = make(spawn);
    const agents = createAgents({
      home: w.cloverHome, computer: "mac", socketPath: join(w.root, "x.sock"), host: w.host, approvals: w.approvals, tree: w.tree, fence: w.fence, clock: w.clock,
      inProcess: { home: w.cloverHome, spawn, defaultModel: () => MODEL },
    });
    try {
      const b = agents.backends().find((x) => x.id === IN_PROCESS_BACKEND_ID);
      expect(b).toBeDefined();
      expect((b as { inProcess?: boolean }).inProcess).toBe(true);
    } finally {
      await agents.close();
    }
  });
});
