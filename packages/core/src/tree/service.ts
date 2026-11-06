// The holder's side of the link: what this computer serves to the others (spec §9.1, §8.2; the owner's items 88 and
// 89). Another computer's `tree.*` call reaches this computer's `LocalHolder` stamped as a `peer`, from the link and
// the call's `session`, never as the user or the core (review N2); `tool.run` runs a tool call (Bash) where its folder
// is, judged at the stricter of this computer's level and the call's.
//
// Methods served (`peer` role). Those marked * are lane J's additions, requested of lane B for the protocol:
//   tree.stat, tree.read, tree.write (+ `executable`*), tree.list, tree.remove, tree.move, tree.glob,
//   tree.grep (+ `ignoreCase`*), tree.mkdir*, tree.readlink*, tree.symlink*, tree.watch*, tree.unwatch*,
//   tool.run, tool.cancel (+ `session`*)
// Notifications sent: `tree.changed`* (a watch's changes), `tool_output` (a running call's output, + `session`*).
//
// Bulk calls (reads, writes, glob, grep) run at most `BULK_PER_DEVICE` at once per calling computer, with a short
// queue behind them, so one computer's burst can't fill this one's memory (review minor 5); one write carries at most
// `TREE_IO_MAX`. A running call is known by its device, session and call id (minor 7).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COMPUTERS_METHODS, DEFAULT_LEVEL, Level, SessionId, SignedCardAnswer, TreePath,
  type Caller, type FileStat,
} from "@waifucave/clover-protocol";
import {
  levelDecision, strictestLevel, verifySignedAnswer,
  type AnswerDevices, type AnswerLedger, type CallCardRenderer,
} from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import { TREE_IO_MAX, type HolderCall, type LocalHolder } from "./holder";
import type { TreeChangedNotice } from "./remote";

const M = COMPUTERS_METHODS;
const Via = { session: SessionId.optional(), level: Level.optional(), answer: SignedCardAnswer.optional() };

/** What each served method takes: lane B's params, with lane J's additions marked in the header. */
export const TREE_PEER_PARAMS = {
  "tree.stat": M.treeStat.params,
  "tree.read": M.treeRead.params,
  "tree.write": M.treeWrite.params.extend({ executable: z.boolean().optional() }),
  "tree.list": M.treeList.params,
  "tree.remove": M.treeRemove.params,
  "tree.move": M.treeMove.params,
  "tree.glob": M.treeGlob.params,
  "tree.grep": M.treeGrep.params.extend({ ignoreCase: z.boolean().optional() }),
  "tree.mkdir": z.object({ ...Via, path: TreePath }),
  "tree.readlink": z.object({ ...Via, path: TreePath }),
  "tree.symlink": z.object({ ...Via, path: TreePath, target: z.string().min(1).max(4096) }),
  "tree.watch": z.object({ ...Via, path: TreePath }),
  "tree.unwatch": z.object({ watchId: z.string().min(1).max(128) }),
  "tool.run": M.toolRun.params,
  "tool.cancel": M.toolCancel.params.extend({ session: SessionId.optional() }),
} as const;

/** Bulk calls one computer runs here at once, and how many more may wait. */
export const BULK_PER_DEVICE = 4;
const BULK_QUEUE = 32;
const BULK_METHODS = new Set(["tree.read", "tree.write", "tree.glob", "tree.grep"]);
/** The longest base64 text one write may carry. */
const WRITE_BASE64_MAX = Math.ceil(TREE_IO_MAX / 3) * 4;

/** One tool call to run here: Bash, in a folder of this computer's tree. */
export interface ToolRunContext {
  /** Who it is for: always a peer here (review N2). */
  as: Caller;
  session: string;
  callId: string;
  /** The folder it runs in: its real path, already resolved and fenced, and its tree path. */
  cwd: string;
  treeCwd: string;
  signal: AbortSignal;
  /** Output as it comes; it streams to the calling computer as `tool_output`. */
  output(chunk: string, stream: "stdout" | "stderr"): void;
}

