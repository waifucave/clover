// An ACP backend (spec §5.3 `agentBackends` with `protocol: "acp"`, §9.3 "Local placement"): the spine's
// `AgentBackend` for an agent that runs as a local process speaking ACP over stdio.
//
// * `detect` never trusts a command name on PATH (S5 edit 1: `agent` is both Cursor's and Grok's). It resolves the
//   program to its real path, runs its version command with an allow-listed environment and a time limit, matches the
//   output against the quirks' pattern, and on macOS checks the code signature's team where the quirks name one.
// * `start` launches one contained process per delegation in the root folder (process/launch.ts), hands it the
//   bridge as its one stdio MCP server, and opens the ACP session (acp/session.ts).
// * Its own sandbox, and the user's OK for an agent with none, come in K-M2 (plan §4 K): `detect` reports
//   `sandboxed: false` until then, and Settings marks it.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Os } from "@waifucave/clover-protocol";
import type { AgentBackend, AgentDetection, AgentQuirks, AgentStartSpec, BridgeServer } from "../contracts/agent-backend";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { AcpAgentSession, type WireTap } from "./acp/session";
import type { StdioMcpServer } from "./acp/types";
import { buildAgentEnv, launchContained } from "./process/launch";
import type { ProcessTableReader } from "./process/table";

/** How a backend's program is run: `program` resolved on PATH, `prefixArgs` before both the version arguments and
 *  the ACP arguments (a script's path, when the program is an interpreter). */
export interface BackendCommand {
  program: string;
  prefixArgs?: readonly string[];
  acpArgs: readonly string[];
}

