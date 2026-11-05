// The core's tool layer for the folder tree (spec §9.1 [D]: `Read`, `Write`, `Edit`, `Glob` and `Grep` work on any
// path in the tree, each run on the computer that holds the files; `Bash` runs on the computer that holds its working
// folder; the owner's item 89: builds and git run where the files are). The runtime (lane A) hands a tool call whose
// path is a tree path (`home/<Computer>/…`, `bots/<bot>/…`) to `TreeTools.run`; this computer's own paths outside the
// tree stay with the runtime's own tools.
//
// * File tools go through the Tree, as the session: the holder fences them, and a peer's change is judged there.
// * Bash goes to the holder of its folder: here, to this computer's executor; elsewhere, as `tool.run` over the link,
//   with its output streaming back as `tool_output`. A leading `cd <folder> &&` picks the folder (`cd home/Desktop1/
//   project1 && git status` runs git on Desktop1).
// * A computer that is off answers `computer_offline` at once.
import type { Caller, Level, SessionKind, SignedCardAnswer } from "@waifucave/clover-protocol";
import { strictestLevel } from "../contracts/approval-broker";
import { ContractError, isContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import { splitTreePath, type TreeData } from "../contracts/tree";
import type { LocalHolder } from "./holder";
import { offlineAs } from "./remote";
import type { ToolExecutor } from "./service";
import type { CoreTree, TreeDirectory } from "./tree";

/** The tools this layer runs on tree paths. */
export const TREE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "LS", "Bash"] as const;
export type TreeToolName = (typeof TREE_TOOLS)[number];

/** Whom a call is for and how it reaches the holder. */
export interface TreeToolContext {
  session: string;
  sessionKind: SessionKind;
  bot?: string;
  callId: string;
  /** The session's working folder, a tree path, for relative paths and Bash. */
  cwd?: string;
  /** The level the calling computer judged the call at, the stricter of the computers it touches (§9.1); the tree's
   *  directory gives it when left out. */
  level?: Level;
  /** The user's signed answer bound to this call, where the holder's level asks (review N2). */
  answer?: SignedCardAnswer;
  /** The lease epoch the call was made under (§6.4). */
  epoch?: number;
  signal?: AbortSignal;
  /** A running Bash call's output, as it comes. */
  onOutput?(chunk: string, stream: "stdout" | "stderr"): void;
}

export interface TreeToolResult {
  output: unknown;
  isError: boolean;
  /** Where it ran. */
  computer: string;
  /** Bash only: the working folder after the call, when a leading `cd` moved it. */
  cwd?: string;
}

export interface TreeToolsOptions {
  tree: CoreTree;
  directory: TreeDirectory;
  transport: LinkTransport;
  /** The device of a computer, to reach it over the link. */
  deviceOf(computer: string): string | undefined;
  /** Bash on this computer: its holder (for the folder) and its executor (lanes A and C). */
  local?: { holder: LocalHolder; executor: ToolExecutor };
}

const READ_LIMIT = 2000;
const LINE_MAX = 2000;

/** Whether a tool call's path is a tree path, which this layer runs. */
export function isTreePath(path: unknown): path is string {
  return typeof path === "string" && splitTreePath(path) !== null;
}

/** A path as the call gave it, against the session's folder: a tree path stays, a relative one joins `cwd`. */
export function treePathFor(path: string, cwd?: string): string {
  if (splitTreePath(path)) return path.replace(/\/+$/, "");
  if (cwd === undefined || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw new ContractError("invalid", `${path} isn't in the folder tree`);
  const out = cwd.replace(/\/+$/, "").split("/");
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length <= 2) throw new ContractError("invalid", `${path} leads out of ${cwd}`);
      out.pop();
    } else out.push(seg);
  }
  const joined = out.join("/");
  if (!splitTreePath(joined)) throw new ContractError("invalid", `${path} isn't in the folder tree`);
  return joined;
}

/** A Bash command's folder: a leading `cd <folder>` followed by `&&` or `;` moves it, and the rest runs there. */
export function bashTarget(command: string, cwd: string | undefined): { cwd: string; command: string | null } {
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:(&&|;)\s*([\s\S]*))?$/.exec(command);
  if (!m) {
    if (cwd === undefined) throw new ContractError("invalid", "Bash on the folder tree needs a working folder");
    return { cwd, command };
  }
  const folder = treePathFor(m[2] ?? m[3] ?? m[4]!, cwd);
  const rest = m[6]?.trim();
  return { cwd: folder, command: rest ? rest : null };
}

