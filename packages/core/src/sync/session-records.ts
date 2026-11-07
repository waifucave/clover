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
// * **Forks** (the controller's ruling; D's reviewer): two computers that each wrote a session's log at the same place
//   (an old main that kept writing, a computer that ran a bot before it paired) hold two different logs. Every push and
//   pull starts at the receiver's last held record, one record overlapping, so lane D's `ingest` compares it and
//   refuses a different one (`conflict`); the heads exchange compares the epoch at the writer's head too, for a
//   receiver that holds more than the writer. On a fork, the computer that isn't the writer walks back to where the
//   logs part, sets its own records from there aside (`setAside`), and takes the writer's; the set-aside records go to
//   the writer (`sync.push` with `late`), which appends them at the end of its log, marked late (`appendLate`). The
//   host keeps what it set aside (`earlier`) until the writer has it (`ackEarlier`): what a restart or a lost link left
//   undelivered goes again when the sync starts and whenever a link comes up (the writer adds nothing twice). A log
//   is never mixed: no computer ends up with the old main's records under the new main's.
// * **Late, per record:** in a batch, only the records from an earlier lease are marked late.
import type { SessionView } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { SessionRecord } from "../contracts/session-host";
import type { FileDeviceRegistry } from "../devices/registry";
import { mountSyncStreams } from "./streams";

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
  /** Records at seqs this computer holds already are compared: the same one is skipped, a different one throws
   *  `conflict` (a fork) and nothing is written. */
  ingest(view: SessionView, records: SessionRecord[], opts: { from: string; late: boolean }): void;
  /** A fork, on a computer that doesn't run the session: its records from `fromSeq` on leave the log (kept aside) and
   *  are returned; the head becomes `fromSeq`. */
  setAside(id: string, fromSeq: number, opts: { from: string }): SessionRecord[];
  /** On the computer running the session: another computer's set-aside records, appended at the end marked late.
   *  The same records again add nothing. */
  appendLate(id: string, records: SessionRecord[], opts: { from: string; computer: string }): unknown;
  /** What this computer set aside for a session, and whether the writer has it yet. */
  earlier(id: string): { id: string; delivered?: number }[];
  readEarlier(id: string, earlierId: string): SessionRecord[];
  /** The writer has these: they aren't sent again. */
  ackEarlier(id: string, earlierId: string): void;
}

export type SessionHostForSync = SessionRecordSource & SessionRecordSink;

export interface SessionRecordSyncOptions {
  self: string;
  /** This computer's tree name: the `computer` a session it runs names. */
  computer(): string;
  transport: Pick<LinkTransport, "connect" | "handle" | "links" | "watch">;
  registry: Pick<FileDeviceRegistry, "get" | "list">;
  host: SessionHostForSync;
  /** The device that holds the lease now (lease.ts `state().holder`): after a takeover or a hand-back it runs the bots,
   *  so this computer takes a known session's records from it, as its own view moves to it. */
  holder?(): string | null;
  /** The lease's fencing token, (scope, epoch) (lease.ts `isStale`). */
  isStale?(epoch: number, scope?: string): boolean;
  /** The lease record this computer is on (lease.ts `scopeId`): stamped on what it sends, beside each record's epoch. */
  scope?(): string;
  /** The first wait before set-aside records the writer couldn't take are sent again (default 1 s, doubling to a
   *  minute). */
  lateRetryMs?: number;
  log?(line: string): void;
}

type Entry = { seq: number; epoch: number; scope?: string; ts: number; device: string; payload: { record: SessionRecord; view?: SessionView } };