export interface AcpBackendOptions {
  id: string;
  pluginId: string;
  quirks: AgentQuirks;
  clock: Clock;
  /** Overrides the quirks' command (an `agentBackends` entry's `command` and `args`). */
  command?: BackendCommand;
  os?: Os;
  /** Where each session's wire goes, and its stderr: the transcript (transcript.ts). */
  wire?: (sessionId: string) => AgentWire;
  /** The environment the allow-list reads from; the daemon's own by default. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  clientInfo?: { name: string; version: string };
  table?: ProcessTableReader;
  versionTimeoutMs?: number;
  startTimeoutMs?: number;
}

/** One session's hooks into the daemon: its transcript (the wire and stderr), and `launched`, called with the agent's
 *  pid right after it starts and before `initialize`, so the bridge's token is bound before the bridge can connect. */
export interface AgentWire {
  tap?: WireTap;
  stderr?: (chunk: Uint8Array) => void;
  launched?: (pid: number) => void;
}

export function currentOs(): Os {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

export class AcpAgentBackend implements AgentBackend {
  readonly id: string;
  readonly pluginId: string;
  readonly quirks: AgentQuirks;
  readonly #opts: AcpBackendOptions;

  constructor(opts: AcpBackendOptions) {
    this.id = opts.id;
    this.pluginId = opts.pluginId;
    this.quirks = opts.quirks;
    this.#opts = opts;
  }

  /** The command for this OS: the override, or the quirks' own. */
  command(): BackendCommand | undefined {
    if (this.#opts.command) return this.#opts.command;
    const argv = this.quirks.launch.command[this.#opts.os ?? currentOs()];
    if (!argv || argv.length === 0) return undefined;
    return { program: argv[0]!, acpArgs: argv.slice(1) };
  }

  #env(): Record<string, string> {
    return buildAgentEnv(this.quirks.launch.envAllow, this.quirks.launch.envSet, this.#opts.baseEnv);
  }

  async detect(): Promise<AgentDetection> {
    const cmd = this.command();
    const none = { installed: false, identityOk: false, versionOk: false, sandboxed: false };
    if (!cmd) return { ...none, reason: `${this.id} has no command for this OS` };
    const env = this.#env();
    const path = resolveProgram(cmd.program, env["PATH"] ?? env["Path"]);
    if (!path) return { ...none, reason: `${cmd.program} isn't installed on this computer` };
    const id = this.quirks.launch.identity;
    const out = await runCapture(path, [...(cmd.prefixArgs ?? []), ...id.versionArgs], env, this.#opts.versionTimeoutMs ?? 10_000).catch(() => undefined);
    const m = out === undefined ? null : new RegExp(id.versionPattern, "m").exec(out.trim());
    const version = m ? (m[1] ?? m[0]).trim() : undefined;
    let identityOk = m !== null;
    let reason: string | undefined = identityOk ? undefined : `${path} doesn't answer ${id.versionArgs.join(" ")} as ${this.id} does`;
    if (identityOk && id.signer && (this.#opts.os ?? currentOs()) === "macos") {
      const team = await signingTeam(path);
      if (team !== id.signer) {
        identityOk = false;
        reason = `${path} isn't signed by ${this.id}'s publisher`;
      }
    }
    const versionOk = version !== undefined && versionSatisfies(version, this.quirks.launch.versions);
    return {
      installed: true, path, ...(version === undefined ? {} : { version }), identityOk, versionOk,
      sandboxed: false,
      reason: reason ?? (versionOk ? "its own sandbox is checked from K-M2" : `version ${version ?? "unknown"} is outside the tested range ${this.quirks.launch.versions}`),
    };
  }

  async start(spec: AgentStartSpec): Promise<AcpAgentSession> {
    const d = await this.detect();
    if (!d.installed || !d.path) throw new ContractError("not_installed", d.reason ?? `${this.id} isn't installed on this computer`);
    if (!d.identityOk) throw new ContractError("refused", d.reason ?? `${d.path} isn't ${this.id}'s program`);
    if (!this.quirks.mcp.transports.includes("stdio")) throw new ContractError("refused", `${this.id} takes no stdio MCP server, so the bridge can't reach it`);
    const cmd = this.command()!;
    const wire = this.#opts.wire?.(spec.sessionId) ?? {};
    const proc = launchContained({
      command: d.path,
      args: [...(cmd.prefixArgs ?? []), ...cmd.acpArgs],
      cwd: spec.root,
      env: this.#env(),
      ...(wire.stderr ? { onStderr: wire.stderr } : {}),
    }, this.#opts.table ? { table: this.#opts.table } : {});
    if (proc.pid) wire.launched?.(proc.pid);
    return AcpAgentSession.open({
      quirks: this.quirks,
      clock: this.#opts.clock,
      process: proc,
      cwd: spec.root,
      mcpServers: [stdioServerOf(spec.bridge)],
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(spec.reattach === undefined ? {} : { reattach: spec.reattach }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(wire.tap ? { tap: wire.tap } : {}),
      ...(this.#opts.clientInfo ? { clientInfo: this.#opts.clientInfo } : {}),
      ...(this.#opts.startTimeoutMs === undefined ? {} : { startTimeoutMs: this.#opts.startTimeoutMs }),
    });
  }
}

/** The bridge as `session/new` takes it: its token only in `env` (S5 edit 4). */
export function stdioServerOf(b: BridgeServer): StdioMcpServer {
  return { name: b.name, command: b.command, args: [...b.args], env: Object.entries(b.env).map(([name, value]) => ({ name, value })) };
}

/** A program's real path: as given when it has a separator, else the first match on PATH. */
export function resolveProgram(program: string, pathVar: string | undefined): string | undefined {
  const found = /[\\/]/.test(program) ? program : Bun.which(program, { PATH: pathVar ?? "" });
  if (!found) return undefined;
  try {
    return realpathSync(found);
  } catch {
    return undefined;
  }
}

function runCapture(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (out.length < 64 * 1024) out += c;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** macOS: the code signature's TeamIdentifier, or undefined when unsigned. */
async function signingTeam(path: string): Promise<string | undefined> {
  const out = await new Promise<string>((resolve) => {
    const c = spawn("/usr/bin/codesign", ["-dv", "--verbose=2", path], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (x: string) => (err += x));
    c.on("close", () => resolve(err));
    c.on("error", () => resolve(""));
  });
  return /^TeamIdentifier=(\S+)$/m.exec(out)?.[1];
}

/** Dotted numeric versions: `2026.10.22-27dcf5f` reads as 2026.10.22. */
function parts(v: string): number[] {
  return (/^\d+(?:\.\d+)*/.exec(v.trim())?.[0] ?? "").split(".").filter((x) => x !== "").map(Number);
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A range of space-separated comparisons (`>=1.4.12 <1.5.0`). */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parts(version);
  if (v.length === 0) return false;
  for (const term of range.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    if (!m) return false;
    const c = cmp(v, parts(m[2]!));
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}