/** What runs a tool call on this computer. In the daemon it is the runtime's own Bash under this computer's sandbox
 *  (lanes A and C); tests give a plain one. There is no default: nothing here runs a command unsandboxed. */
export interface ToolExecutor {
  run(tool: string, input: unknown, ctx: ToolRunContext): Promise<{ output: unknown; isError: boolean }>;
}

/** What a Bash call's input says, for the holder: its command, and the folder it runs in. */
export const BashInput = z.object({
  command: z.string().min(1).max(100_000),
  /** A folder of the tree on this computer. */
  cwd: TreePath,
  timeoutMs: z.number().int().positive().max(24 * 3600 * 1000).optional(),
}).passthrough();

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const NO_DEVICES: AnswerDevices = { get: () => undefined, verifyAnswer: async () => false };
const NEVER: AnswerLedger = { claim: () => false };

export interface TreeServiceOptions {
  transport: LinkTransport;
  holder: LocalHolder;
  clock: Pick<Clock, "now">;
  /** Whether `device` may call at all: a paired computer, not revoked. */
  mayCall: (device: string) => boolean;
  /** This computer's level, which a peer's tool call is judged at. */
  level?: () => Level;
  answers?: { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer };
  tools?: ToolExecutor;
}

interface Running {
  device: string;
  session: string;
  callId: string;
  abort: AbortController;
}

/** Per-device slots for bulk calls. */
export class BulkSlots {
  readonly #running = new Map<string, number>();
  readonly #waiting = new Map<string, (() => void)[]>();

