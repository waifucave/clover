// Sessions' records, copied live to the user's other computers (D-M2's ask for H-M2; spec §8.5 "Transcripts", §6.4
// "A tool call's start syncs before the call runs"). The computer running a session gives each record its place; every
// other computer keeps a copy in the same order, so when it takes the bots over it finds the old runner's open turn
// and its started calls at once, without a restart, and lane D's host records them "interrupted, may have run on
// <computer>" (`DurableSessionHost.catchUp`).
//
// * **Live:** each record the runner's host writes (`tap`) is pushed to every linked computer as `sync.push` on the
//   stream `transcript:<session>`, with the base it extends. A receiver that holds a different base answers
//   `stale_base`, and the runner sends what it lacks from its history.
// * **Catch-up:** when a link comes up, each side asks the other for its streams' heads (`sync.heads`) and pulls what
//   it lacks (`sync.pull`).
// * **Only the writer:** a receiver takes a session's records only from the computer the session names as running it
//   (`not_writer` otherwise), and never from a device that isn't a paired computer.
// * **Late:** a record stamped with an older lease epoch than the receiver has seen is handed over marked `late`, so
//   the host can put it at the end (§8.5 "Events from an earlier lease that arrive late go at the end, marked late").
// * **Grants:** a record never grants by being copied (review N7). The host takes a peer's `session_grant` record as a
//   request that waits for its own card or a signed answer, never as the grant itself.
import type { SessionView } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { SessionRecord } from "../contracts/session-host";
import type { FileDeviceRegistry } from "../devices/registry";

const PREFIX = "transcript:";
/** Entries per push or pull. */
const BATCH = 500;

/** Lane D's host as the computer running sessions sees it (`DurableSessionHost`), structurally. */
export interface SessionRecordSource {
  tap(fn: (entry: { record: SessionRecord; view: SessionView }) => void): Unsubscribe;
  history(id: string, opts?: { afterSeq?: number; limit?: number }): SessionRecord[];
  list(): SessionView[];
  get(id: string): SessionView | undefined;
}

/** What lane D's host adds so the others' copies land in it (H's ask to D): the next seq it expects for a session it
 *  copies (0 for one it doesn't know), and an append of records in order, `view` naming the session (on the first
 *  records, it opens the session dormant). */
export interface SessionRecordSink {
  head(id: string): number;
  ingest(view: SessionView, records: SessionRecord[], opts: { from: string; late: boolean }): void;
}

export type SessionHostForSync = SessionRecordSource & SessionRecordSink;

export interface SessionRecordSyncOptions {
  self: string;
  /** This computer's tree name: the `computer` a session it runs names. */
  computer(): string;
  transport: Pick<LinkTransport, "connect" | "handle" | "links" | "watch">;
  registry: Pick<FileDeviceRegistry, "get" | "list">;
  host: SessionHostForSync;
  /** The lease's fencing token (lease.ts `isStale`). */
  isStale?(epoch: number): boolean;
  log?(line: string): void;
}

type Entry = { seq: number; epoch: number; ts: number; device: string; payload: { record: SessionRecord; view?: SessionView } };

export class SessionRecordSync {
  readonly #o: SessionRecordSyncOptions;
  readonly #offs: Unsubscribe[] = [];
  /** Records waiting to go out, per session: pushed together at the end of the tick. */
  readonly #outbox = new Map<string, { view: SessionView; records: SessionRecord[] }>();
  #flushing = false;
  /** Per peer, sessions whose push needs a resend from history. */
  readonly #resend = new Map<string, Set<string>>();

