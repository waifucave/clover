// A bot's children on Clover's own backends (the in-process `clover` and Clover's coding agent), on the real runtime,
// judged by the real broker (the review on 5c89129a1; a regression row for the hole int/next had at f931fe76e, where
// the in-process backend handed the runtime's tool names as the tool kind, so a child's Bash and Write went as "other":
// the reviewer then a card at the default level, and allowed by the level with no card at automatic).
//   * its command is a command: a card every time (no grant here), at the default level and at automatic;
//   * its Writes are edits, and a run-later place is refused before any card;
//   * every built-in tool the runtime offers a child is classified (an unknown one would card every time);
//   * its Read, Grep and Glob of a secret place, the Clover home's denied paths and the checkpoint store return none of
//     their content.
import { afterEach, expect, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import { query as sdkQuery, type Options, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { CloverApprovalBroker } from "../../approvals/broker";
import { pathsClassOnDisk } from "../../approvals/ordinary-paths";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import { IN_PROCESS_BACKEND_ID, IN_PROCESS_TOOL_KINDS, inProcessAgentBackend } from "../../runtime-sdk/turn-loop/subagent-backend";
import { buildCoreBrand } from "../../runtime-sdk/brand";
import { testProviderNameFor } from "../../runtime-sdk/provider-selection";
import { describeWithEmbeddedRuntime } from "../../../test/helpers/embedded-runtime";
import { darwinTest } from "../../../test/helpers/darwin-only";
import { inProcessBackend } from "../index";
import { botChildFor } from "../bot-child";
import { CLOVER_CODE_ID, CloverCodeBackend } from "../clover-code/backend";
import { waitFor, World } from "./world";

setDefaultTimeout(90_000);

let world: World | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const MODEL = "winter-test/calls";

function baseOptionsFor(home: string, spawn: SpawnClaudeCodeProcess) {
  return (o: { model: string; effort?: string; cwd: string }): Options => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CLOVER_HOME: home };
    const provider = testProviderNameFor(o.model);
    if (provider !== undefined) env["WINTER_TEST_PROVIDER"] = provider;
    return { brand: buildCoreBrand(undefined, home), model: o.model, cwd: o.cwd, env, spawnClaudeCodeProcess: spawn, settingSources: [] };
  };
}

type Seen = { tool: string; effect: string; cardAlways: boolean; carded: boolean; allowed: boolean; by: string };

