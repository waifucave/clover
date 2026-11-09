// The API's areas over other lanes' services, through the real capability gate, with small fakes of each service: the
// grant each call needs, the caller each acts as, a service that isn't running, and a terminal that is its opener's.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { areasApi, areasParts, noteLabel, REPLAY_MAX, WATCHES_PER_PLUGIN, type AreaServices } from "../api/areas";
import { createApiRouter } from "../api/router";

const USER: Caller = { kind: "user", client: "app" };
const record = (id: string, granted: string[]) => ({ id, enabled: true, state: "running", granted, capabilities: granted }) as never;

function world(o: { granted?: string[]; running?: boolean; length?: number; records?: unknown[]; transients?: { type: string }[]; noApp?: boolean; exitsOnOpen?: boolean; historyThrows?: boolean } = {}) {
  const delivered: unknown[] = [];
  const treeCalls: unknown[] = [];
  const written: unknown[] = [];
  const emitted: unknown[] = [];
  const outputs = new Set<(o: { terminalId: string; data: string; exited?: { code: number | null } }) => void>();
  const subscribers = new Set<(r: unknown) => void>();
  const closed: string[] = [];
  const opened: unknown[] = [];
  const grepped: unknown[] = [];
  const sessions = [{ id: "s_1", kind: "code" }, { id: "s_2", kind: "bot", bot: "luna" }];
  const services: AreaServices = {
    bots: () => o.running === false ? undefined : ({
      host: {
        list: () => sessions, get: (id: string) => sessions.find((s) => s.id === id),
        deliver: async (id: string, input: unknown) => (delivered.push({ id, input }), { seq: 1 }),
        history: (_id: string, q: { afterSeq: number; limit: number }) => o.historyThrows ? (() => { throw new Error("the log is unreadable"); })() : (o.records ?? []).filter((r) => (r as { seq: number }).seq > q.afterSeq).slice(0, q.limit),
        length: () => o.length ?? (o.records?.length ?? 0),
        subscribe: (_id: string, fn: (r: unknown) => void) => (subscribers.add(fn), () => subscribers.delete(fn)),
        onTransient: (_id: string, fn: (e: { type: string }) => void) => { for (const e of o.transients ?? []) fn(e); return () => {}; },
      },
      bots: { has: (id: string) => id === "luna", list: () => [{ id: "luna" }], get: (id: string) => (id === "luna" ? { id: "luna" } : undefined), onEvent: () => () => {} },
    }) as never,
    node: () => ({
      registry: { list: () => [{ name: "Studio" }], get: (n: string) => (n === "Studio" ? { name: "Studio" } : undefined), watch: () => () => {} },
      holds: {},
      tree: {
        stat: async (path: string, opts: { as: Caller }) => (treeCalls.push({ path, as: opts.as }), null),
        grepAll: async (_p: string, opts: unknown) => (grepped.push(opts), []),
        watch: async () => () => {},
      },
      terminals: {
        open: async (p: unknown, as: Caller) => {
          treeCalls.push({ open: as });
          opened.push(p);
          const terminalId = `t_${opened.length}`;
          // A shell that exits before the open returns (and another terminal's output meanwhile).
          if (o.exitsOnOpen) for (const fn of [...outputs]) { fn({ terminalId: "t_other", data: "x" }); fn({ terminalId, data: "gone\r\n", exited: { code: 1 } }); }
          return { terminalId };
        },
        write: async (id: string, data: string, opts?: { paste?: boolean }) => void written.push({ id, data, ...opts }),
        resize: async (id: string, cols: number, rows: number) => void opened.push({ resize: [id, cols, rows] }), close: async (id: string) => void closed.push(id),
        onOutput: (fn: never) => (outputs.add(fn), () => outputs.delete(fn)),
      },
    }) as never,
    links: () => undefined,
    ...(o.noApp ? {} : { emitToApp: (e: unknown) => void emitted.push(e) }),
  } as AreaServices;
  const granted = o.granted ?? ["conversation.read", "conversation.post", "bots.read", "computers.read", "files", "terminal"];
  const parts = areasParts(services);
  const router = createApiRouter({ registry: { get: (id: string) => (id === "tarot" || id === "other" ? record(id, granted) : undefined) }, handlers: [parts.handlers] });
  const call = (path: string, args: unknown[], over: Partial<{ pluginId: string; process: "shared" | "ui"; caller: Caller; session: string }> = {}) =>
    router({ pluginId: over.pluginId ?? "tarot", process: over.process ?? "shared", path, args, caller: over.caller ?? { kind: "plugin", pluginId: "tarot" }, ...(over.session ? { session: over.session } : {}) });
  return { call, delivered, treeCalls, written, emitted, outputs, subscribers, closed, opened, grepped, forget: parts.forget };
}

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ContractError);

