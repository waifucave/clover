// Clover's own coding agent over ACP (`clover-code`, K-M3, the controller's option A): `Agent` delegates to it like to
// any ACP agent. It runs in the daemon on the embedded runtime (`serveAcpAgent` over `query()`), Clover's own ACP
// client talks to it through an in-memory pipe, its writes ask through `session/request_permission` and the approval
// level, its bridge is in-process, and the pause holds its tool calls, read-only ones too.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { CLOVER_CODE_ID, CloverCodeBackend } from "../clover-code/backend";
import { agentMethods } from "../rpc";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const MODEL = "winter-test/calls";
const BRIDGE = "clover_testbridge";

/** What lane A's `embeddedSessionOptions` gives every in-process session, for a test model. */
function baseOptionsFor(home: string, spawn: SpawnClaudeCodeProcess) {
  return (o: { model: string; effort?: string; cwd: string }): Options => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CLOVER_HOME: home };
    const provider = testProviderNameFor(o.model);
    if (provider !== undefined) env["WINTER_TEST_PROVIDER"] = provider;
    return { brand: buildCoreBrand(undefined, home), model: o.model, cwd: o.cwd, env, spawnClaudeCodeProcess: spawn, settingSources: [] };
  };
}

function make(spawn: SpawnClaudeCodeProcess, o: WorldOptions & { pause?: WorldOptions["pause"] } = {}): World {
  let w!: World;
  w = new World({
    ...o,
    bridgeServerName: BRIDGE,
    extraBackends: (wire) => [new CloverCodeBackend({
      clock: { now: () => Date.now() } as never, wire, defaultModel: () => MODEL,
      baseOptions: (x) => baseOptionsFor(w.cloverHome, spawn)(x),
      ...(o.pause ? { pause: o.pause } : {}),
    })],
  });
  world = w;
  return w;
}

const notification = (w: World) => w.parentInputs("task-notification")[0]?.input as { stopReason?: string; text?: string } | undefined;

describeWithEmbeddedRuntime("Clover's coding agent over ACP", (spawn) => {
  test("a delegation runs in its root; a write asks through ACP and the level; the bot gets the report", async () => {
    const w = make(spawn);
    const file = join(w.project, "fixed.txt");
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Fix it",
      prompt: `CALL Write {"file_path":${JSON.stringify(file)},"content":"ok"}`,
      model: MODEL,
    });
    const n = await waitFor(() => notification(w), "the task notification");
    expect(n.stopReason).toBe("end_turn");
    expect(readFileSync(file, "utf8")).toBe("ok");
    // The request went over ACP, and the transcript has it.
    const transcript = readFileSync(join(w.cloverHome, r.transcript), "utf8");
    expect(transcript).toContain("session/request_permission");
    expect(transcript).toContain("clover-code");
  });

  test("its bridge is in-process: SendMessage reaches the bot with no bridge process and no socket hello", async () => {
    const w = make(spawn);
    const r = await w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Report",
      prompt: `CALL mcp__${BRIDGE}__SendMessage {"message":"halfway there"}`,
      model: MODEL,
    });
    await waitFor(() => notification(w), "the task notification");
    const messages = w.parentInputs().filter((i) => i.input.from !== "task-notification").map((i) => JSON.stringify(i.input));
    expect(messages.some((m) => m.includes("halfway there"))).toBe(true);
    // No stdio bridge was handed over: the session/new on the wire names no MCP server.
    const wire = readFileSync(join(w.cloverHome, r.transcript), "utf8");
    const opened = wire.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { msg?: { method?: string; params?: { mcpServers?: unknown[] } } }).find((l) => l.msg?.method === "session/new");
    expect(opened?.msg?.params?.mcpServers).toEqual([]);
  });

  test("the pause holds a read-only call until the user resumes", async () => {
    let paused = true;
    const listeners = new Set<() => void>();
    const gate = { mayAct: () => !paused, watch: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)) };
    const w = make(spawn, { pause: gate });
    const file = join(w.project, "README");
    await Bun.write(file, "read me");
    const started = w.manager.start({
      caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" },
      backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Read",
      prompt: `CALL Read {"file_path":${JSON.stringify(file)}}`,
      model: MODEL,
    });
    await Bun.sleep(1_500);
    expect(notification(w)).toBeUndefined();
    paused = false;
    for (const fn of listeners) fn();
    await started;
    expect((await waitFor(() => notification(w), "the task notification")).stopReason).toBe("end_turn");
  });

  test("it lists as an ACP backend of this computer, sandboxed, at the SDK's version", async () => {
    const w = make(spawn);
    const methods = agentMethods({ manager: w.manager, backends: () => [new CloverCodeBackend({ clock: { now: () => 0 } as never, defaultModel: () => MODEL, baseOptions: baseOptionsFor(w.cloverHome, spawn) })], computer: "Studio" });
    const view = (await methods["agent.backends"]!({}, { caller: { kind: "user", client: "app" } })) as { backends: Record<string, unknown>[] };
    expect(view.backends[0]).toMatchObject({ id: CLOVER_CODE_ID, name: "Clover's coding agent", protocol: "acp", placement: "local", computers: [{ installed: true, sandboxed: true, marks: [] }] });
    expect(existsSync(w.cloverHome)).toBe(true);
  });
});
