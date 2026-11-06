// An ACP backend (spec §5.3 `agentBackends` with `protocol: "acp"`, §9.3 "Local placement"): the spine's
// `AgentBackend` for an agent that runs as a local process speaking ACP over stdio.
//
// * `detect` never trusts a command name on PATH (S5 edit 1: `agent` is both Cursor's and Grok's). It resolves the
//   program to its real path, runs its version command with an allow-listed environment and a time limit, matches the
//   output against the quirks' pattern, and on macOS verifies the code signature (`codesign --verify --strict`) with
//   a requirement naming the publisher's team, where the quirks name one.
// * `start` launches one contained process per delegation in the root folder (process/launch.ts), hands it the
//   bridge as its one stdio MCP server, and opens the ACP session (acp/session.ts). At read-only, an agent that acts
//   without asking starts in its read-only mode (`readOnlyMode`), or `start` refuses it; the manager switches a
//   running one at its next turn.
// * Its own sandbox (sandbox/admission.ts): `detect` reports `sandboxed: true` only where the backend's sandbox is
//   admitted for this OS and version, and `start` then writes the fenced set in the backend's own format into the
//   session's setup folder. Every other agent, and one outside its tested versions, starts only after the user's OK
//   (sandbox/oks.ts, asked by the manager).
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Os } from "@waifucave/clover-protocol";
import type { AgentBackend, AgentDetection, AgentQuirks, AgentStartSpec, BridgeServer } from "../contracts/agent-backend";
import type { Clock } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserSelections } from "./acp/selections";
import { AcpAgentSession, type WireTap } from "./acp/session";
import { ADMISSIONS, admissionFor, type SandboxAdmission } from "./sandbox/admission";
import type { PluginParts } from "./placement";
import type { StdioMcpServer } from "./acp/types";
import { AgentJob } from "../platform/win-job";
import { buildAgentEnv, launchContained, type AgentJobLike } from "./process/launch";
import { versionSatisfies } from "./version";

export { versionSatisfies } from "./version";
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
  /** Which sandboxes hold the fence (S8); the built-in table by default. */
  admissions?: Parameters<typeof admissionFor>[0];
  /** Where a session's sandbox files go: a folder inside the fenced run folder (`<home>/run/agents/<session>`). */
  setupDir?: (sessionId: string) => string;
  /** Places plugins' skills, agent definitions and hooks where this backend reads its own (Claude Code), returning the
   *  `_meta` that points the agent at them. */
  place?: (parts: PluginParts, ctx: { dir: string }) => { meta: Record<string, unknown> };
  /** The record of the user's own selections where the agent saves a session's choice as theirs (review 10); one per
   *  backend instance in memory by default. */
  selections?: UserSelections;
  /** Makes the Windows job object for one agent; lane C's `AgentJob.create` by default. */
  makeJob?: () => AgentJobLike | null;
  /** The agent's read-only mode, for an agent that acts without asking (`READ_ONLY_MODES`). */
  readOnlyMode?: { option: string; values: readonly string[] };
}

/** `AgentStartSpec`, plus what lane K's own backends read. */
export interface AcpStartSpec extends AgentStartSpec {
  /** The session runs at read-only: an agent that acts without asking must start in its read-only mode. */
  readOnly?: boolean;
}

/** One session's hooks into the daemon: its transcript (the wire and stderr), and `launched`, called with the agent's
 *  pid right after it starts and before `initialize`, so the bridge's token is bound before the bridge can connect. */
export interface AgentWire {
  tap?: WireTap;
  stderr?: (chunk: Uint8Array) => void;
  /** `contains`: on Windows, the agent's job, which the bridge's caller check reads instead of the process tree. */
  launched?: (pid: number, contains?: (pid: number) => boolean) => void;
  /** The agent's process exited, for whatever reason. */
  exited?: () => void;
  /** Where its sandbox files go: inside the fenced run folder, so no bot or agent can rewrite them. */
  setupDir?: string;
  /** The plugins' skills, agent definitions and hooks in this session's scope. */
  parts?: PluginParts;
}