/** A World with both of Clover's backends and the real broker; every card is answered no. */
function worldWith(spawn: SpawnClaudeCodeProcess, level: Level) {
  const w = new World({
    level,
    extraBackends: (wire, self) => [
      inProcessBackend({ home: self.cloverHome, spawn, defaultModel: () => MODEL }, { home: self.cloverHome, userHome: self.userHome, sandboxReady: () => true }),
      new CloverCodeBackend({
        clock: { now: () => Date.now() } as never, wire, defaultModel: () => MODEL, sandboxReady: () => true, baseOptions: baseOptionsFor(self.cloverHome, spawn), pause: { mayAct: () => true },
        botChild: botChildFor({ cloverHome: self.cloverHome, userHome: self.userHome }),
      }),
    ],
  });
  world = w;
  const broker = new CloverApprovalBroker({
    clock: w.clock, levels: () => level, localComputer: "Studio",
    reviewer: async () => "unavailable" as never,
    pathClass: (paths) => pathsClassOnDisk(paths, { home: w.userHome, os: process.platform === "darwin" ? "macos" : "linux", cloverHome: w.cloverHome }),
  });
  const seen: Seen[] = [];
  (w.approvals as { request: (r: ApprovalRequest, o?: { signal?: AbortSignal }) => Promise<unknown> }).request = async (r, o) => {
    let carded = false;
    const off = broker.watch((e) => {
      if (e.type !== "requested") return;
      carded = true;
      off();
      void broker.answer(e.card.id, { optionId: "deny", hash: e.card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" });
    });
    const d = await broker.request(r as never, o ?? {});
    off();
    if (r.kind === "agent-permission") {
      const title = (r as { agent?: { title?: string } }).agent?.title ?? "?";
      seen.push({ tool: title, effect: r.effect, cardAlways: (r as { cardAlways?: boolean }).cardAlways === true, carded, allowed: d.allowed, by: d.by });
    }
    return d;
  };
  return { w, seen };
}

const start = (w: World, backend: string, level: Level, prompt: string) => w.manager.start({
  caller: { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user", level } as never,
  backend, root: "home/Studio/project1", title: "Probe", model: MODEL, prompt,
});

describeWithEmbeddedRuntime("a bot's children on Clover's own backends, judged by the real broker", (spawn) => {
  for (const backend of [IN_PROCESS_BACKEND_ID, CLOVER_CODE_ID]) for (const level of ["ask-risky", "automatic"] as const) {
    darwinTest(`${backend} at ${level}: its command cards every time; its Writes are edits; a run-later place is refused before any card`, async () => {
      const { w, seen } = worldWith(spawn, level);
      const cmd = join(w.project, "cmd.txt");
      const notes = join(w.project, "notes.txt");
      const hook = join(w.project, ".husky", "pre-commit");
      mkdirSync(join(w.project, ".husky"), { recursive: true });
      await start(w, backend, level, [
        `CALL Bash ${JSON.stringify({ command: `printf x > ${JSON.stringify(cmd)}`, description: "write" })}`,
        `+CALL Write ${JSON.stringify({ file_path: notes, content: "x" })}`,
        `+CALL Write ${JSON.stringify({ file_path: hook, content: "echo pwned" })}`,
      ].join("\n"));
      await waitFor(() => w.parentInputs("task-notification")[0], "the task notification");
      const command = seen.filter((s) => s.effect === "execute");
      expect(command.map((s) => [s.cardAlways, s.carded, s.allowed])).toEqual([[true, true, false]]);
      expect(existsSync(cmd)).toBe(false);
      // Every other request is an edit (none "other"), and none names the run-later place.
      expect(seen.filter((s) => s.effect !== "execute").map((s) => s.effect)).toEqual(["edit"]);
      expect(seen.some((s) => s.tool.includes(".husky"))).toBe(false);
      expect(existsSync(hook)).toBe(false);
      // An ordinary file in its folder: at the default level an agent's edit asks (answered no here), at automatic it runs.
      expect(existsSync(notes)).toBe(level === "automatic");
    });
  }

  darwinTest("every built-in tool the runtime offers a bot's in-process child is classified", async () => {
    const { w } = worldWith(spawn, "ask-risky");
    const tools: string[] = [];
    const backend = inProcessAgentBackend({
      home: w.cloverHome, spawn, defaultModel: () => MODEL, pauseGateFor: () => ({ mayAct: () => true }), sandboxReady: () => true,
      botChild: botChildFor({ cloverHome: w.cloverHome, userHome: w.userHome }),
      query: (args) => {
        const q = sdkQuery(args);
        const it = q[Symbol.asyncIterator].bind(q);
        return Object.assign(q, {
          [Symbol.asyncIterator]: () => {
            const inner = it();
            return { ...inner, next: async () => {
              const r = await inner.next();
              const m = r.value as { type?: string; subtype?: string; tools?: string[] } | undefined;
              if (m?.type === "system" && m.subtype === "init" && Array.isArray(m.tools)) tools.push(...m.tools);
              return r;
            } };
          },
        });
      },
    });
    const session = await backend.start({
      sessionId: "s_tools", bot: "alpha", root: w.project, model: MODEL,
      bridge: { name: "clover_bridge", command: "/bin/sh", args: ["-c", "exit 0"], env: {}, tools: [] },
      fence: { allowWrite: [join(w.root, "tmp")], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" },
    } as never);
    mkdirSync(join(w.root, "tmp"), { recursive: true });
    try {
      await session.prompt({ text: "hello" });
    } finally {
      await session.stop();
    }
    if (process.env.SHOW_CHILD_TOOLS) console.error("CHILD_TOOLS", JSON.stringify(tools));
    expect(tools.length).toBeGreaterThan(0);
    const unclassified = tools.filter((t) => !t.startsWith("mcp__") && !IN_PROCESS_TOOL_KINDS.has(t));
    expect(unclassified).toEqual([]);
  });

  darwinTest("its Read, Grep and Glob of the secret places, the Clover home and the checkpoint store return none of their content", async () => {
    const { w } = worldWith(spawn, "automatic");
    const MARK = "the-child-must-never-see-this";
    const secrets = [
      join(w.userHome, ".aws", "credentials"),
      join(w.userHome, ".ssh", "id_ed25519"),
      join(w.cloverHome, "bots", "beta", "memory", "MEMORY.md"),
      join(w.cloverHome, "sdk", "file-history", "s_other", "notes.md"),
    ];
    for (const f of secrets) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, `${MARK}\n`);
    }
    const calls = secrets.flatMap((f, i) => [
      `${i === 0 ? "" : "+"}CALL Read ${JSON.stringify({ file_path: f })}`,
      `+CALL Grep ${JSON.stringify({ pattern: "must-never", path: join(f, ".."), output_mode: "content" })}`,
    ]);
    calls.push(`+CALL Glob ${JSON.stringify({ pattern: `${w.userHome}/.aws/*` })}`);
    const r = await start(w, IN_PROCESS_BACKEND_ID, "automatic", calls.join("\n"));
    await waitFor(() => w.parentInputs("task-notification")[0], "the task notification");
    const history = w.host.history(r.sessionId);
    expect(JSON.stringify(history)).not.toContain(MARK);
    const events = history.flatMap((x) => (x.type === "driver" ? [(x as unknown as { event: Record<string, unknown> }).event] : []));
    const agentSessionId = events.find((e) => e["type"] === "agent_started")?.["agentSessionId"] as string;
    const record = [...new Bun.Glob(`**/${agentSessionId}.jsonl`).scanSync({ cwd: w.cloverHome, absolute: true })];
    expect(record.length).toBe(1);
    const results = readFileSync(record[0]!, "utf8");
    expect(results.match(/"type":"tool_result"/g)?.length).toBe(calls.length);
    expect(results).not.toContain(MARK);
  });
});
