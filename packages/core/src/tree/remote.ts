// Another computer's part of the tree, over the link (spec §9.1, §8.2; the owner's item 88). Every call is a `tree.*`
// request to the computer that holds the files, which stamps it as a `peer` itself, fences it and judges its changes
// (`service.ts`, `holder.ts`). This side never decides what the holder allows: it carries the calling session, the
// calling computer's level for the call and the user's signed answer where one was given (review N2).
//
// A computer that is off answers `computer_offline` at once: the link fails a request fast when no path reaches the
// peer, and a request in flight when the link drops fails the same way, never after a hang.
import type { FileStat } from "@waifucave/clover-protocol";
import { fenceParam, type ActFence } from "./fencing";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkPriority, LinkTransport } from "../contracts/link-transport";
import type { TreeData } from "../contracts/tree";
import type { Holder, HolderCall } from "./holder";
import { withAnswer, type AnswerAsker } from "./judge";
import type { TreeWatchEvent } from "./watch";

/** The notification a holder sends for a watch: `tree.changed`, with the watch's id. */
export interface TreeChangedNotice {
  watchId: string;
  paths?: string[];
  resync?: boolean;
}

/** What travels with every call: whose session it is for, and for a change, the level and the answer. */
export function viaPeer(call: HolderCall): { session?: string; level?: HolderCall["level"]; answer?: HolderCall["answer"] } {
  const as = call.as;
  const session = as.kind === "session" ? as.sessionId : as.kind === "peer" ? as.sessionId : undefined;
  return {
    ...(session === undefined ? {} : { session }),
    ...(call.level === undefined ? {} : { level: call.level }),
    ...(call.answer === undefined ? {} : { answer: call.answer }),
  };
}

/** A link failure as the tree's: a peer that can't be reached is a computer that is offline. */
export function offlineAs(computer: string, err: unknown): unknown {
  if (err instanceof ContractError && (err.code === "offline" || err.code === "closed" || err.code === "computer_offline")) {
    return new ContractError("computer_offline", `${computer} is offline`, { computer });
  }
  return err;
}

interface RemoteWatch {
  path: string;
  call: HolderCall;
  fn: (e: TreeWatchEvent) => void;
  /** The holder's id for it, while subscribed. */
  id?: string;
  closed: boolean;
}

export class RemoteHolder implements Holder {
  readonly #transport: LinkTransport;
  readonly #device: string;
  readonly #computer: () => string;
  readonly #watches = new Set<RemoteWatch>();
  #offNotify: Unsubscribe | null = null;
  #offLink: Unsubscribe | null = null;
  #wasUp = true;

  readonly #ask: AnswerAsker | undefined;

  /** `computer` names the holder in errors (it may be renamed while this object lives). `ask` shows the user the
   *  holder's card when its level needs their answer (R1). */
  readonly #fence: ActFence | undefined;
  constructor(opts: { transport: LinkTransport; device: string; computer: () => string; ask?: AnswerAsker; fence?: ActFence }) {
    this.#fence = opts.fence;
    this.#transport = opts.transport;
    this.#device = opts.device;
    this.#computer = opts.computer;
    this.#ask = opts.ask;
  }

  /** Stops every watch this side holds. */
  close(): void {
    for (const w of this.#watches) w.closed = true;
    this.#watches.clear();
    this.#offNotify?.();
    this.#offLink?.();
    this.#offNotify = this.#offLink = null;
  }

  async watch(path: string, call: HolderCall, fn: (e: TreeWatchEvent) => void): Promise<Unsubscribe> {
    this.#listen();
    const w: RemoteWatch = { path, call, fn, closed: false };
    await this.#subscribe(w);
    this.#watches.add(w);
    return () => {
      if (w.closed) return;
      w.closed = true;
      this.#watches.delete(w);
      const id = w.id;
      if (id !== undefined) void this.#call("tree.unwatch", { watchId: id }).catch(() => {});
    };
  }

  async #subscribe(w: RemoteWatch): Promise<void> {
    const { watchId } = await this.#call<{ watchId: string }>("tree.watch", { ...viaPeer(w.call), path: w.path });
    w.id = watchId;
  }

