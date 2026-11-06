// Clover's own coding agent over ACP (`clover-code`, K-M3, the controller's option A): `Agent` delegates to it like to
// any ACP agent. It runs in the daemon on the embedded runtime (`serveAcpAgent` over `query()`), Clover's own ACP
// client talks to it through an in-memory pipe, its writes ask through `session/request_permission` and the approval
// level, its bridge is in-process, and the pause holds its tool calls, read-only ones too.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { CLOVER_CODE_ID, CloverCodeBackend, type CloverCodeDeps } from "../clover-code/backend";
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

function make(spawn: SpawnClaudeCodeProcess, o: WorldOptions & { pause?: WorldOptions["pause"]; base?: Partial<Options>; query?: CloverCodeDeps["query"] } = {}): World {
  let w!: World;
  w = new World({
    ...o,
    bridgeServerName: BRIDGE,
    extraBackends: (wire) => [new CloverCodeBackend({
      clock: { now: () => Date.now() } as never, wire, defaultModel: () => MODEL,
      baseOptions: (x) => ({ ...baseOptionsFor(w.cloverHome, spawn)(x), ...(o.base ?? {}) }),
      ...(o.pause ? { pause: o.pause } : {}),
      ...(o.query ? { query: o.query } : {}),
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
  test("the Clover home is out of its reach: a direct Read, a Read through a link from the root, and Bash cat of what it holds are denied", async () => {
    const w = make(spawn);
    const MARK = "MEMORY.md: the-bot-remembers-a-secret";
    const files = [
      join(w.cloverHome, "transcripts", "beta", "s_beta.jsonl"),
      join(w.cloverHome, "diffs", "s_beta", "1.diff"),
      join(w.cloverHome, "sdk", "file-history", "s_beta", "MEMORY.md"),
      join(w.cloverHome, "projects", "-home-project", "s_beta.jsonl"),
      join(w.cloverHome, "sessions", "bots", "s_beta.jsonl"),
      join(w.cloverHome, "bots", "beta", "agents", "agent_other", "acp.ndjson"),
    ];
    const links: string[] = [];
    for (const [i, f] of files.entries()) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, `{"text":"${MARK}"}\n`);
      const link = join(w.project, `link-${i}`);
      symlinkSync(f, link);
      links.push(link);
    }
    // A link to a folder in the home, for a search that would walk into it.
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
      backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Probe",
      prompt: calls.join("\n"), model: MODEL,
    });
    await waitFor(() => notification(w), "the task notification");
    const wire = readFileSync(join(w.cloverHome, r.transcript), "utf8");
    // Every probe ran and none read the home: the marker, and the home's file names, never came back.
    expect(wire.split("\n").filter((l) => l.includes('"tool_call_update"')).length).toBeGreaterThanOrEqual(files.length * 3 + 2);
    expect(wire).not.toContain("the-bot-remembers-a-secret");
    // Each search into the home, through a link or an absolute pattern, ended refused, its file names never listed.
    const updates = wire.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { msg?: { params?: { update?: Record<string, unknown> } } }).msg?.params?.update).filter((u): u is Record<string, unknown> => u !== undefined);
    const searches = updates.filter((u) => u["sessionUpdate"] === "tool_call" && /^(Grep|Glob)\b/.test(String(u["title"])));
    expect(searches.length).toBe(2);
    for (const call of searches) {
      const end = updates.find((u) => u["sessionUpdate"] === "tool_call_update" && u["toolCallId"] === call["toolCallId"]);
      // Refused by a deny rule (failed) or by the fence's real-path check (its reason as the result).
      expect(end?.["status"] === "failed" || JSON.stringify(end).includes("was not run")).toBe(true);
    }
    expect(JSON.stringify(notification(w))).not.toContain("the-bot-remembers-a-secret");
  });

  test("the base options' hooks are kept and the pause goes first; host messaging or a missing root refuses the start", async () => {
    let seen: Options | undefined;
    const fakeQuery = ((args: { prompt: AsyncIterable<string>; options: Options }) => {
      seen = args.options;
      async function* run() {
        yield { type: "system", subtype: "init", model: MODEL, permissionMode: "default" };
        for await (const _ of args.prompt) yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
    }) as unknown as CloverCodeDeps["query"];
    const own = async () => ({});
    const post = async () => ({});
    const gate = { mayAct: () => true };
    const w = make(spawn, { pause: gate, query: fakeQuery, base: { hooks: { PreToolUse: [{ hooks: [own] }], PostToolUse: [{ hooks: [post] }] } } });
    await w.manager.start({ caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" }, backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Hooks", prompt: "hi", model: MODEL });
    await waitFor(() => notification(w), "the task notification");
    // The pause, then the fence's real-path check, then the base's own.
    expect(seen!.hooks!.PreToolUse!.length).toBe(3);
    expect(seen!.hooks!.PreToolUse![0]!.failClosed).toBe(true);
    expect(seen!.hooks!.PreToolUse![1]!.failClosed).toBe(true);
    expect(seen!.hooks!.PreToolUse![2]!.hooks[0]).toBe(own);
    expect(seen!.hooks!.PostToolUse![0]!.hooks[0]).toBe(post);
    // The fence's file-tool denials reach the rules, the bots' folders and the transcript stores among them.
    expect(seen!.permissions!.deny).toEqual(expect.arrayContaining([`Read(/${w.cloverHome}/**)`, `Grep(/${w.cloverHome}/**)`, `Write(/${w.cloverHome}/**)`]));

    const w2 = make(spawn, { query: fakeQuery, base: { hostMessaging: {} as never } });
    await w2.manager.start({ caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" }, backend: CLOVER_CODE_ID, root: "home/Studio/project1", title: "Host", prompt: "hi", model: MODEL });
    expect(JSON.stringify(await waitFor(() => notification(w2), "the refusal"))).toContain("host messaging");

    const backend = new CloverCodeBackend({ clock: { now: () => 0 } as never, defaultModel: () => MODEL, baseOptions: baseOptionsFor(w.cloverHome, spawn), query: fakeQuery });
    const gone = join(w.project, "gone");
    mkdirSync(gone);
    rmSync(gone, { recursive: true });
    const err = await backend.start({ sessionId: "s", root: gone, bridge: { name: BRIDGE, command: "x", args: [], env: {}, tools: [] }, fence: w.fence.policy(), inProcessBridge: { type: "sdk", name: BRIDGE, instance: {} } }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain("isn't there");
    expect(existsSync(gone)).toBe(false);
  });
});
