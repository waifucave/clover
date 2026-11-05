// The client half of ACP that an agent may call back into: `fs/*` and `terminal/*`, both
// confined to the session's root folder. Clover's real client would run these through the
// folder tree and the fence; here they only need to work and leave a record.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk/unstable";

// realpath for a path that may not exist yet (a file about to be written).
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), basename(p));
  }
}

/** Resolves `path` and refuses anything outside `root` (symlinks such as /tmp → /private/tmp included). */
export function confine(root: string, path: string): string {
  if (!isAbsolute(path)) throw acp.RequestError.invalidParams({ path }, "path must be absolute");
  const target = realish(resolve(path));
  const rel = relative(realpathSync(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw acp.RequestError.invalidParams({ path }, "outside the session root");
  return target;
}

export async function readTextFile(root: string, p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
  const file = confine(root, p.path);
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    throw acp.RequestError.resourceNotFound(p.path);
  }
  if (p.line != null || p.limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (p.line ?? 1) - 1);
    content = lines.slice(start, p.limit != null ? start + p.limit : undefined).join("\n");
  }
  return { content };
}

export async function writeTextFile(root: string, p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
  const file = confine(root, p.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, p.content, "utf8");
  return {};
}

interface Term {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit?: { exitCode: number | null; signal: string | null };
  exited: Promise<void>;
}

export class Terminals {
  private terms = new Map<string, Term>();
  private next = 1;
  constructor(
    private root: string,
    private baseEnv: Record<string, string>,
  ) {}

  create(p: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
    const cwd = p.cwd ? confine(this.root, p.cwd) : this.root;
    const env = { ...this.baseEnv, ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])) };
    // Agents differ: some send argv, some one shell string. A bare string runs under sh -c.
    const useShell = !(p.args && p.args.length) && /\s/.test(p.command);
    const child = useShell
      ? spawn("/bin/sh", ["-c", p.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(p.command, p.args ?? [], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const id = `term-${this.next++}`;
    let resolveExit!: () => void;
    const term: Term = {
      child,
      output: "",
      truncated: false,
      limit: p.outputByteLimit ?? 1_000_000,
      exited: new Promise<void>((r) => (resolveExit = r)),
    };
    const onData = (b: Buffer) => {
      term.output += b.toString("utf8");
      // ACP: past the limit, drop from the start, on a character boundary.
      while (Buffer.byteLength(term.output) > term.limit) {
        term.output = term.output.slice(Math.max(1, term.output.length - term.limit));
        term.truncated = true;
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code, signal) => {
      term.exit = { exitCode: code, signal };
      resolveExit();
    });
    child.on("error", (err) => {
      term.output += `\n[spawn error: ${err.message}]`;
      term.exit = { exitCode: 127, signal: null };
      resolveExit();
    });
    this.terms.set(id, term);
    return { terminalId: id };
  }

  private get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw acp.RequestError.resourceNotFound(id);
    return t;
  }

  output(p: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const t = this.get(p.terminalId);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit ?? null };
  }

  async waitForExit(p: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const t = this.get(p.terminalId);
    await t.exited;
    return { ...t.exit! };
  }

  kill(p: acp.KillTerminalRequest): acp.KillTerminalResponse {
    const t = this.get(p.terminalId);
    if (!t.exit && t.child.pid) {
      try {
        process.kill(-t.child.pid, "SIGKILL");
      } catch {}
    }
    return {};
  }

  release(p: acp.ReleaseTerminalRequest): acp.ReleaseTerminalResponse {
    this.kill(p);
    this.terms.delete(p.terminalId);
    return {};
  }

  killAll() {
    for (const id of [...this.terms.keys()]) this.release({ sessionId: "", terminalId: id });
  }
}