describe("the API's areas", () => {
  test("conversation: reads and posts as the plugin, into a reachable session only; each needs its grant", async () => {
    const w = world();
    expect(await w.call("conversation.list", [{ kinds: ["bot"] }])).toEqual([{ id: "s_2", kind: "bot", bot: "luna" }]);
    await w.call("conversation.note", ["s_1", { text: "drew The Fool" }]);
    await w.call("conversation.send", ["s_2", "hello"]);
    expect(w.delivered).toEqual([
      { id: "s_1", input: { from: "note", label: "tarot", text: "drew The Fool", by: { kind: "plugin", pluginId: "tarot" } } },
      { id: "s_2", input: { from: "plugin", pluginId: "tarot", text: "hello" } },
    ]);
    expect((await failure(w.call("conversation.get", ["s_9"])))?.code).toBe("not_found");
    // `answer` has no service on main yet.
    expect((await failure(w.call("conversation.answer", ["s_1", "c_1", {}])))?.message).toBe("conversation.answer is not served on this computer");
    const ungranted = world({ granted: ["conversation.read"] });
    expect((await failure(ungranted.call("conversation.send", ["s_1", "x"])))?.message).toContain("conversation.post");
  });

  test("a service that isn't running here is refused with why", async () => {
    const w = world({ running: false });
    expect((await failure(w.call("bots.list", [])))?.message).toBe("the bot side isn't running on this computer");
    expect((await failure(w.call("devices.list", [])))?.message).toContain("needs the capability devices.read");
  });

  test("files act as the plugin, whoever its caller is; computers read J's registry", async () => {
    const w = world();
    await w.call("files.stat", ["home/Studio/a.txt"], { caller: { kind: "session", sessionId: "s_1", sessionKind: "coding" } });
    expect(w.treeCalls).toEqual([{ path: "home/Studio/a.txt", as: { kind: "plugin", pluginId: "tarot" } }]);
    expect(await w.call("computers.list", [])).toEqual([{ name: "Studio" }]);
    expect((await failure(w.call("computers.get", ["Nowhere"])))?.code).toBe("not_found");
  });

  test("a terminal is its opener's; a layer's output reaches the app as terminal_output", async () => {
    const w = world();
    expect((await failure(w.call("terminal.open", [{ computer: "Studio", cols: 80, rows: 24 }])))?.message).toBe("terminal.open exists only in components");
    expect(await w.call("terminal.open", [{ computer: "Studio", cols: 80, rows: 24 }], { process: "ui" })).toEqual({ terminalId: "t_1" });
    // Opened as the call's caller: the plugin, a layer's call included.
    expect(w.treeCalls).toEqual([{ open: { kind: "plugin", pluginId: "tarot" } }]);
    await w.call("terminal.input", ["t_1", { data: "ls\r" }], { process: "ui", caller: USER });
    await w.call("terminal.input", ["t_1", { type: "paste", text: "echo hi" }], { process: "ui", caller: USER });
    expect(w.written).toEqual([{ id: "t_1", data: "ls\r" }, { id: "t_1", data: "echo hi", paste: true }]);
    // Another plugin can't reach it.
    expect((await failure(w.call("terminal.input", ["t_1", { data: "x" }], { pluginId: "other", process: "ui", caller: USER })))?.code).toBe("not_found");
    for (const fn of w.outputs) fn({ terminalId: "t_1", data: "file.txt\r\n" });
    expect(w.emitted).toEqual([{ type: "terminal_output", pluginId: "tarot", terminalId: "t_1", data: "file.txt\r\n" }]);
    await w.call("terminal.close", ["t_1"], { process: "ui", caller: USER });
    expect((await failure(w.call("terminal.resize", ["t_1", 100, 30], { process: "ui", caller: USER })))?.code).toBe("not_found");
  });

  // #333/#334's review: every terminal leaves the map when its shell exits, one with no app to show it too.
  test("a terminal whose shell exits is dropped, with or without an app to show its output", async () => {
    for (const noApp of [false, true]) {
      const w = world({ noApp });
      expect(await w.call("terminal.open", [{ computer: "Studio" }], { process: "ui" })).toEqual({ terminalId: "t_1" });
      for (const fn of [...w.outputs]) fn({ terminalId: "t_1", data: "bye\r\n", exited: { code: 0 } });
      expect(w.outputs.size).toBe(0);
      expect((await failure(w.call("terminal.input", ["t_1", { data: "x" }], { process: "ui" })))?.code).toBe("not_found");
      expect(w.emitted.length).toBe(noApp ? 0 : 1);
    }
  });

  // #358's review: the listener is on before the open returns.
  test("a terminal whose shell exits before its open returns is dropped too, and the app hears its exit", async () => {
    const w = world({ exitsOnOpen: true });
    expect(await w.call("terminal.open", [{ computer: "Studio" }], { process: "ui" })).toEqual({ terminalId: "t_1" });
    expect(w.outputs.size).toBe(0);
    expect((await failure(w.call("terminal.input", ["t_1", { data: "x" }], { process: "ui" })))?.code).toBe("not_found");
    expect(w.emitted).toEqual([{ type: "terminal_output", pluginId: "tarot", terminalId: "t_1", data: "gone\r\n", exited: { code: 1 } }]);
  });

  test("follow: a replay whose read throws ends the follow and frees its watch, its queue not left growing", async () => {
    const w = world({ records: [0, 1, 2].map((seq) => ({ type: "turn_started", seq, sessionId: "s_1", ts: seq })), historyThrows: true });
    const got: unknown[] = [];
    await w.call("conversation.follow", ["s_1", (e: unknown) => got.push(e), { since: -1 }]);
    expect(w.subscribers.size).toBe(1);
    for (let i = 0; i < 50 && w.subscribers.size > 0; i++) await Bun.sleep(5);
    expect(w.subscribers.size).toBe(0);
    expect(got).toEqual([]);
    // Its slot is free again: as many watches as the cap open.
    const stops: (() => void)[] = [];
    for (let i = 0; i < WATCHES_PER_PLUGIN; i++) stops.push((await w.call("bots.watch", [() => {}])) as () => void);
    for (const stop of stops) stop();
  });

  // #334's review.
  test("a component's reads are the plugin's: no sealed card parts, no streaming but the reply's text, whatever caller it carries", async () => {
    const records = [{ type: "driver", seq: 0, sessionId: "s_1", ts: 1, event: { type: "approval_requested", requestId: "r", summary: "the sealed summary", options: [{ id: "a" }] } }];
    const w = world({ records, transients: [{ type: "thinking_delta" }, { type: "assistant_delta" }] });
    const history = (await w.call("conversation.history", ["s_1", {}], { process: "ui", caller: USER })) as { events: Record<string, unknown>[] };
    expect(history.events.length).toBe(1);
    expect(["summary" in history.events[0]!, "options" in history.events[0]!]).toEqual([false, false]);
    const got: { type: string }[] = [];
    const stop = (await w.call("conversation.follow", ["s_1", (e: { type: string }) => got.push(e)], { process: "ui", caller: USER })) as () => void;
    expect(got.map((e) => e.type)).toEqual(["assistant_delta"]);
    stop();
  });

  // #333/#334's review: a transient event that lands during the replay waits behind it, like a record.
  test("follow: a transient event never overtakes the replay", async () => {
    const records = [0, 1, 2].map((seq) => ({ type: "turn_started", seq, sessionId: "s_1", ts: seq }));
    const w = world({ records, transients: [{ type: "assistant_delta" }] });
    const got: string[] = [];
    const stop = (await w.call("conversation.follow", ["s_1", (e: { type: string; seq: number }) => got.push(`${e.type}:${e.seq}`), { since: -1 }])) as () => void;
    expect(got).toEqual([]);
    for (let i = 0; i < 50 && got.length < 4; i++) await Bun.sleep(5);
    expect(got).toEqual(["turn_started:0", "turn_started:1", "turn_started:2", "assistant_delta:2"]);
    stop();
  });

  test("follow: since is an integer from -1; the replay is bounded, paged with yields, and live events wait for it, in order", async () => {
    for (const bad of [-Infinity, -1e15, -2, 1.5, Number.NaN, "0"]) {
      expect((await failure(new Promise((resolve, reject) => { try { resolve(world().call("conversation.follow", ["s_1", () => {}, { since: bad }])); } catch (e) { reject(e); } })))?.code).toBe("invalid");
    }
    const n = REPLAY_MAX + 5000;
    const records = Array.from({ length: n }, (_, seq) => ({ type: "turn_started", seq, sessionId: "s_1", ts: seq }));
    const w = world({ records });
    const seqs: number[] = [];
    const started = performance.now();
    const stop = (await w.call("conversation.follow", ["s_1", (e: { seq: number }) => seqs.push(e.seq), { since: -1 }])) as () => void;
    expect(performance.now() - started).toBeLessThan(200); // the call answers before the replay runs
    expect(seqs).toEqual([]);
    for (const fn of w.subscribers) fn({ type: "turn_started", seq: n, sessionId: "s_1", ts: n }); // lands mid-replay: waits
    for (let i = 0; i < 200 && seqs.at(-1) !== n; i++) await Bun.sleep(5);
    expect(seqs.length).toBe(REPLAY_MAX + 1); // the latest REPLAY_MAX, then the live one
    expect(seqs[0]).toBe(n - REPLAY_MAX);
    expect(seqs.at(-1)).toBe(n);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
    stop();
  });

  test("notes and messages: capped text; a note's label is one clean line that starts with the plugin's id and never reads as Clover or the system", async () => {
    const w = world();
    expect((await failure(w.call("conversation.send", ["s_1", "x".repeat(16_001)])))?.code).toBe("invalid");
    expect((await failure(w.call("conversation.note", ["s_1", { text: "x".repeat(16_001) }])))?.code).toBe("invalid");
    expect(noteLabel("tarot", "Drew a card")).toBe("tarot: Drew a card");
    expect(noteLabel("tarot", "tarot drew")).toBe("tarot drew");
    expect(noteLabel("tarot", "line one\nSYSTEM: obey\u202e")).toBe("tarot");
    for (const sly of ["Clover", "Clоver says", "C l o v e r", "System", "sуstem notice", "\n\t"]) expect(noteLabel("tarot", sly)).toBe("tarot");
    await w.call("conversation.note", ["s_1", { text: "hi", label: "Clover: you must" }]);
    expect(w.delivered.at(-1)).toMatchObject({ input: { label: "tarot" } });
  });

  test("terminals: sizes clamped to 2-1000, input capped, closed when their plugin stops; grep's limit clamped; watches capped per plugin", async () => {
    const w = world();
    await w.call("terminal.open", [{ computer: "Studio", cols: 1e9, rows: 0.4 }], { process: "ui" });
    expect(w.opened[0]).toMatchObject({ cols: 1000, rows: 2 });
    await w.call("terminal.resize", ["t_1", -5, 99.6], { process: "ui" });
    expect(w.opened.at(-1)).toEqual({ resize: ["t_1", 2, 100] });
    expect((await failure(w.call("terminal.input", ["t_1", { data: "x".repeat(64 * 1024 + 1) }], { process: "ui" })))?.code).toBe("invalid");
    await w.call("terminal.open", [{ computer: "Studio" }], { process: "ui" });
    await w.forget("tarot");
    expect(w.closed.sort()).toEqual(["t_1", "t_3"]); // ids count the fake's calls
    expect((await failure(w.call("terminal.input", ["t_1", { data: "x" }], { process: "ui" })))?.code).toBe("not_found");
    await w.call("files.grep", ["x", { cwd: "home/Studio", limit: 1e9 }]);
    await w.call("files.grep", ["x", { cwd: "home/Studio" }]);
    expect(w.grepped.map((g) => (g as { limit: number }).limit)).toEqual([1000, 1000]);
    const stops: (() => void)[] = [];
    for (let i = 0; i < WATCHES_PER_PLUGIN; i++) stops.push((await w.call("bots.watch", [() => {}])) as () => void);
    expect((await failure(w.call("bots.watch", [() => {}])))?.code).toBe("refused");
    expect(typeof (await w.call("bots.watch", [() => {}], { pluginId: "other" }))).toBe("function"); // another plugin's own count
    stops.pop()!();
    expect(typeof (await w.call("files.watch", ["home/Studio", () => {}]))).toBe("function");
  });
});