export class SessionRecordSync {
  readonly #o: SessionRecordSyncOptions;
  readonly #offs: Unsubscribe[] = [];
  /** Records waiting to go out, per session: pushed together at the end of the tick. */
  readonly #outbox = new Map<string, { view: SessionView; records: SessionRecord[] }>();
  #flushing = false;
  /** Per peer, sessions whose push needs a resend from history. */
  readonly #resend = new Map<string, Set<string>>();
  /** Sessions whose fork is being resolved now. */
  readonly #forking = new Set<string>();
  /** Sessions whose set-aside records are being sent now. */
  readonly #sendingLate = new Set<string>();

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
    // The sync methods carry other streams too (a bot's memory, `memory.ts`): this owns `transcript:…` (streams.ts).
    this.#offs.push(mountSyncStreams(t, PREFIX, {
      heads: ({ streams: names }, from) => {
        this.#mustBeComputer(from);
        const heads: Record<string, { seq: number; epoch: number }> = {};
        for (const v of o.host.list()) {
          const stream = `${PREFIX}${v.id}`;
          if (names && !names.has(stream)) continue;
          const n = o.host.head(v.id);
          if (n === 0) continue;
          const last = o.host.history(v.id, { afterSeq: n - 2, limit: 1 })[0];
          heads[stream] = { seq: n - 1, epoch: last?.epoch ?? 0 };
        }
        return heads;
      },
      pull: (raw, from) => {
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
      },
      push: (raw, from) => {
        this.#mustBeComputer(from);
        const p = raw as { stream?: unknown; base?: unknown; entries?: unknown; head?: unknown; late?: unknown } | undefined;
        const id = sessionOf(p?.stream);
        if (p?.late === true && id && Array.isArray(p.entries)) return this.#takeLate(id, p.entries as Entry[], from);
        if (!id || typeof p?.base !== "number" || !Array.isArray(p.entries)) throw new ContractError("invalid", "sync.push: bad params");
        return this.#take(id, p.base, p.entries as Entry[], from, typeof p.head === "number" ? p.head : undefined);
      },
    }));
    // A link coming up: catch up from that computer, and offer it what this one writes.
    const up = new Set<string>();
    this.#offs.push(t.watch((v) => {
      if (v.up && !up.has(v.peer)) {
        up.add(v.peer);
        if (this.#isComputer(v.peer)) {
          void this.catchUpFrom(v.peer).catch((e: unknown) => this.#log(`catching up from ${v.peer}: ${errText(e)}`));
          void this.#sendAllLate();
        }
      } else if (!v.up) up.delete(v.peer);
    }));
    // What an earlier run set aside and couldn't deliver goes now (when the writer is reachable).
    queueMicrotask(() => void this.#sendAllLate());
  }

  /** Every session's set-aside records the writer doesn't have yet (at start, and when a link comes up). */
  async #sendAllLate(): Promise<void> {
    for (const v of this.#o.host.list()) {
      if (this.#o.host.earlier(v.id).some((e) => e.delivered === undefined)) await this.#sendLate(v.id);
    }
  }

  /** Pulls what `peer` holds beyond this computer's copies. */
  async catchUpFrom(peer: string): Promise<number> {
    const link = await this.#o.transport.connect(peer);
    const { heads } = await link.request<{ heads: Record<string, { seq: number; epoch: number }> }>("sync.heads", { prefixes: [PREFIX] });
    let taken = 0;
    for (const [stream, head] of Object.entries(heads)) {
      const id = sessionOf(stream);
      if (!id) continue;
      // This computer holds more than the writer: the record at the writer's head tells whether it's the same log
      // (the epoch first, then the record itself); what follows it here is this computer's own, a fork.
      const have = this.#o.host.head(id);
      if (have > 0 && head.seq < have - 1) {
        if (this.#writerView(id, peer) === undefined) continue;
        const mine = this.#o.host.history(id, { afterSeq: head.seq - 1, limit: 1 })[0];
        let same = mine !== undefined && (mine.epoch ?? 0) === head.epoch;
        if (same) {
          const theirs = await link.request<{ entries: Entry[] }>("sync.pull", { stream, after: head.seq - 1, limit: 1 });
          same = sameRecord(mine, theirs.entries[0]?.payload?.record);
        }
        await this.#resolveFork(peer, id, same ? head.seq + 1 : head.seq, same);
        continue;
      }
      for (;;) {
        const have = this.#o.host.head(id);
        // Even at the same length, the last record is compared: two logs of one length can still differ there.
        if (head.seq < have - 1) break;
        // From the last record held here, so the first one overlaps and a fork shows.
        const after = Math.max(-1, have - 2);
        const page = await link.request<{ entries: Entry[]; more: boolean }>("sync.pull", { stream, after, limit: BATCH });
        if (page.entries.length === 0) break;
        const r = this.#take(id, after, page.entries, peer);
        if (!r.ok) {
          if (r.reason === "fork") await this.#forkDone(id);
          break;
        }
        taken += Math.max(0, r.head - have + 1);
        if (!page.more) break;
      }
    }
    return taken;
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#lateTries.values()) if (t.timer) clearTimeout(t.timer);
    this.#lateTries.clear();
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
        void this.#push(peer, id, first.seq - 1, entries, box.records.at(-1)!.seq);
      }
    }
  }

  async #push(peer: string, id: string, base: number, entries: Entry[], head: number): Promise<void> {
    try {
      const link = await this.#o.transport.connect(peer);
      const r = await link.request<{ ok: boolean; reason?: string }>("sync.push", { stream: `${PREFIX}${id}`, base, entries, head });
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
      const view = this.#o.host.get(id);
      if (!view) return;
      const last = this.#o.host.head(id) - 1;
      // From the peer's last record (or this computer's, if the peer holds more), one record overlapping: a fork shows
      // there, and the peer's own records past this computer's head show as its being ahead (`head`).
      let after = Math.min(heads[stream]?.seq ?? -1, last) - 1;
      for (;;) {
        const records = this.#o.host.history(id, { afterSeq: Math.max(-1, after), limit: BATCH });
        if (records.length === 0) break;
        const r = await link.request<{ ok: boolean }>("sync.push", { stream, base: Math.max(-1, after), head: last, entries: records.map((rec, i) => this.#entry(rec, i === 0 ? view : undefined)) });
        if (!r.ok) break;
        after = records.at(-1)!.seq;
      }
    } finally {
      pending.delete(id);
    }
  }

  /** The view to take `from`'s records under, when `from` may write the session: the computer the session names as
   *  running it, or the lease holder a bot's conversation moves to. */
  #writerView(id: string, from: string, offered?: SessionView): SessionView | undefined {
    const known = this.#o.host.get(id);
    const view = known ?? offered;
    if (!view || view.id !== id) return undefined;
    // Only the computer running the session gives its records places. For a session this computer knows, which one
    // that is comes from its own view, never from what the sender says (H-M2's check 2): the runner changes only
    // through the lease or a hand-back. Only a bot's main conversation follows the lease (spec §6.4 "The computer
    // running a session"); a side thread stays on its routine's computer and an agent on its own (check 3).
    const writer = this.#o.registry.get(from)?.computer;
    const named = known ? known.computer : view.computer;
    const moved = known !== undefined && known.kind === "bot" && writer !== undefined && named !== writer && this.#o.holder?.() === from;
    if (writer === undefined || (named !== writer && !moved)) return undefined;
    // A peer's view never rewrites a known session's (its runner, its title); only a new session takes the sender's.
    return known ? (moved ? { ...known, computer: writer } : known) : view;
  }

  #take(id: string, base: number, entries: Entry[], from: string, senderHead?: number): { ok: true; head: number } | { ok: false; reason: "stale_base" | "not_writer" | "refused" | "fork" } {
    const head = this.#o.host.head(id);
    // Entries may start at or before this computer's last record (they overlap, and the host compares them), never
    // after it.
    if (base > head - 1 || base < -1) return { ok: false, reason: "stale_base" };
    if (entries.length === 0) return { ok: true, head: head - 1 };
    if (this.#forking.has(id)) return { ok: false, reason: "fork" };
    const v = this.#writerView(id, from, entries.find((e) => e?.payload?.view)?.payload.view);
    if (v === undefined) return this.#o.host.get(id) || entries[0]?.payload?.view ? { ok: false, reason: "not_writer" } : { ok: false, reason: "refused" };
    const records: SessionRecord[] = [];
    const late: boolean[] = [];
    let next = base + 1;
    for (const e of entries) {
      const r = e?.payload?.record;
      if (!r || r.sessionId !== id || r.seq !== next) return { ok: false, reason: "refused" };
      records.push(r);
      late.push(this.#o.isStale?.(r.epoch ?? 0, typeof e.scope === "string" ? e.scope : undefined) ?? false);
      next++;
    }
    try {
      // Only the records from an earlier lease are marked late: the batch goes in as runs of the same mark.
      for (let i = 0; i < records.length;) {
        let j = i + 1;
        while (j < records.length && late[j] === late[i]) j++;
        this.#o.host.ingest(v, records.slice(i, j), { from, late: late[i]! });
        i = j;
      }
    } catch (e) {
      if (!(e instanceof ContractError && e.code === "conflict")) throw e;
      // A fork: the logs differ at or before the last record both hold.
      void this.#resolveFork(from, id, Math.min(head - 1, next - 1), false);
      return { ok: false, reason: "fork" };
    }
    const now = this.#o.host.head(id) - 1;
    // The writer's log ends before this one: what this computer holds past it is its own (it matched up to there).
    if (senderHead !== undefined && senderHead === next - 1 && now > senderHead) {
      void this.#resolveFork(from, id, senderHead + 1, true);
      return { ok: false, reason: "fork" };
    }
    return { ok: true, head: now };
  }

  /** Resolves a fork with `peer`, the session's writer: walks back from `at` to where the two logs part (unless
   *  `known`: they part exactly at `at`), sets this computer's records from there aside, takes the writer's, and sends
   *  the set-aside records to the writer, to be appended there marked late. */
  async #resolveFork(peer: string, id: string, at: number, known: boolean): Promise<void> {
    if (this.#forking.has(id)) return;
    this.#forking.add(id);
    const done = Promise.withResolvers<void>();
    this.#forks.set(id, done.promise);
    try {
      const stream = `${PREFIX}${id}`;
      const link = await this.#o.transport.connect(peer);
      let from = known ? at : at + 1;
      if (!known) {
        // The last seq where both hold the same record; everything after it is the fork.
        let hi = Math.min(at, this.#o.host.head(id) - 1);
        walk: while (hi >= 0) {
          const lo = Math.max(0, hi - BATCH + 1);
          const theirs = (await link.request<{ entries: Entry[] }>("sync.pull", { stream, after: lo - 1, limit: hi - lo + 1 })).entries.map((e) => e?.payload?.record);
          const mine = this.#o.host.history(id, { afterSeq: lo - 1, limit: hi - lo + 1 });
          for (let seq = hi; seq >= lo; seq--) {
            if (sameRecord(mine[seq - lo], theirs[seq - lo])) break walk;
            from = seq;
          }
          hi = lo - 1;
        }
      }
      const aside = this.#o.host.setAside(id, from, { from: peer });
      this.#log(`session ${id}: its log here parted from ${peer}'s at ${from}; ${aside.length} record(s) set aside for the computer running it`);
      this.#forking.delete(id);
      // The writer's records from there.
      for (;;) {
        const have = this.#o.host.head(id);
        const page = await link.request<{ entries: Entry[]; more: boolean }>("sync.pull", { stream, after: have - 1, limit: BATCH });
        if (page.entries.length === 0) break;
        const r = this.#take(id, have - 1, page.entries, peer);
        if (!r.ok || !page.more) break;
      }
      await this.#sendLate(id);
    } catch (e) {
      this.#log(`session ${id}: resolving a fork with ${peer}: ${errText(e)}`);
    } finally {
      this.#forking.delete(id);
      this.#forks.delete(id);
      done.resolve();
    }
  }

  readonly #forks = new Map<string, Promise<void>>();

  /** Waits for a fork being resolved for `id`, if one is. */
  async #forkDone(id: string): Promise<void> {
    await this.#forks.get(id);
  }

  /** Sends a session's set-aside records the writer doesn't have yet to the computer running it, each batch acked
   *  once it took them. What it can't take now (its own turn running: lane D refuses then, to be asked again; or no
   *  link) is tried again on the next link and on a timer, backing off to a minute. */
  async #sendLate(id: string): Promise<void> {
    if (this.#sendingLate.has(id) || this.#closed) return;
    this.#sendingLate.add(id);
    let again = false;
    try {
      for (const e of this.#o.host.earlier(id)) {
        if (e.delivered !== undefined) continue;
        const view = this.#o.host.get(id);
        if (!view) return;
        const records = this.#o.host.readEarlier(id, e.id);
        if (records.length > 0) {
          if (view.computer === this.#o.computer()) {
            // This computer runs it now: its own set-aside records go at the end of its own log.
            this.#o.host.appendLate(id, records, { from: this.#o.self, computer: this.#o.computer() });
          } else {
            const runner = this.#o.registry.list().find((d) => d.computer === view.computer && d.runsCore && d.revokedAt === undefined);
            if (!runner) return;
            const link = await this.#o.transport.connect(runner.id);
            const r = await link.request<{ ok: boolean }>("sync.push", { stream: `${PREFIX}${id}`, late: true, entries: records.map((rec) => this.#entry(rec, undefined)) });
            if (!r.ok) {
              again = true;
              return;
            }
          }
        }
        this.#o.host.ackEarlier(id, e.id);
      }
      this.#lateTries.delete(id);
    } catch {
      again = true;
    } finally {
      this.#sendingLate.delete(id);
      if (again) this.#retryLate(id);
    }
  }

  /** Per session, how many times its set-aside records were tried, and the timer for the next. */
  readonly #lateTries = new Map<string, { n: number; timer?: ReturnType<typeof setTimeout> }>();
  #closed = false;

  #retryLate(id: string): void {
    if (this.#closed) return;
    const t = this.#lateTries.get(id) ?? { n: 0 };
    if (t.timer) return;
    t.n++;
    t.timer = setTimeout(() => {
      t.timer = undefined;
      void this.#sendLate(id);
    }, Math.min(60_000, (this.#o.lateRetryMs ?? 1_000) * 2 ** Math.min(t.n - 1, 6)));
    (t.timer as { unref?: () => void }).unref?.();
    this.#lateTries.set(id, t);
  }

  /** Another computer's set-aside records for a session this computer runs: appended at the end, marked late. */
  #takeLate(id: string, entries: Entry[], from: string): { ok: boolean; reason?: string } {
    const view = this.#o.host.get(id);
    if (!view) return { ok: false, reason: "refused" };
    if (view.computer !== this.#o.computer()) return { ok: false, reason: "not_runner" };
    const records: SessionRecord[] = [];
    for (const e of entries) {
      const r = e?.payload?.record;
      if (!r || r.sessionId !== id) return { ok: false, reason: "refused" };
      records.push(r);
    }
    const computer = this.#o.registry.get(from)?.computer;
    if (computer === undefined) return { ok: false, reason: "refused" };
    try {
      this.#o.host.appendLate(id, records, { from, computer });
    } catch (e) {
      // Not now (lane D refuses while one of this computer's own turns runs): the sender asks again.
      if (e instanceof ContractError) return { ok: false, reason: e.code };
      throw e;
    }
    return { ok: true };
  }

  #entry(record: SessionRecord, view: SessionView | undefined): Entry {
    const scope = this.#o.scope?.();
    return { seq: record.seq, epoch: record.epoch ?? 0, ...(scope ? { scope } : {}), ts: record.ts, device: this.#o.self, payload: { record, ...(view ? { view } : {}) } };
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

/** What a copy adds to a record that isn't the record (lane D's host: `late`, and `copiedFrom` on every copy). */
const IGNORED = new Set(["late", "copiedFrom"]);

/** The same record, whatever its `late` and `copiedFrom` marks. */
export function sameRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => !IGNORED.has(k) && (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => !IGNORED.has(k) && (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameRecord((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
