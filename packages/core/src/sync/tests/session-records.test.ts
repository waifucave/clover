// Sessions' records copied live between computers (D-M2's ask): the runner's records reach the others as they're
// written, so the computer that takes over finds the old runner's open turn and its started call without a restart;
// a computer that comes online later catches up; only the session's writer is taken, and records from an earlier
// lease arrive marked late. The host here is a stand-in with the shape lane D's `DurableSessionHost` takes.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionView } from "@waifucave/clover-protocol";
import { SystemClock } from "../../clock/system-clock";
import { Listeners } from "../../contracts/common";
import type { SessionRecord, SessionRecordBody } from "../../contracts/session-host";
import { makeLinkCluster } from "../../links/testing";
import { SessionRecordSync, type SessionHostForSync } from "../session-records";

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

  ingest(view: SessionView, records: SessionRecord[], opts: { from: string; late: boolean }): void {
    const s = this.sessions.get(view.id) ?? { view, records: [] };
    s.view = view;
    s.records.push(...records);
    this.sessions.set(view.id, s);
    this.ingested.push({ from: opts.from, late: opts.late, n: records.length });
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

async function world(names: string[], opts: { stale?: (name: string, epoch: number) => boolean } = {}) {
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

  test("records from an earlier lease arrive marked late", async () => {
    const w = await world(["Studio", "Laptop"], { stale: (n, e) => n === "Laptop" && e < 2 });
    await w.c.devices.get("Studio")!.transport.connect(w.c.devices.get("Laptop")!.id);
    const studio = w.h("Studio");
    studio.open(view("Studio"));
    studio.record("b_alpha", { type: "turn_started", origin: "user" }, 1);
    await waitFor(() => w.h("Laptop").ingested.length === 1);
    expect(w.h("Laptop").ingested[0]).toMatchObject({ late: true, from: w.c.devices.get("Studio")!.id });
  });
});
