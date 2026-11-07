// Sessions' records copied live between computers (D-M2's ask): the runner's records reach the others as they're
// written, so the computer that takes over finds the old runner's open turn and its started call without a restart;
// a computer that comes online later catches up; only the session's writer is taken, and records from an earlier
// lease arrive marked late. The host here is a stand-in with the shape lane D's `DurableSessionHost` takes.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionView } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { ContractError, Listeners } from "../../contracts/common";
import type { SessionRecord, SessionRecordBody } from "../../contracts/session-host";
import { makeLinkCluster } from "../../links/testing";
import { sameRecord, SessionRecordSync, type SessionHostForSync } from "../session-records";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

class MemoryHost implements SessionHostForSync {
  readonly sessions = new Map<string, { view: SessionView; records: SessionRecord[] }>();
  readonly ingested: { from: string; late: boolean; n: number }[] = [];
  readonly #taps = new Listeners<{ record: SessionRecord; view: SessionView }>();

  open(view: SessionView): void {
    this.sessions.set(view.id, { view, records: [] });
  }

  /** The bodies of a session's log, in order (what two copies compare). */
  bodies(id: string): string[] {
    return (this.sessions.get(id)?.records ?? []).map((r) => JSON.stringify({ ...r, late: undefined }));
  }

  record(id: string, body: SessionRecordBody, epoch = 1): SessionRecord {
    const s = this.sessions.get(id)!;
    const record = { ...body, seq: s.records.length, sessionId: id, ts: Date.now(), epoch } as SessionRecord;
    s.records.push(record);
    this.#taps.emit({ record, view: s.view });
    return record;
  }

  tap(fn: (e: { record: SessionRecord; view: SessionView }) => void) {
    return this.#taps.add(fn);
  }

  history(id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionRecord[] {
    const all = this.sessions.get(id)?.records ?? [];
    const from = (opts.afterSeq ?? -1) + 1;
    return all.slice(from, opts.limit === undefined ? undefined : from + opts.limit);
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view);
  }

  get(id: string): SessionView | undefined {
    return this.sessions.get(id)?.view;
  }

  head(id: string): number {
    return this.sessions.get(id)?.records.length ?? 0;
  }

  /** As lane D's host: a record at a held seq is skipped when it's the same, a different one is a fork (`conflict`),
   *  checked whole before anything is written. */
  ingest(view: SessionView, records: SessionRecord[], opts: { from: string; late: boolean }): void {
    const s = this.sessions.get(view.id) ?? { view, records: [] };
    for (const r of records) {
      const held = s.records[r.seq];
      if (held !== undefined && !sameRecord(held, r)) throw new ContractError("conflict", `a fork at ${r.seq}`);
    }
    s.view = view;
    const fresh = records.filter((r) => r.seq >= s.records.length).map((r) => (opts.late ? { ...r, late: true } : r) as SessionRecord);
    s.records.push(...fresh);
    this.sessions.set(view.id, s);
    if (fresh.length > 0) this.ingested.push({ from: opts.from, late: opts.late, n: fresh.length });
  }

  readonly asides: { id: string; from: string; records: SessionRecord[]; earlierId: string; delivered?: number }[] = [];
  setAside(id: string, fromSeq: number, opts: { from: string }): SessionRecord[] {
    const s = this.sessions.get(id)!;
    const out = s.records.splice(fromSeq);
    if (out.length > 0) this.asides.push({ id, from: opts.from, records: out, earlierId: `e${this.asides.length}` });
    return out;
  }
  earlier(id: string) {
    return this.asides.filter((a) => a.id === id).map((a) => ({ id: a.earlierId, ...(a.delivered !== undefined ? { delivered: a.delivered } : {}) }));
  }
  readEarlier(id: string, earlierId: string): SessionRecord[] {
    return this.asides.find((a) => a.id === id && a.earlierId === earlierId)?.records ?? [];
  }
  ackEarlier(id: string, earlierId: string): void {
    const a = this.asides.find((x) => x.id === id && x.earlierId === earlierId);
    if (a) a.delivered ??= Date.now();
  }

