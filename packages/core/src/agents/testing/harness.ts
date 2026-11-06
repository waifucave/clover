// The harness that runs lane B's AgentBackend conformance suite (contracts/conformance/agent-backend.ts) against lane
// K's real client: an `AcpAgentBackend` launching the scripted ACP agent (fake-acp-agent.ts) as a real process.
//
// The suite drives the world through the fake's drivers (`sessions[i].answers`, `.config`, `.proceed()`,
// `userSelection`). Here they read what the agent process itself reported, so a check passes only if the answer
// really crossed the wire. Two drivers need care with a real process:
// * `cancel()` first waits until the agent says it is blocked (on a permission request, a `wait` step or a running
//   command), so the cancel meets the state the suite set up, as it does with the in-memory fake;
// * `proceed()` waits for the same, then signals the agent (SIGUSR2).
// The launch row is the harness's own: the agent is `bun fake-acp-agent.ts <config>`, its version line `fake-agent
// 1.0.0`, or an impostor's when the suite asks for one.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPermissionAnswer, AgentQuirks, AgentSession, AgentStartSpec } from "../../contracts/agent-backend";
import type { AgentBackendFactory, AgentBackendHarness } from "../../contracts/conformance/agent-backend";
import type { FakeAgentBackendOptions } from "../../contracts/fakes/agent-backend";
import { AcpAgentBackend, type AgentWire } from "../backend";
import type { AcpAgentSession } from "../acp/session";
import type { FakeAcpConfig, FakeAcpStep } from "./fake-acp-agent";

export const FAKE_AGENT_PATH = join(import.meta.dir, "fake-acp-agent.ts");

/** The launch row every harness backend uses. */
export function fakeLaunch(quirks: AgentQuirks): AgentQuirks {
  return {
    ...quirks,
    launch: { ...quirks.launch, identity: { versionArgs: ["--version"], versionPattern: "^fake-agent (\\d+\\.\\d+\\.\\d+)$" }, versions: ">=1.0.0" },
  };
}

interface Report {
  type: string;
  [key: string]: unknown;
}

export function readReport(file: string): Report[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Report);
}

/** Waits until the agent has reported `n` blocks in all. */
async function waitBlocked(file: string, n: number, timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (readReport(file).filter((r) => r.type === "blocked").length >= n) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

export interface FakeAgentRun {
  dir: string;
  config: string;
  report: string;
  selection: string;
}

/** Writes one fake agent's config into `dir`. */
export function writeFakeAgent(dir: string, c: Omit<FakeAcpConfig, "report" | "selection">): FakeAgentRun {
  mkdirSync(dir, { recursive: true });
  const run = { dir, config: join(dir, "agent.json"), report: join(dir, "report.ndjson"), selection: join(dir, "selection.json") };
  writeFileSync(run.config, JSON.stringify({ ...c, report: run.report, selection: run.selection }));
  return run;
}

export interface HarnessExtra {
  /** Overrides the wire tap per session (the transcript tests). */
  wire?: (sessionId: string) => AgentWire;
}

let harnessSeq = 0;

/** A factory for the conformance suite: each backend gets its own folder under `root`. */
export function acpConformanceFactory(root: string, extra: HarnessExtra = {}): AgentBackendFactory {
  return (opts: FakeAgentBackendOptions) => acpHarness(join(root, `backend-${++harnessSeq}`), opts, extra) as unknown as AgentBackendHarness;
}

export function acpHarness(dir: string, opts: FakeAgentBackendOptions & { script?: FakeAcpStep[][] }, extra: HarnessExtra = {}) {
  const quirks = fakeLaunch(opts.quirks ?? (undefined as unknown as AgentQuirks));
  const impostor = opts.detection?.identityOk === false;
  const run = writeFakeAgent(dir, {
    quirks,
    script: (opts.script ?? []) as FakeAcpStep[][],
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.signedIn === undefined ? {} : { signedIn: opts.signedIn }),
    version: impostor ? "agent 9.9.9 (not the vendor's)" : "fake-agent 1.0.0",
  });
  const workRoot = join(dir, "work");
  mkdirSync(workRoot, { recursive: true });
  const real = new AcpAgentBackend({
    id: opts.id,
    pluginId: opts.pluginId ?? `agent-${opts.id}`,
    quirks,
    clock: opts.clock,
    command: { program: process.execPath, prefixArgs: [FAKE_AGENT_PATH, run.config], acpArgs: ["acp"] },
    ...(extra.wire ? { wire: extra.wire } : {}),
  });
  const sessions: ReturnType<typeof driverOf>[] = [];
  let blocksSeen = 0;

  const driverOf = (s: AcpAgentSession, spec: AgentStartSpec) => ({
    agentSessionId: s.agentSessionId,
    spec,
    reattachedWith: s.reattachedWith,
    droppedReplay: s.droppedReplay,
    get answers(): { toolCallId: string; answer: AgentPermissionAnswer; kind?: string }[] {
      return readReport(run.report).filter((r) => r.type === "answer").map((r) => ({
        toolCallId: String(r["toolCallId"]),
        answer: r["answer"] as AgentPermissionAnswer,
        ...(r["kind"] === undefined ? {} : { kind: String(r["kind"]) }),
      }));
    },
    get config(): { model?: string; effort?: string } {
      const out: { model?: string; effort?: string } = {};
      for (const r of readReport(run.report)) if (r.type === "config") out[r["option"] as "model" | "effort"] = String(r["value"]);
      return out;
    },
    proceed(): void {
      const want = ++blocksSeen;
      void waitBlocked(run.report, want).then(() => {
        const pid = Number(readReport(run.report).find((r) => r.type === "started")?.["pid"] ?? 0);
        if (pid) process.kill(pid, "SIGUSR2");
      });
    },
    session: s,
  });

  return {
    id: real.id,
    pluginId: real.pluginId,
    quirks: real.quirks,
    sessions,
    run,
    get userSelection(): { model?: string } {
      try {
        return JSON.parse(readFileSync(run.selection, "utf8")) as { model?: string };
      } catch {
        return {};
      }
    },
    detect: () => real.detect(),
    async start(spec: AgentStartSpec): Promise<AgentSession> {
      // The suite's roots are illustrative; the process runs in a real folder.
      const s = await real.start({ ...spec, root: realpathSync(workRoot) });
      sessions.push(driverOf(s, spec));
      // `cancel` meets the state the suite set up: the agent is blocked on a request, a wait or a command.
      const wrapped: AgentSession = {
        get agentSessionId() {
          return s.agentSessionId;
        },
        state: () => s.state(),
        prompt: (input) => s.prompt(input),
        cancel: async () => {
          if (s.state() === "prompting") {
            await waitBlocked(run.report, blocksSeen + 1);
            blocksSeen = readReport(run.report).filter((r) => r.type === "blocked").length;
          }
          return s.cancel();
        },
        setConfig: (o, v) => s.setConfig(o, v),
        stop: () => s.stop(),
        onPermission: (fn) => s.onPermission(fn),
        onEvent: (fn) => s.onEvent(fn),
        lastProgressAt: () => s.lastProgressAt(),
      };
      return wrapped;
    },
  };
}
