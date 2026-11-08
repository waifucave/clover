// In-process subagents (lane A for lane K), the pause's watch over background tasks with a runtime that has no
// `stopTask` (#287's ruling, as lane K's clover-code does): it says so once a minute while it lasts and keeps watching,
// since the tasks may end on their own or the pause lift. A scripted runtime, so it runs on every OS.
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query as sdkQuery } from "@waifucave/clover-agent-sdk";
import type { AgentStartSpec } from "../../../src/contracts/agent-backend";
import { inProcessAgentBackend } from "../../../src/runtime-sdk/turn-loop/subagent-backend";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { setSystemTime(); });
const temp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };

function spec(root: string): AgentStartSpec {
  return {
    sessionId: "s_agent", root, model: "winter-test/echo",
    bridge: { name: "clover_bridge", command: "/bin/sh", args: ["-c", "exit 0"], env: {}, tools: [] },
    fence: { allowWrite: [root], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: ["169.254.169.254"], network: "none" },
  };
}

/** A runtime that yields what the test pushes, has no `stopTask`, and ends when told to (or aborted). */
function scriptedRuntime(): { query: typeof sdkQuery; push(msg: Record<string, unknown>): void; end(): void } {
  const backlog: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const end = () => { ended = true; wake?.(); };
  const query = ((args: { options?: { abortController?: AbortController } }) => {
    args.options?.abortController?.signal.addEventListener("abort", end);
    const it: AsyncIterableIterator<unknown> = {
      async next() {
        for (;;) {
          const msg = backlog.shift();
          if (msg !== undefined) return { done: false, value: msg };
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((r) => { wake = r; });
        }
      },
      async return() { end(); return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    return Object.assign(it, { interrupt: async () => {}, setModel: async () => {}, setEffort: async () => {} });
  }) as unknown as typeof sdkQuery;
  return { query, push: (msg) => { backlog.push(msg); wake?.(); }, end };
}

test("paused with background tasks and no stopTask: said once a minute while it lasts, and still watched until the tasks end", async () => {
  const lines: string[] = [];
  const said = () => lines.filter((l) => l.includes("can't stop a task")).length;
  // The switch, with the watch it hands the backend: `look()` runs the backend's own look, as a switch move does.
  let may = false;
  const watchers = new Set<() => void>();
  const gate = { mayAct: () => may, watch: (fn: () => void) => { watchers.add(fn); return () => watchers.delete(fn); } };
  const look = async () => { for (const fn of [...watchers]) fn(); await Bun.sleep(5); };
  const runtime = scriptedRuntime();
  const session = await inProcessAgentBackend({
    home: temp("clover-a3-pause-home-"), spawn: () => { throw new Error("no process here"); }, defaultModel: () => "winter-test/echo",
    pauseGateFor: () => gate, query: runtime.query, log: (l) => lines.push(l),
  }).start(spec(temp("clover-a3-pause-root-")));
  let t = Date.now();
  setSystemTime(new Date(t));
  try {
    runtime.push({ type: "system", subtype: "task_started", task_id: "bash-1", description: "server", task_type: "local_bash", uuid: crypto.randomUUID(), session_id: "x" });
    await Bun.sleep(20);
    // Paused: said once, and the watch stays.
    expect(said()).toBe(1);
    expect(watchers.size).toBe(1);
    // Within the minute: not said again, however often it looks (the switch moving, or the backend's own poll).
    t += 30_000;
    setSystemTime(new Date(t));
    await look();
    await Bun.sleep(1_100);
    expect(said()).toBe(1);
    // A minute on, still paused: said again.
    t += 31_000;
    setSystemTime(new Date(t));
    await look();
    expect(said()).toBe(2);
    // The pause lifts: nothing to say, and still watched (a task that remains could be paused again).
    may = true;
    t += 61_000;
    setSystemTime(new Date(t));
    await look();
    expect(said()).toBe(2);
    expect(watchers.size).toBe(1);
    may = false;
    await look();
    expect(said()).toBe(3);
    // The task ends on its own: the next look lets go, and a later minute says nothing.
    runtime.push({ type: "system", subtype: "task_notification", task_id: "bash-1", status: "completed", uuid: crypto.randomUUID(), session_id: "x" });
    await Bun.sleep(20);
    await look();
    expect(watchers.size).toBe(0);
    t += 61_000;
    setSystemTime(new Date(t));
    await Bun.sleep(1_100);
    expect(said()).toBe(3);
  } finally {
    runtime.end();
    await session.stop();
  }
}, 30_000);
