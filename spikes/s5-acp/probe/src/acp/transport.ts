// Starts an ACP agent as a child process and gives back an ACP stream whose every JSON-RPC
// message is written, scrubbed, to `acp.ndjson` in the run folder ("out" = to the agent).
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { RunLog } from "../util/log.ts";
import { sleep } from "../util/time.ts";

export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnedAgent {
  child: ChildProcess;
  stream: acp.Stream;
  /** The last raw (unparsed) response to `method`, as it came off the wire. */
  rawResponse(method: string): { result?: any; error?: any } | undefined;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM to the agent's whole process group, SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; forced: boolean }>;
}

export function spawnAgent(launch: AgentLaunch, log: RunLog): SpawnedAgent {
  // detached: the agent leads its own process group, so stop() also reaches the MCP
  // servers and shells it starts, and it has no controlling terminal to prompt on.
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  log.event("agent.spawned", { command: launch.command, args: launch.args, cwd: launch.cwd, pid: child.pid });

  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (s: string) => log.text("agent.stderr.log", s));

  let exitResolve!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (exitResolve = r));
  child.on("exit", (code, signal) => {
    log.event("agent.exited", { code, signal });
    exitResolve({ code, signal });
  });
  child.on("error", (err) => log.event("agent.spawn-error", { error: String(err) }));

  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const base = acp.ndJsonStream(output, input);

  const sentMethod = new Map<unknown, string>();
  const lastByMethod = new Map<string, { result?: any; error?: any }>();
  const tapIn = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(msg, ctl) {
      log.write("acp.ndjson", { dir: "in", msg });
      const m = msg as any;
      if (m.method === undefined && m.id !== undefined && sentMethod.has(m.id)) {
        lastByMethod.set(sentMethod.get(m.id)!, { result: m.result, error: m.error });
      }
      ctl.enqueue(msg);
    },
  });
  const tapOut = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(msg, ctl) {
      log.write("acp.ndjson", { dir: "out", msg });
      const m = msg as any;
      if (m.method !== undefined && m.id !== undefined) sentMethod.set(m.id, m.method);
      ctl.enqueue(msg);
    },
  });
  base.readable.pipeTo(tapIn.writable).catch(() => {});
  tapOut.readable.pipeTo(base.writable).catch(() => {});

  let exitedFlag = false;
  exited.then(() => (exitedFlag = true));

  async function stop(graceMs = 5000) {
    const pid = child.pid;
    if (!pid || exitedFlag) return { ...(await exited), forced: false };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    const result = await Promise.race([exited.then((r) => ({ ...r, forced: false })), sleep(graceMs).then(() => null)]);
    if (result) {
      // The group may still hold children (MCP servers, shells) after the leader left.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      return result;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    return { ...(await exited), forced: true };
  }

  return {
    child,
    stream: { readable: tapIn.readable, writable: tapOut.writable },
    rawResponse: (method) => lastByMethod.get(method),
    exited,
    stop,
  };
}