  async run<T>(device: string, fn: () => Promise<T>): Promise<T> {
    if ((this.#running.get(device) ?? 0) >= BULK_PER_DEVICE) {
      const q = this.#waiting.get(device) ?? [];
      if (q.length >= BULK_QUEUE) throw new ContractError("refused", "too many file calls from your computer at once; try again shortly");
      await new Promise<void>((resolve) => {
        q.push(resolve);
        this.#waiting.set(device, q);
      });
    } else {
      this.#running.set(device, (this.#running.get(device) ?? 0) + 1);
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiting.get(device)?.shift();
      if (next) next(); // the slot passes on
      else {
        const n = (this.#running.get(device) ?? 1) - 1;
        if (n <= 0) this.#running.delete(device);
        else this.#running.set(device, n);
      }
    }
  }
}

export class TreeService {
  readonly #o: TreeServiceOptions;
  readonly #off: Unsubscribe[] = [];
  readonly #running = new Map<string, Running>();
  readonly #bulk = new BulkSlots();
  /** Watches served, by id, with the device that holds each. */
  readonly #watches = new Map<string, { device: string; stop: Unsubscribe }>();
  #watchSeq = 0;

  constructor(opts: TreeServiceOptions) {
    this.#o = opts;
    const t = opts.transport;
    const serve = <K extends keyof typeof TREE_PEER_PARAMS>(method: K, fn: (p: z.infer<(typeof TREE_PEER_PARAMS)[K]>, call: HolderCall, from: string) => unknown) => {
      this.#off.push(t.handle(method, async (raw, from) => {
        if (!opts.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
        const parsed = TREE_PEER_PARAMS[method].safeParse(raw);
        if (!parsed.success) throw new ContractError("invalid", `${method}: ${parsed.error.issues[0]?.message ?? "bad params"}`);
        const p = parsed.data as { session?: string; level?: Level; answer?: z.infer<typeof SignedCardAnswer> };
        // The receiver stamps who the call is for (review N2): a peer, for the session it names, never the user.
        const as: Caller = { kind: "peer", device: from, ...(p.session === undefined ? {} : { sessionId: p.session }) };
        const call: HolderCall = { as, ...(p.level === undefined ? {} : { level: p.level }), ...(p.answer === undefined ? {} : { answer: p.answer }) };
        if (BULK_METHODS.has(method)) return this.#bulk.run(from, async () => fn(parsed.data as never, call, from));
        return fn(parsed.data as never, call, from);
      }));
    };
    const h = opts.holder;
    serve("tree.stat", async (p, call) => ({ stat: await h.stat(p.path, call) }));
    serve("tree.read", (p, call) => h.read(p.path, {
      ...call, ...(p.encoding === undefined ? {} : { encoding: p.encoding }),
      ...(p.offset === undefined ? {} : { offset: p.offset }), ...(p.length === undefined ? {} : { length: p.length }),
    }));
    serve("tree.write", async (p, call) => {
      if (p.data.encoding === "base64" ? p.data.data.length > WRITE_BASE64_MAX : p.data.text.length > TREE_IO_MAX) {
        throw new ContractError("invalid", `${p.path}: a write carries at most ${TREE_IO_MAX} bytes`);
      }
      await h.write(p.path, p.data, { ...call, ...(p.executable === undefined ? {} : { executable: p.executable }) });
      return { ok: true };
    });
    serve("tree.list", async (p, call) => ({ entries: await h.list(p.path, call) satisfies FileStat[] }));
    serve("tree.remove", async (p, call) => {
      await h.remove(p.path, { ...call, ...(p.recursive === undefined ? {} : { recursive: p.recursive }) });
      return { ok: true };
    });
    serve("tree.move", async (p, call) => {
      await h.move(p.from, p.to, call);
      return { ok: true };
    });
    serve("tree.glob", (p, call) => h.glob(p.pattern, { ...call, cwd: p.cwd, ...(p.limit === undefined ? {} : { limit: p.limit }) }));
    serve("tree.grep", (p, call) => h.grep(p.pattern, {
      ...call, cwd: p.cwd, ...(p.glob === undefined ? {} : { glob: p.glob }),
      ...(p.ignoreCase === undefined ? {} : { ignoreCase: p.ignoreCase }), ...(p.limit === undefined ? {} : { limit: p.limit }),
    }));
    serve("tree.mkdir", async (p, call) => {
      await h.mkdir(p.path, call);
      return { ok: true };
    });
    serve("tree.readlink", async (p, call) => ({ target: await h.readlink(p.path, call) }));
    serve("tree.symlink", async (p, call) => {
      await h.symlink(p.path, p.target, call);
      return { ok: true };
    });
    serve("tree.watch", async (p, call, from) => {
      const watchId = `w_${++this.#watchSeq}`;
      const send = (n: TreeChangedNotice) => {
        void t.connect(from).then((link) => link.notify("tree.changed", n, { priority: "control" }), () => {});
      };
      const stop = await h.watch(p.path, call, (e) => send(e.type === "resync" ? { watchId, resync: true } : { watchId, paths: e.paths }));
      this.#watches.set(watchId, { device: from, stop });
      return { watchId };
    });
    serve("tree.unwatch", (p, _call, from) => {
      const w = this.#watches.get(p.watchId);
      if (w && w.device === from) {
        w.stop();
        this.#watches.delete(p.watchId);
      }
      return { ok: true };
    });
    serve("tool.run", (p, call, from) => this.#run(p, call, from));
    serve("tool.cancel", (p, _call, from) => {
      // By device, session and call id; a cancel that names no session reaches the call only when it is the one.
      if (p.session !== undefined) this.#running.get(runKey(from, p.session, p.callId))?.abort.abort();
      else {
        const mine = [...this.#running.values()].filter((r) => r.device === from && r.callId === p.callId);
        if (mine.length === 1) mine[0]!.abort.abort();
      }
      return { ok: true };
    });
    // A link that goes down takes its watches with it; the caller subscribes again when it comes back.
    this.#off.push(t.watch((view) => {
      if (view.up) return;
      for (const [id, w] of this.#watches) {
        if (w.device !== view.peer) continue;
        w.stop();
        this.#watches.delete(id);
      }
    }));
  }

  /** How many tool calls and watches are running here, for tests. */
  get counts(): { running: number; watches: number } {
    return { running: this.#running.size, watches: this.#watches.size };
  }

  close(): void {
    for (const off of this.#off.splice(0)) off();
    for (const r of this.#running.values()) r.abort.abort();
    for (const w of this.#watches.values()) w.stop();
    this.#watches.clear();
  }

  async #run(p: z.infer<(typeof TREE_PEER_PARAMS)["tool.run"]>, call: HolderCall, from: string): Promise<{ output: unknown; isError: boolean }> {
    const tools = this.#o.tools;
    if (!tools) throw new ContractError("refused", "this computer runs no tool calls for others");
    if (p.tool !== "Bash") throw new ContractError("not_installed", `${p.tool} doesn't run on another computer yet`);
    const input = BashInput.safeParse(p.input);
    if (!input.success) throw new ContractError("invalid", `Bash: ${input.error.issues[0]?.message ?? "bad input"}`);
    // Where it runs: a folder of this computer's tree, fenced as the peer.
    const cwd = await this.#o.holder.realFolder(input.data.cwd, call);
    await this.#judge(p, call);
    const key = runKey(from, p.session, p.callId);
    if (this.#running.has(key)) throw new ContractError("conflict", `the call ${p.callId} is already running`);
    const abort = new AbortController();
    this.#running.set(key, { device: from, session: p.session, callId: p.callId, abort });
    const t = this.#o.transport;
    let link: Awaited<ReturnType<LinkTransport["connect"]>> | null = null;
    t.connect(from).then((l) => (link = l), () => {});
    try {
      return await tools.run(p.tool, input.data, {
        as: call.as, session: p.session, callId: p.callId, cwd, treeCwd: input.data.cwd, signal: abort.signal,
        output: (chunk, stream) => {
          const send = (l: NonNullable<typeof link>) => l.notify("tool_output", { session: p.session, callId: p.callId, chunk, stream }, { priority: "tokens" });
          if (link) send(link);
          else void t.connect(from).then((l) => { link = l; send(l); }, () => {});
        },
      });
    } finally {
      this.#running.delete(key);
    }
  }

  /** A peer's tool call, at the stricter of this computer's level and the call's: allowed, refused, or let through by
   *  the user's signed answer bound to exactly this call (`tool.run` with its tool and input). */
  async #judge(p: z.infer<(typeof TREE_PEER_PARAMS)["tool.run"]>, call: HolderCall): Promise<void> {
    const level = strictestLevel([this.#o.level?.() ?? DEFAULT_LEVEL, p.level])!;
    const d = levelDecision(level, "execute");
    if (d === "allow") return;
    if (d === "deny") throw new ContractError("refused", `${this.#o.holder.name} runs no commands for another computer at its level`);
    if (!call.answer) throw new ContractError("refused", "this command needs the user's answer, signed and bound to it");
    const a = this.#o.answers ?? { devices: NO_DEVICES, ledger: NEVER, render: () => undefined };
    const verdict = await verifySignedAnswer(call.answer, {
      self: this.#o.holder.name, method: "tool.run", params: toolCallBinding(p.tool, p.input), now: this.#o.clock.now(), sha256, ...a,
    });
    if (verdict !== "ok") throw new ContractError("refused", `the answer doesn't hold for this command (${verdict})`);
  }
}

/** A running call's key: the calling device, its session and the call id (review minor 7). */
export function runKey(device: string, session: string, callId: string): string {
  return `${device}\n${session}\n${callId}`;
}

/** What a signed answer for a peer's tool call binds: the tool and its input, nothing about the session or level. */
export function toolCallBinding(tool: string, input: unknown): { tool: string; input: unknown } {
  return { tool, input };
}