  /** As lane D's host: each record's body at the end, marked late, once per (from, seq). */
  readonly #lateSeen = new Set<string>();
  /** One of this computer's own turns runs: lane D refuses late records until it ends (typed, to be asked again). */
  busy = false;
  lateRefusals = 0;
  readonly lateRuns: (string | undefined)[] = [];
  appendLate(id: string, records: SessionRecord[], opts: { from: string; computer: string; earlierId?: string }): void {
    if (this.busy) {
      this.lateRefusals++;
      throw new ContractError("conflict", "a turn is running here: ask again once it ended");
    }
    this.lateRuns.push(opts.earlierId);
    const s = this.sessions.get(id)!;
    for (const r of records) {
      const k = `${opts.from}\u0000${r.seq}`;
      if (this.#lateSeen.has(k)) continue;
      this.#lateSeen.add(k);
      const { seq: _seq, sessionId: _sid, ts: _ts, epoch: _epoch, late: _late, ...body } = r as SessionRecord & { late?: boolean };
      this.record(id, { ...body, late: true, lateFrom: { device: opts.from, seq: r.seq } } as unknown as SessionRecordBody, 2);
    }
  }

  /** What lane D's `catchUp` looks for: a turn started and not ended, and its calls with no result. */
  openTurn(id: string): { on?: string; calls: string[] } | undefined {
    const recs = this.sessions.get(id)?.records ?? [];
    let start = -1;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (recs[i]!.type === "turn_ended") return undefined;
      if (recs[i]!.type === "turn_started") {
        start = i;
        break;
      }
    }
    if (start < 0) return undefined;
    const open = new Set<string>();
    for (const r of recs.slice(start + 1)) {
      if (r.type !== "driver") continue;
      const e = r.event as { type: string; callId?: string };
      if (e.type === "tool_call" && e.callId) open.add(e.callId);
      if (e.type === "tool_result" && e.callId) open.delete(e.callId);
    }
    return { on: this.sessions.get(id)!.view.computer, calls: [...open] };
  }
}

const view = (computer: string): SessionView => ({
  id: "b_alpha", kind: "bot", bot: "alpha", computer, title: "Alpha", status: "idle", model: "m", startedAt: Date.now(), updatedAt: Date.now(),
} as unknown as SessionView);

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function world(names: string[], opts: { stale?: (name: string, epoch: number) => boolean; holder?: () => string | null } = {}) {
  const c = await makeLinkCluster(names, { clock });
  stops.push(() => c.close());
  const hosts = new Map<string, MemoryHost>();
  for (const n of names) {
    const d = c.devices.get(n)!;
    const host = new MemoryHost();
    hosts.set(n, host);
    const sync = new SessionRecordSync({
      self: d.id, computer: () => n, transport: d.transport, registry: d.registry, host,
      ...(opts.stale ? { isStale: (e: number) => opts.stale!(n, e) } : {}),
      ...(opts.holder ? { holder: opts.holder } : {}),
      lateRetryMs: 50,
    });
    stops.push(() => sync.close());
  }
  return { c, hosts, h: (n: string) => hosts.get(n)! };
}