export function currentOs(): Os {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

export class AcpAgentBackend implements AgentBackend {
  readonly id: string;
  readonly pluginId: string;
  readonly quirks: AgentQuirks;
  readonly #opts: AcpBackendOptions;
  readonly #selections: UserSelections;

  constructor(opts: AcpBackendOptions) {
    this.id = opts.id;
    this.pluginId = opts.pluginId;
    this.quirks = opts.quirks;
    this.#opts = opts;
    this.#selections = opts.selections ?? new UserSelections();
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
      if (!(await signedByTeam(path, id.signer))) {
        identityOk = false;
        reason = `${path} isn't signed by ${this.id}'s publisher, or its signature doesn't verify`;
      }
    }
    const versionOk = version !== undefined && versionSatisfies(version, this.quirks.launch.versions);
    const sandbox = this.admission(version);
    return {
      installed: true, path, ...(version === undefined ? {} : { version }), identityOk, versionOk,
      sandboxed: sandbox.status === "protected",
      reason: reason ?? (!versionOk ? `version ${version ?? "unknown"} is outside the tested range ${this.quirks.launch.versions}` : sandbox.status === "protected" ? sandbox.evidence : `no sandbox: ${sandbox.reason}`),
    };
  }

  /** This backend's sandbox on this OS at this version (S8). */
  admission(version: string | undefined): SandboxAdmission {
    return admissionFor(this.#opts.admissions ?? ADMISSIONS, this.id, this.#opts.os ?? currentOs(), version);
  }

  async start(spec: AcpStartSpec): Promise<AcpAgentSession> {
    const d = await this.detect();
    if (!d.installed || !d.path) throw new ContractError("not_installed", d.reason ?? `${this.id} isn't installed on this computer`);
    if (!d.identityOk) throw new ContractError("refused", d.reason ?? `${d.path} isn't ${this.id}'s program`);
    if (!this.quirks.mcp.transports.includes("stdio")) throw new ContractError("refused", `${this.id} takes no stdio MCP server, so the bridge can't reach it`);
    const readOnly = spec.readOnly === true && this.quirks.marks.includes("unasked-actions");
    if (readOnly && !this.#opts.readOnlyMode) throw new ContractError("refused", `${this.id} acts without asking and has no read-only mode, so it can't start at read-only`);
    const cmd = this.command()!;
    const wire = this.#opts.wire?.(spec.sessionId) ?? {};
    // The fenced set, in the backend's own format, where its sandbox is admitted.
    const sandbox = this.admission(d.version);
    let setup: ReturnType<Extract<SandboxAdmission, { status: "protected" }>["writer"]> = {};
    if (sandbox.status === "protected") {
      const dir = wire.setupDir ?? this.#opts.setupDir?.(spec.sessionId);
      if (!dir) throw new ContractError("refused", `${this.id}'s sandbox needs a setup folder`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      setup = sandbox.writer(spec.fence, { root: spec.root, dir });
      for (const f of setup.files ?? []) writeFileSync(join(dir, f.name), f.content, { mode: 0o600 });
    }
    // The plugins' skills, agents and hooks, where this backend reads its own.
    const parts = wire.parts;
    let placedMeta: Record<string, unknown> | undefined;
    if (this.#opts.place && parts && (parts.skills.length + parts.agents.length + parts.hooks.length) > 0) {
      const dir = wire.setupDir ?? this.#opts.setupDir?.(spec.sessionId);
      if (dir) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        placedMeta = this.#opts.place(parts, { dir }).meta;
      }
    }
    const meta = setup.meta || placedMeta ? mergeObjects(setup.meta ?? {}, placedMeta ?? {}) : undefined;
    // Windows: every agent runs in its own job object (lane C's), or not at all.
    let job: AgentJobLike | undefined;
    if ((this.#opts.os ?? currentOs()) === "windows") {
      job = (this.#opts.makeJob ?? (() => AgentJob.create()))() ?? undefined;
      if (!job) throw new ContractError("refused", `${this.id} wasn't started: Windows wouldn't make a job object to hold it`);
    }
    const proc = launchContained({
      command: d.path,
      args: [...(cmd.prefixArgs ?? []), ...cmd.acpArgs, ...(setup.args ?? [])],
      cwd: spec.root,
      env: { ...this.#env(), ...(setup.env ?? {}) },
      ...(wire.stderr ? { onStderr: wire.stderr } : {}),
    }, { ...(this.#opts.table ? { table: this.#opts.table } : {}), ...(job ? { job } : {}) });
    if (!proc.contained) throw new ContractError("refused", `${this.id} wasn't started: it couldn't be put in its job object`);
    if (proc.pid) wire.launched?.(proc.pid, proc.contains);
    void proc.exited.then(() => wire.exited?.());
    return AcpAgentSession.open({
      quirks: this.quirks,
      clock: this.#opts.clock,
      process: proc,
      cwd: spec.root,
      mcpServers: [stdioServerOf(spec.bridge)],
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(meta ? { meta } : {}),
      ...(spec.reattach === undefined ? {} : { reattach: spec.reattach }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(wire.tap ? { tap: wire.tap } : {}),
      ...(this.#opts.clientInfo ? { clientInfo: this.#opts.clientInfo } : {}),
      selections: { keeper: this.#selections, backend: this.id },
      ...(this.#opts.readOnlyMode ? { readOnlyMode: this.#opts.readOnlyMode } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(this.#opts.startTimeoutMs === undefined ? {} : { startTimeoutMs: this.#opts.startTimeoutMs }),
    });
  }
}

function mergeObjects(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = v && cur && typeof v === "object" && typeof cur === "object" && !Array.isArray(v) && !Array.isArray(cur) ? mergeObjects(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
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

/** macOS: whether the signature verifies (`--strict`) and its leaf certificate is the team's, an Apple-issued one. */
async function signedByTeam(path: string, team: string): Promise<boolean> {
  if (!/^[A-Z0-9]{10}$/.test(team)) return false;
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  return new Promise<boolean>((resolve) => {
    const c = spawn("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, path], { stdio: "ignore", windowsHide: true });
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}