  constructor(o: SessionRecordSyncOptions) {
    this.#o = o;
    const t = o.transport;
    this.#offs.push(o.host.tap(({ record, view }) => {
      if (view.computer !== o.computer()) return;
      const box = this.#outbox.get(record.sessionId) ?? { view, records: [] };
      box.view = view;
      box.records.push(record);
      this.#outbox.set(record.sessionId, box);
      if (!this.#flushing) {
        this.#flushing = true;
        queueMicrotask(() => void this.#flush());
      }
    }));
    this.#offs.push(t.handle("sync.heads", (raw, from) => {
      this.#mustBeComputer(from);
      const want = (raw as { streams?: unknown } | undefined)?.streams;
      const names = Array.isArray(want) ? new Set(want.filter((x): x is string => typeof x === "string")) : undefined;
      const heads: Record<string, { seq: number; epoch: number }> = {};
      for (const v of o.host.list()) {
        const stream = `${PREFIX}${v.id}`;
        if (names && !names.has(stream)) continue;
        const n = o.host.head(v.id);
        if (n === 0) continue;
        const last = o.host.history(v.id, { afterSeq: n - 2, limit: 1 })[0];
        heads[stream] = { seq: n - 1, epoch: last?.epoch ?? 0 };
      }
      return { heads };
    }));
    this.#offs.push(t.handle("sync.pull", (raw, from) => {
      this.#mustBeComputer(from);
      const p = raw as { stream?: unknown; after?: unknown; limit?: unknown } | undefined;
      const id = sessionOf(p?.stream);
      if (!id || typeof p?.after !== "number" || typeof p.limit !== "number") throw new ContractError("invalid", "sync.pull: bad params");
      const view = o.host.get(id);
      if (!view) return { entries: [], more: false };
      const limit = Math.min(Math.max(1, Math.floor(p.limit)), BATCH);
      const records = o.host.history(id, { afterSeq: p.after, limit: limit + 1 });
      const page = records.slice(0, limit);
      return { entries: page.map((r, i) => this.#entry(r, i === 0 ? view : undefined)), more: records.length > limit };
    }));
    this.#offs.push(t.handle("sync.push", (raw, from) => {
      this.#mustBeComputer(from);
      const p = raw as { stream?: unknown; base?: unknown; entries?: unknown } | undefined;
      const id = sessionOf(p?.stream);
      if (!id || typeof p?.base !== "number" || !Array.isArray(p.entries)) throw new ContractError("invalid", "sync.push: bad params");
      return this.#take(id, p.base, p.entries as Entry[], from);
    }));
    // A link coming up: catch up from that computer, and offer it what this one writes.
    const up = new Set<string>();
    this.#offs.push(t.watch((v) => {
      if (v.up && !up.has(v.peer)) {
        up.add(v.peer);
        if (this.#isComputer(v.peer)) void this.catchUpFrom(v.peer).catch((e: unknown) => this.#log(`catching up from ${v.peer}: ${errText(e)}`));
      } else if (!v.up) up.delete(v.peer);
    }));
  }

  /** Pulls what `peer` holds beyond this computer's copies. */
  async catchUpFrom(peer: string): Promise<number> {
    const link = await this.#o.transport.connect(peer);
    const { heads } = await link.request<{ heads: Record<string, { seq: number; epoch: number }> }>("sync.heads", {});
    let taken = 0;
    for (const [stream, head] of Object.entries(heads)) {
      const id = sessionOf(stream);
      if (!id) continue;
      for (;;) {
        const have = this.#o.host.head(id);
        if (head.seq < have) break;
        const page = await link.request<{ entries: Entry[]; more: boolean }>("sync.pull", { stream, after: have - 1, limit: BATCH });
        if (page.entries.length === 0) break;
        const r = this.#take(id, have - 1, page.entries, peer);
        if (!r.ok) break;
        taken += page.entries.length;
        if (!page.more) break;
      }
    }
    return taken;
  }

  close(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  // ---- inside ----

  async #flush(): Promise<void> {
    this.#flushing = false;
    const batches = [...this.#outbox.entries()];
    this.#outbox.clear();
    const peers = this.#o.transport.links().filter((l) => l.up && this.#isComputer(l.peer)).map((l) => l.peer);
    for (const peer of peers) {
      for (const [id, box] of batches) {
        const first = box.records[0]!;
        const entries = box.records.map((r, i) => this.#entry(r, i === 0 ? box.view : undefined));
        void this.#push(peer, id, first.seq - 1, entries);
      }
    }
  }

  async #push(peer: string, id: string, base: number, entries: Entry[]): Promise<void> {
    try {
      const link = await this.#o.transport.connect(peer);
      const r = await link.request<{ ok: boolean; reason?: string }>("sync.push", { stream: `${PREFIX}${id}`, base, entries });
      if (!r.ok && r.reason === "stale_base") await this.#resendFrom(peer, id);
    } catch {
      // An offline peer catches up when its link comes back.
    }
  }

  /** The peer holds another base: send it what it lacks, from this computer's history. */
  async #resendFrom(peer: string, id: string): Promise<void> {
    const pending = this.#resend.get(peer) ?? new Set<string>();
    if (pending.has(id)) return;
    pending.add(id);
    this.#resend.set(peer, pending);
    try {
      const link = await this.#o.transport.connect(peer);
      const stream = `${PREFIX}${id}`;
      const { heads } = await link.request<{ heads: Record<string, { seq: number }> }>("sync.heads", { streams: [stream] });
      let after = heads[stream]?.seq ?? -1;
      const view = this.#o.host.get(id);
      if (!view) return;
      for (;;) {
        const records = this.#o.host.history(id, { afterSeq: after, limit: BATCH });
        if (records.length === 0) break;
        const r = await link.request<{ ok: boolean }>("sync.push", { stream, base: after, entries: records.map((rec, i) => this.#entry(rec, i === 0 ? view : undefined)) });
        if (!r.ok) break;
        after = records.at(-1)!.seq;
      }
    } finally {
      pending.delete(id);
    }
  }

  #take(id: string, base: number, entries: Entry[], from: string): { ok: true; head: number } | { ok: false; reason: "stale_base" | "not_writer" | "refused" } {
    const head = this.#o.host.head(id);
    if (base !== head - 1) return { ok: false, reason: "stale_base" };
    if (entries.length === 0) return { ok: true, head: head - 1 };
    const known = this.#o.host.get(id);
    const view = known ?? entries[0]?.payload?.view;
    if (!view || view.id !== id) return { ok: false, reason: "refused" };
    // Only the computer running the session gives its records places.
    const writer = this.#o.registry.get(from)?.computer;
    const named = entries.find((e) => e.payload?.view)?.payload.view?.computer ?? view.computer;
    if (writer === undefined || named !== writer) return { ok: false, reason: "not_writer" };
    const records: SessionRecord[] = [];
    let next = head;
    for (const e of entries) {
      const r = e?.payload?.record;
      if (!r || r.sessionId !== id || r.seq !== next) return { ok: false, reason: "refused" };
      records.push(r);
      next++;
    }
    const late = records.some((r) => this.#o.isStale?.(r.epoch ?? 0) ?? false);
    const v = entries.find((e) => e.payload?.view)?.payload.view ?? view;
    this.#o.host.ingest(v, records, { from, late });
    return { ok: true, head: next - 1 };
  }

  #entry(record: SessionRecord, view: SessionView | undefined): Entry {
    return { seq: record.seq, epoch: record.epoch ?? 0, ts: record.ts, device: this.#o.self, payload: { record, ...(view ? { view } : {}) } };
  }

  #isComputer(id: string): boolean {
    const d = this.#o.registry.get(id);
    return d !== undefined && d.runsCore && d.revokedAt === undefined;
  }

  #mustBeComputer(id: string): void {
    if (!this.#isComputer(id)) throw new ContractError("refused", "only a paired computer syncs");
  }

  #log(line: string): void {
    this.#o.log?.(`[sync] ${line}`);
  }
}

function sessionOf(stream: unknown): string | undefined {
  return typeof stream === "string" && stream.startsWith(PREFIX) && stream.length > PREFIX.length ? stream.slice(PREFIX.length) : undefined;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