describe("sessions' records across computers", () => {
  test("the runner's records reach the others live; the takeover computer finds the open turn and its started call", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.c.devices.get("Studio")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "input", input: { from: "user", text: "deploy it", sentAt: Date.now(), device: "d" }, disposition: "turn" } as unknown as SessionRecordBody);
    studio.record("b_alpha", { type: "turn_started", origin: "user" });
    // The call's start syncs before the call runs (§6.4).
    studio.record("b_alpha", { type: "driver", event: { type: "tool_call", callId: "call_1", tool: "Bash" } });
    await waitFor(() => w.h("Laptop").head("b_alpha") === 3);
    // The studio goes away mid-call; the laptop, without a restart, holds what lane D's catchUp needs.
    w.c.net.partition(w.c.devices.get("Studio")!.key.publicKey);
    expect(w.h("Laptop").openTurn("b_alpha")).toEqual({ on: "Studio", calls: ["call_1"] });
  });

  test("a computer whose link comes up later catches up from the runner's history", async () => {
    const w = await world(["Studio", "Laptop"]);
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    for (let i = 0; i < 1203; i++) studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: `chunk ${i}` } });
    await w.c.devices.get("Laptop")!.transport.connect(w.c.devices.get("Studio")!.id);
    await waitFor(() => w.h("Laptop").head("b_alpha") === 1203);
    expect(w.h("Laptop").history("b_alpha", { afterSeq: 1201 })[0]).toMatchObject({ seq: 1202 });
    // And live again after that.
    studio.record("b_alpha", { type: "turn_ended", end: { reason: "end_turn" } });
    await waitFor(() => w.h("Laptop").head("b_alpha") === 1204);
  });

  test("only the computer running a session gives its records places", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.c.devices.get("Server")!.transport.connect(w.c.devices.get("Laptop")!.id);
    // The server claims a session the studio runs.
    const link = await w.c.devices.get("Server")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const r = await link.request<{ ok: boolean; reason?: string }>("sync.push", {
      stream: "transcript:b_alpha", base: -1,
      entries: [{ seq: 0, epoch: 1, ts: Date.now(), device: "x", payload: { record: { type: "turn_started", origin: "user", seq: 0, sessionId: "b_alpha", ts: Date.now() }, view: view("Studio") } }],
    });
    expect(r).toEqual({ ok: false, reason: "not_writer" });
    expect(w.h("Laptop").head("b_alpha")).toBe(0);
  });

  test("for a session it knows, the writer comes from its own view: a peer naming itself in the view is refused (check 2, S1)", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.c.devices.get("Studio")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "turn_started", origin: "user" });
    await waitFor(() => w.h("Laptop").head("b_alpha") === 1);
    const link = await w.c.devices.get("Server")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const r = await link.request<{ ok: boolean; reason?: string }>("sync.push", {
      stream: "transcript:b_alpha", base: 0,
      entries: [{ seq: 1, epoch: 1, ts: Date.now(), device: "x", payload: { record: { type: "input", input: { from: "user", text: "forged", sentAt: Date.now(), device: "d" }, disposition: "turn", seq: 1, sessionId: "b_alpha", ts: Date.now() }, view: view("Server") } }],
    });
    expect(r).toEqual({ ok: false, reason: "not_writer" });
    expect(w.h("Laptop").head("b_alpha")).toBe(1);
    expect(w.h("Laptop").get("b_alpha")?.computer).toBe("Studio");
  });

  test("a bot's conversation moves to the lease holder, and only to it; a side thread never follows the lease (check 3)", async () => {
    let holder: string | null = null;
    const w = await world(["Studio", "Laptop", "Server", "Mini"], { holder: () => holder });
    const id = (n: string) => w.c.devices.get(n)!.id;
    holder = id("Server");
    await w.c.devices.get("Studio")!.transport.connect(id("Laptop"));
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "turn_started", origin: "user" });
    const side = { ...view("Studio"), id: "s_routine", kind: "side-thread", parent: "b_alpha" } as unknown as SessionView;
    studio.open(side);
    studio.record("s_routine", { type: "turn_started", origin: "routine" });
    await waitFor(() => w.h("Laptop").head("b_alpha") === 1 && w.h("Laptop").head("s_routine") === 1);
    const push = async (from: string, session: string, v: SessionView) => {
      const link = await w.c.devices.get(from)!.transport.connect(id("Laptop"));
      return link.request<{ ok: boolean; reason?: string; head?: number }>("sync.push", {
        stream: `transcript:${session}`, base: 0,
        entries: [{ seq: 1, epoch: 2, ts: Date.now(), device: id(from), payload: { record: { type: "turn_started", origin: "user", seq: 1, sessionId: session, ts: Date.now() }, view: v } }],
      });
    };
    // A computer that doesn't hold the lease is refused, whatever its view says.
    expect(await push("Mini", "b_alpha", view("Mini"))).toEqual({ ok: false, reason: "not_writer" });
    expect(w.h("Laptop").get("b_alpha")?.computer).toBe("Studio");
    // A side thread stays on its routine's computer, even for the lease holder.
    expect(await push("Server", "s_routine", { ...side, computer: "Server" } as SessionView)).toEqual({ ok: false, reason: "not_writer" });
    expect(w.h("Laptop").get("s_routine")?.computer).toBe("Studio");
    // The holder takes the bot over: accepted, and the bot now runs there.
    expect(await push("Server", "b_alpha", view("Server"))).toEqual({ ok: true, head: 1 });
    expect(w.h("Laptop").get("b_alpha")?.computer).toBe("Server");
  });

  test("records from an earlier lease arrive marked late", async () => {
    const w = await world(["Studio", "Laptop"], { stale: (n, e) => n === "Laptop" && e < 2 });
    await w.c.devices.get("Studio")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "turn_started", origin: "user" }, 1);
    await waitFor(() => w.h("Laptop").ingested.length === 1);
    expect(w.h("Laptop").ingested[0]).toMatchObject({ late: true, from: w.c.devices.get("Studio")!.id });
  });

  test("records from an earlier lease in one batch: only those are marked late", async () => {
    const w = await world(["Studio", "Laptop"], { stale: (n, e) => n === "Laptop" && e < 2 });
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "turn_started", origin: "user" }, 1);
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "a" } }, 2);
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "b" } }, 2);
    await w.c.devices.get("Laptop")!.transport.connect(w.c.devices.get("Studio")!.id);
    await waitFor(() => w.h("Laptop").head("b_alpha") === 3);
    const late = w.h("Laptop").history("b_alpha").map((r) => (r as { late?: boolean }).late === true);
    expect(late).toEqual([true, false, false]);
  });
});

