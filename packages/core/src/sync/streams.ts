// The sync methods' streams (H-M3): `sync.heads`, `sync.pull` and `sync.push` carry more than one kind of stream over
// the same link methods, each named by a prefix (`transcript:<session>` for sessions' records, `memory:<bot>` for a
// bot's memory). A transport keeps one handler per method, so every sync on a transport mounts its streams here, and
// this routes each request to the stream's owner by the prefix of its `stream`. `sync.heads` asks every owner (or the
// owners of the `prefixes` it names) and joins their answers.
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";

export interface SyncStreamOwner {
  /** The heads of this owner's streams; `streams`, when given, names the ones wanted. */
  heads(params: { streams?: Set<string> }, from: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  pull(params: Record<string, unknown>, from: string): unknown;
  push(params: Record<string, unknown>, from: string): unknown;
}

type Mountable = Pick<LinkTransport, "handle">;

class SyncStreams {
  readonly #t: Mountable;
  readonly #owners = new Map<string, SyncStreamOwner>();
  #offs: Unsubscribe[] = [];

  constructor(t: Mountable) {
    this.#t = t;
  }

  mount(prefix: string, owner: SyncStreamOwner): Unsubscribe {
    if (this.#owners.has(prefix)) throw new ContractError("conflict", `the sync stream ${prefix} is mounted already`);
    this.#owners.set(prefix, owner);
    if (this.#offs.length === 0) this.#start();
    return () => {
      if (this.#owners.get(prefix) !== owner) return;
      this.#owners.delete(prefix);
      if (this.#owners.size === 0) for (const off of this.#offs.splice(0)) off();
    };
  }

  #start(): void {
    this.#offs.push(this.#t.handle("sync.heads", async (raw, from) => {
      const p = (raw ?? {}) as { streams?: unknown; prefixes?: unknown };
      const names = Array.isArray(p.streams) ? new Set(p.streams.filter((x): x is string => typeof x === "string")) : undefined;
      const prefixes = Array.isArray(p.prefixes) ? p.prefixes.filter((x): x is string => typeof x === "string") : undefined;
      const heads: Record<string, unknown> = {};
      for (const [prefix, owner] of this.#owners) {
        if (prefixes && !prefixes.includes(prefix)) continue;
        if (names && ![...names].some((n) => n.startsWith(prefix))) continue;
        Object.assign(heads, await owner.heads(names ? { streams: names } : {}, from));
      }
      return { heads };
    }));
    this.#offs.push(this.#t.handle("sync.pull", (raw, from) => this.#owner(raw, "sync.pull").pull(raw as Record<string, unknown>, from)));
    this.#offs.push(this.#t.handle("sync.push", (raw, from) => this.#owner(raw, "sync.push").push(raw as Record<string, unknown>, from)));
  }

  #owner(raw: unknown, method: string): SyncStreamOwner {
    const stream = (raw as { stream?: unknown } | undefined)?.stream;
    if (typeof stream === "string") {
      for (const [prefix, owner] of this.#owners) if (stream.startsWith(prefix) && stream.length > prefix.length) return owner;
    }
    throw new ContractError("invalid", `${method}: bad params`);
  }
}

const byTransport = new WeakMap<object, SyncStreams>();

/** Mounts `owner`'s streams, named `<prefix>…`, on the transport's sync methods. */
export function mountSyncStreams(transport: Mountable, prefix: string, owner: SyncStreamOwner): Unsubscribe {
  let s = byTransport.get(transport);
  if (!s) {
    s = new SyncStreams(transport);
    byTransport.set(transport, s);
  }
  return s.mount(prefix, owner);
}
