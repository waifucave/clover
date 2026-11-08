// The API's areas over other lanes' services, through the real capability gate, with small fakes of each service: the
// grant each call needs, the caller each acts as, a service that isn't running, and a terminal that is its opener's.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { areasApi, type AreaServices } from "../api/areas";
import { createApiRouter } from "../api/router";

const USER: Caller = { kind: "user", client: "app" };
const record = (id: string, granted: string[]) => ({ id, enabled: true, state: "running", granted, capabilities: granted }) as never;

function world(o: { granted?: string[]; running?: boolean } = {}) {
  const delivered: unknown[] = [];
  const treeCalls: unknown[] = [];
  const written: unknown[] = [];
  const emitted: unknown[] = [];
  const outputs = new Set<(o: { terminalId: string; data: string; exited?: { code: number | null } }) => void>();
  const sessions = [{ id: "s_1", kind: "code" }, { id: "s_2", kind: "bot", bot: "luna" }];
  const services: AreaServices = {
    bots: () => o.running === false ? undefined : ({
      host: {
        list: () => sessions, get: (id: string) => sessions.find((s) => s.id === id),
        deliver: async (id: string, input: unknown) => (delivered.push({ id, input }), { seq: 1 }),
        history: () => [], length: () => 0, subscribe: () => () => {}, onTransient: () => () => {},
      },
      bots: { has: (id: string) => id === "luna", list: () => [{ id: "luna" }], get: (id: string) => (id === "luna" ? { id: "luna" } : undefined), onEvent: () => () => {} },
    }) as never,
    node: () => ({
      registry: { list: () => [{ name: "Studio" }], get: (n: string) => (n === "Studio" ? { name: "Studio" } : undefined), watch: () => () => {} },
      holds: {},
      tree: { stat: async (path: string, opts: { as: Caller }) => (treeCalls.push({ path, as: opts.as }), null) },
      terminals: {
        open: async (_p: unknown, as: Caller) => (treeCalls.push({ open: as }), { terminalId: "t_1" }),
        write: async (id: string, data: string, opts?: { paste?: boolean }) => void written.push({ id, data, ...opts }),
        resize: async () => {}, close: async () => {},
        onOutput: (fn: never) => (outputs.add(fn), () => outputs.delete(fn)),
      },
    }) as never,
    links: () => undefined,
    emitToApp: (e) => void emitted.push(e),
  };
  const granted = o.granted ?? ["conversation.read", "conversation.post", "bots.read", "computers.read", "files", "terminal"];
  const router = createApiRouter({ registry: { get: (id: string) => (id === "tarot" || id === "other" ? record(id, granted) : undefined) }, handlers: [areasApi(services)] });
  const call = (path: string, args: unknown[], over: Partial<{ pluginId: string; process: "shared" | "ui"; caller: Caller; session: string }> = {}) =>
    router({ pluginId: over.pluginId ?? "tarot", process: over.process ?? "shared", path, args, caller: over.caller ?? { kind: "plugin", pluginId: "tarot" }, ...(over.session ? { session: over.session } : {}) });
  return { call, delivered, treeCalls, written, emitted, outputs };
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
    expect(await w.call("terminal.open", [{ computer: "Studio", cols: 80, rows: 24 }], { process: "ui", caller: USER })).toEqual({ terminalId: "t_1" });
    // Opened as the call's caller: the layer's, the user's.
    expect(w.treeCalls).toEqual([{ open: USER }]);
    await w.call("terminal.input", ["t_1", { data: "ls\r" }], { process: "ui", caller: USER });
    await w.call("terminal.input", ["t_1", { type: "paste", text: "echo hi" }], { process: "ui", caller: USER });
    expect(w.written).toEqual([{ id: "t_1", data: "ls\r" }, { id: "t_1", data: "echo hi", paste: true }]);
    // Another plugin can't reach it.
    expect((await failure(w.call("terminal.input", ["t_1", { data: "x" }], { pluginId: "other", process: "ui", caller: USER })))?.code).toBe("not_found");
    for (const fn of w.outputs) fn({ terminalId: "t_1", data: "file.txt\r\n" });
    expect(w.emitted).toEqual([{ type: "terminal_output", terminalId: "t_1", data: "file.txt\r\n" }]);
    await w.call("terminal.close", ["t_1"], { process: "ui", caller: USER });
    expect((await failure(w.call("terminal.resize", ["t_1", 100, 30], { process: "ui", caller: USER })))?.code).toBe("not_found");
  });
});