describe("forks: two computers that wrote the same place", () => {
  /** Ten records both hold, written by the laptop (the main now) and copied to the studio. */
  async function shared() {
    const w = await world(["Studio", "Laptop"], { holder: () => null });
    const studioDev = w.c.devices.get("Studio")!;
    const laptopDev = w.c.devices.get("Laptop")!;
    await laptopDev.transport.connect(studioDev.id);
    w.h("Laptop").open(view("Laptop"));
    for (let i = 0; i < 10; i++) w.h("Laptop").record("b_alpha", { type: "driver", event: { type: "assistant_text", text: `shared ${i}` } }, 1);
    await waitFor(() => w.h("Studio").head("b_alpha") === 10);
    // Apart: each writes its own.
    w.c.net.partition(studioDev.key.publicKey, laptopDev.key.publicKey);
    await waitFor(() => !laptopDev.transport.links().some((l) => l.peer === studioDev.id && l.up));
    return { w, studioDev, laptopDev };
  }

  /** The link back after a heal (the dialler may still be backing off). */
  async function reconnect(from: { transport: { connect(id: string): Promise<unknown> } }, to: { id: string }): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await from.transport.connect(to.id);
        return;
      } catch (e) {
        if (i > 100) throw e;
        await Bun.sleep(50);
      }
    }
  }

  test("A10, A11 then B12: the old main's own records are set aside, never mixed under the main's; they reach the main, appended late", async () => {
    const { w, studioDev, laptopDev } = await shared();
    const studio = w.h("Studio");
    const laptop = w.h("Laptop");
    // The studio, the old main, kept writing (A10, A11); the laptop, the main now, wrote 10, 11 and 12 (B).
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "A10" } }, 1);
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "A11" } }, 1);
    for (const t of ["B10", "B11", "B12"]) laptop.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: t } }, 2);
    // Together again.
    w.c.net.heal(studioDev.key.publicKey, laptopDev.key.publicKey);
    await reconnect(laptopDev, studioDev);
    // The laptop's log: its own, then the studio's two at the end, marked late; the studio's copy is the same log.
    await waitFor(() => laptop.head("b_alpha") === 15 && studio.head("b_alpha") === 15, 10_000);
    const texts = (h: MemoryHost) => h.history("b_alpha").map((r) => (r as { event?: { text?: string } }).event?.text);
    expect(texts(laptop).slice(10)).toEqual(["B10", "B11", "B12", "A10", "A11"]);
    expect(laptop.history("b_alpha").slice(13).every((r) => (r as { late?: boolean }).late === true)).toBe(true);
    expect(studio.bodies("b_alpha")).toEqual(laptop.bodies("b_alpha"));
    expect(laptop.lateRuns).toEqual(["e0"]); // the run's id travels with it
    expect(studio.asides).toEqual([{ id: "b_alpha", from: laptopDev.id, earlierId: "e0", delivered: expect.any(Number), records: [expect.objectContaining({ seq: 10 }), expect.objectContaining({ seq: 11 })] }]);
    // Live after that, on the one log.
    laptop.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "B15" } }, 2);
    await waitFor(() => studio.head("b_alpha") === 16);
    expect(studio.bodies("b_alpha")).toEqual(laptop.bodies("b_alpha"));
  });

  test("a computer that holds more than the main: the heads exchange finds it, and its own records go to the main, late", async () => {
    const { w, studioDev, laptopDev } = await shared();
    const studio = w.h("Studio");
    const laptop = w.h("Laptop");
    // Only the studio wrote while apart (the main wrote nothing).
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "A10" } }, 1);
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "A11" } }, 1);
    w.c.net.heal(studioDev.key.publicKey, laptopDev.key.publicKey);
    await reconnect(studioDev, laptopDev);
    await waitFor(() => laptop.head("b_alpha") === 12 && studio.head("b_alpha") === 12, 10_000);
    expect(laptop.history("b_alpha").slice(10).map((r) => [(r as { event?: { text?: string } }).event?.text, (r as { late?: boolean }).late])).toEqual([["A10", true], ["A11", true]]);
    expect(studio.bodies("b_alpha")).toEqual(laptop.bodies("b_alpha"));
  });

  test("the same records on both sides are no fork: the overlap is skipped", async () => {
    const { w, studioDev, laptopDev } = await shared();
    w.c.net.heal(studioDev.key.publicKey, laptopDev.key.publicKey);
    w.h("Laptop").record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "B10" } }, 2);
    await reconnect(laptopDev, studioDev);
    await waitFor(() => w.h("Studio").head("b_alpha") === 11);
    expect(w.h("Studio").asides).toEqual([]);
    expect(w.h("Studio").bodies("b_alpha")).toEqual(w.h("Laptop").bodies("b_alpha"));
  });

  test("the main is in the middle of its own turn: its refusal is asked again, and the records arrive once the turn ended", async () => {
    const { w, studioDev, laptopDev } = await shared();
    const studio = w.h("Studio");
    const laptop = w.h("Laptop");
    studio.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "A10" } }, 1);
    laptop.record("b_alpha", { type: "driver", event: { type: "assistant_text", text: "B10" } }, 2);
    laptop.busy = true;
    w.c.net.heal(studioDev.key.publicKey, laptopDev.key.publicKey);
    await reconnect(laptopDev, studioDev);
    await waitFor(() => laptop.lateRefusals >= 2, 10_000); // asked, refused, asked again
    expect(laptop.head("b_alpha")).toBe(11);
    expect(studio.asides[0]?.delivered).toBeUndefined();
    laptop.busy = false;
    await waitFor(() => laptop.head("b_alpha") === 12 && studio.head("b_alpha") === 12, 10_000);
    expect((laptop.history("b_alpha")[11] as { event?: { text?: string }; late?: boolean })).toMatchObject({ event: { text: "A10" }, late: true });
    expect(studio.asides[0]?.delivered).toEqual(expect.any(Number));
  }, 20_000);
});