  /** One listener for the holder's notices, and one for the link: when it comes back, every watch subscribes again
   *  and hears `resync`, since changes made while it was down were never reported. */
  #listen(): void {
    if (this.#offNotify) return;
    this.#offNotify = this.#transport.onNotify("tree.changed", (params, from) => {
      if (from !== this.#device) return;
      const n = params as TreeChangedNotice;
      for (const w of this.#watches) {
        if (w.id !== n.watchId || w.closed) continue;
        w.fn(n.resync ? { type: "resync" } : { type: "changed", paths: n.paths ?? [] });
      }
    });
    this.#offLink = this.#transport.watch((view) => {
      if (view.peer !== this.#device) return;
      if (!view.up) {
        this.#wasUp = false;
        for (const w of this.#watches) w.id = undefined;
        return;
      }
      if (this.#wasUp) return;
      this.#wasUp = true;
      for (const w of [...this.#watches]) {
        void this.#subscribe(w).then(() => { if (!w.closed) w.fn({ type: "resync" }); }, () => { if (!w.closed) w.fn({ type: "resync" }); });
      }
    });
  }

  async #call<R>(method: string, params: Record<string, unknown>, priority: LinkPriority = "control"): Promise<R> {
    return withAnswer(params.answer === undefined ? this.#ask : undefined, async (answer) => {
      try {
        const link = await this.#transport.connect(this.#device);
        // This computer's fencing token goes with every call (`fencing.ts`).
        const sent = { ...params, ...fenceParam(this.#fence) };
        return await link.request<R>(method, answer ? { ...sent, answer } : sent, { priority });
      } catch (e) {
        throw offlineAs(this.#computer(), e);
      }
    });
  }

  async stat(path: string, call: HolderCall): Promise<FileStat | null> {
    return (await this.#call<{ stat: FileStat | null }>("tree.stat", { ...viaPeer(call), path })).stat;
  }

  async read(path: string, call: HolderCall & { encoding?: "utf8" | "base64"; offset?: number; length?: number }): Promise<TreeData> {
    return this.#call<TreeData>("tree.read", {
      ...viaPeer(call), path,
      ...(call.encoding === undefined ? {} : { encoding: call.encoding }),
      ...(call.offset === undefined ? {} : { offset: call.offset }),
      ...(call.length === undefined ? {} : { length: call.length }),
    }, "files");
  }

  async write(path: string, data: TreeData, call: HolderCall & { executable?: boolean }): Promise<void> {
    await this.#call("tree.write", { ...viaPeer(call), path, data, createDirs: true, ...(call.executable === undefined ? {} : { executable: call.executable }) }, "files");
  }

  async mkdir(path: string, call: HolderCall): Promise<void> {
    await this.#call("tree.mkdir", { ...viaPeer(call), path });
  }

  async list(path: string, call: HolderCall): Promise<FileStat[]> {
    return (await this.#call<{ entries: FileStat[] }>("tree.list", { ...viaPeer(call), path })).entries;
  }

  async remove(path: string, call: HolderCall & { recursive?: boolean }): Promise<void> {
    await this.#call("tree.remove", { ...viaPeer(call), path, ...(call.recursive === undefined ? {} : { recursive: call.recursive }) });
  }

  async move(from: string, to: string, call: HolderCall): Promise<void> {
    await this.#call("tree.move", { ...viaPeer(call), from, to });
  }

  async readlink(path: string, call: HolderCall): Promise<string> {
    return (await this.#call<{ target: string }>("tree.readlink", { ...viaPeer(call), path })).target;
  }

  async symlink(path: string, target: string, call: HolderCall): Promise<void> {
    await this.#call("tree.symlink", { ...viaPeer(call), path, target });
  }

  async glob(pattern: string, call: HolderCall & { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }> {
    return this.#call("tree.glob", { ...viaPeer(call), pattern, cwd: call.cwd, ...(call.limit === undefined ? {} : { limit: call.limit }) });
  }

  async grep(pattern: string, call: HolderCall & { cwd: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    return this.#call("tree.grep", {
      ...viaPeer(call), pattern, cwd: call.cwd,
      ...(call.glob === undefined ? {} : { glob: call.glob }),
      ...(call.ignoreCase === undefined ? {} : { ignoreCase: call.ignoreCase }),
      ...(call.limit === undefined ? {} : { limit: call.limit }),
    });
  }
}