export class TreeTools {
  readonly #o: TreeToolsOptions;
  /** Output listeners for remote calls, by `<device>\n<callId>`. */
  readonly #outputs = new Map<string, (chunk: string, stream: "stdout" | "stderr") => void>();
  readonly #offOutput: Unsubscribe;

  constructor(opts: TreeToolsOptions) {
    this.#o = opts;
    this.#offOutput = opts.transport.onNotify("tool_output", (params, from) => {
      const p = params as { callId?: string; chunk?: string; stream?: "stdout" | "stderr" };
      if (typeof p.callId !== "string" || typeof p.chunk !== "string") return;
      this.#outputs.get(`${from}\n${p.callId}`)?.(p.chunk, p.stream === "stderr" ? "stderr" : "stdout");
    });
  }

  close(): void {
    this.#offOutput();
  }

  /** Whether this layer runs the call: a tree tool whose path (or, for Bash, folder) is in the tree. */
  owns(tool: string, input: unknown, cwd?: string): boolean {
    if (!(TREE_TOOLS as readonly string[]).includes(tool)) return false;
    const i = (input ?? {}) as Record<string, unknown>;
    const path = i.file_path ?? i.path ?? (tool === "Bash" ? undefined : cwd);
    if (tool === "Bash") {
      try {
        return isTreePath(bashTarget(String(i.command ?? ""), cwd).cwd);
      } catch {
        return false;
      }
    }
    return isTreePath(path) || (typeof path === "string" && cwd !== undefined && isTreePath(cwd) && !path.startsWith("/"));
  }

  async run(tool: string, input: unknown, ctx: TreeToolContext): Promise<TreeToolResult> {
    const i = (input ?? {}) as Record<string, unknown>;
    const as: Caller = { kind: "session", sessionId: ctx.session, sessionKind: ctx.sessionKind, ...(ctx.bot === undefined ? {} : { bot: ctx.bot }) };
    const opts = { as, ...(ctx.level === undefined ? {} : { level: ctx.level }), ...(ctx.answer === undefined ? {} : { answer: ctx.answer }) };
    const tree = this.#o.tree;
    const where = (p: string) => tree.resolve(p).computer;
    try {
      switch (tool as TreeToolName) {
        case "Read": {
          const path = treePathFor(str(i.file_path, "file_path"), ctx.cwd);
          const data = await tree.readPart(path, { ...opts, encoding: "utf8" });
          return { output: numbered(text(data), num(i.offset), num(i.limit)), isError: false, computer: where(path) };
        }
        case "Write": {
          const path = treePathFor(str(i.file_path, "file_path"), ctx.cwd);
          await tree.write(path, { encoding: "utf8", text: str(i.content, "content", true) }, opts);
          return { output: `Wrote ${path}`, isError: false, computer: where(path) };
        }
        case "Edit": {
          const path = treePathFor(str(i.file_path, "file_path"), ctx.cwd);
          const oldS = str(i.old_string, "old_string", true);
          const newS = str(i.new_string, "new_string", true);
          if (oldS === newS) throw new ContractError("invalid", "old_string and new_string are the same");
          const before = text(await tree.readPart(path, { ...opts, encoding: "utf8" }));
          const count = oldS === "" ? 0 : before.split(oldS).length - 1;
          if (count === 0) throw new ContractError("invalid", `old_string isn't in ${path}`);
          if (count > 1 && i.replace_all !== true) throw new ContractError("invalid", `old_string is in ${path} ${count} times; give more of it, or replace_all`);
          const after = i.replace_all === true ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
          await tree.write(path, { encoding: "utf8", text: after }, opts);
          return { output: `Edited ${path} (${i.replace_all === true ? count : 1} replacement${count > 1 && i.replace_all === true ? "s" : ""})`, isError: false, computer: where(path) };
        }
        case "Glob": {
          const cwd = treePathFor(typeof i.path === "string" ? i.path : (ctx.cwd ?? ""), ctx.cwd);
          const res = await tree.globAll(str(i.pattern, "pattern"), { ...opts, cwd });
          return { output: res, isError: false, computer: where(cwd) };
        }
        case "Grep": {
          const cwd = treePathFor(typeof i.path === "string" ? i.path : (ctx.cwd ?? ""), ctx.cwd);
          const res = await tree.grepAll(str(i.pattern, "pattern"), {
            ...opts, cwd,
            ...(typeof i.glob === "string" ? { glob: i.glob } : {}),
            ...(i["-i"] === true || i.ignoreCase === true ? { ignoreCase: true } : {}),
            ...(num(i.head_limit) !== undefined ? { limit: num(i.head_limit)! } : {}),
          });
          return { output: res, isError: false, computer: where(cwd) };
        }
        case "LS": {
          const path = treePathFor(typeof i.path === "string" ? i.path : (ctx.cwd ?? ""), ctx.cwd);
          const entries = await tree.list(path, opts);
          return { output: entries.map((e) => ({ name: e.path.slice(e.path.lastIndexOf("/") + 1), type: e.type, size: e.size })), isError: false, computer: where(path) };
        }
        case "Bash":
          return await this.#bash(i, ctx, as);
        default:
          throw new ContractError("not_installed", `${tool} doesn't run on the folder tree`);
      }
    } catch (e) {
      if (isContractError(e)) return { output: { error: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) }, isError: true, computer: safeWhere(where, i, ctx) };
      throw e;
    }
  }

  async #bash(i: Record<string, unknown>, ctx: TreeToolContext, as: Caller): Promise<TreeToolResult> {
    const { cwd, command } = bashTarget(str(i.command, "command"), ctx.cwd);
    const loc = this.#o.tree.resolve(cwd);
    const c = this.#o.directory.get(loc.computer);
    if (!c?.online) throw new ContractError("computer_offline", `${loc.computer} is offline`, { computer: loc.computer });
    if (command === null) {
      // Only a `cd`: check the folder is there, and move the session's folder.
      await this.#o.tree.list(cwd, { as, ...(ctx.level === undefined ? {} : { level: ctx.level }) });
      return { output: "", isError: false, computer: loc.computer, cwd };
    }
    const timeoutMs = num(i.timeout);
    const input = { command, cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    const output = ctx.onOutput ?? (() => {});
    if (loc.computer === this.#o.directory.self()) {
      const local = this.#o.local;
      if (!local) throw new ContractError("refused", "this computer has no executor for Bash on the folder tree");
      const real = await local.holder.realFolder(cwd, { as });
      const abort = new AbortController();
      const off = ctx.signal ? onAbort(ctx.signal, () => abort.abort()) : () => {};
      try {
        const r = await local.executor.run("Bash", input, { as, session: ctx.session, callId: ctx.callId, cwd: real, treeCwd: cwd, signal: abort.signal, output });
        return { ...r, computer: loc.computer, cwd };
      } finally {
        off();
      }
    }
    // Another computer: `tool.run` over the link, at the calling computer's level for it.
    const device = this.#o.deviceOf(loc.computer);
    if (!device) throw new ContractError("computer_offline", `${loc.computer} can't be reached`, { computer: loc.computer });
    const level = ctx.level ?? strictestLevel([c.level])!;
    const key = `${device}\n${ctx.callId}`;
    this.#outputs.set(key, output);
    let link: Awaited<ReturnType<LinkTransport["connect"]>>;
    try {
      link = await this.#o.transport.connect(device);
    } catch (e) {
      this.#outputs.delete(key);
      throw offlineAs(loc.computer, e);
    }
    const off = ctx.signal ? onAbort(ctx.signal, () => { void link.request("tool.cancel", { callId: ctx.callId }).catch(() => {}); }) : () => {};
    try {
      const r = await link.request<{ output: unknown; isError: boolean }>("tool.run", {
        session: ctx.session, callId: ctx.callId, epoch: ctx.epoch ?? 0, tool: "Bash", input, level,
        ...(ctx.answer === undefined ? {} : { answer: ctx.answer }),
      }, { priority: "control" });
      return { ...r, computer: loc.computer, cwd };
    } catch (e) {
      throw offlineAs(loc.computer, e);
    } finally {
      off();
      this.#outputs.delete(key);
    }
  }
}

function str(v: unknown, name: string, allowEmpty = false): string {
  if (typeof v !== "string" || (!allowEmpty && v === "")) throw new ContractError("invalid", `${name} is a string`);
  return v;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

function text(d: TreeData): string {
  return d.encoding === "utf8" ? d.text : Buffer.from(d.data, "base64").toString("utf8");
}

/** A file's lines numbered from 1, as the runtime's own Read shows them (`cat -n`): `offset` is the first line. */
function numbered(body: string, offset?: number, limit?: number): string {
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = Math.max(1, offset ?? 1);
  const end = Math.min(lines.length, start - 1 + (limit ?? READ_LIMIT));
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const line = lines[n - 1]!;
    out.push(`${String(n).padStart(6)}\t${line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line}`);
  }
  return out.join("\n");
}

function onAbort(signal: AbortSignal, fn: () => void): Unsubscribe {
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

function safeWhere(where: (p: string) => string, i: Record<string, unknown>, ctx: TreeToolContext): string {
  for (const p of [i.file_path, i.path, ctx.cwd]) {
    if (typeof p !== "string") continue;
    try {
      return where(treePathFor(p, ctx.cwd));
    } catch {
      // not a tree path
    }
  }
  return "";
}
