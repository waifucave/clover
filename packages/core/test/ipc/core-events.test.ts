import { describe, expect, test } from "bun:test";
import type { Caller, CloverRole } from "@waifucave/clover-protocol";
import { OWNER_SCOPED_EVENTS, sendCoreEvent } from "../../src/ipc/core-events";
import type { CloverConn } from "../../src/ipc/clover";
import { approvalCoreEvents } from "../../src/approvals/core-events";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { FakeClock } from "../../src/contracts/fakes/clock";

// C-M3 item 2: the `core.event` sender's routing, and the broker's cards as core events.

let seq = 0;
function conn(role: CloverRole, areas: string[], extra: { caller?: Caller; hostProcess?: CloverConn["hostProcess"]; throws?: boolean } = {}) {
  const got: unknown[] = [];
  const c = {
    connId: ++seq, role, caller: extra.caller ?? { kind: "user", client: "app" }, features: [], clientName: role,
    ...(extra.hostProcess ? { hostProcess: extra.hostProcess } : {}),
    areas: new Set(areas), follows: new Map(), send: () => "x",
    notify: (method: string, params: unknown) => { if (extra.throws) throw new Error("closed"); got.push([method, params]); },
  } as unknown as CloverConn;
  return { c, got };
}

const resolved = { type: "card_resolved", ts: 5, id: "card_0a1b2c3d", outcome: "approved", option: "approve" };

describe("the core.event sender", () => {
  test("by role and subscribed area; what parsed is what's sent", () => {
    const app = conn("app", ["approvals"]), quiet = conn("app", []), remote = conn("remote", ["approvals", "devices"]), cli = conn("cli", ["approvals"]);
    const n = sendCoreEvent({ connections: () => [app.c, quiet.c, remote.c, cli.c] }, { ...resolved, secret: "never sent" });
    expect(n).toBe(2);
    expect(app.got).toEqual([["core.event", resolved]]);
    expect(remote.got).toEqual([["core.event", resolved]]);
    expect(quiet.got).toEqual([]);
    expect(cli.got).toEqual([]); // card_resolved isn't the CLI's
  });

  test("a plugin's connection needs the event's capability; a shared host gets none of those", () => {
    const layer = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "luna" } });
    const other = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "noisy" } });
    const shared = conn("plugin-host", ["approvals"], { caller: { kind: "plugin", pluginId: "luna" }, hostProcess: { hostProcess: "shared" } });
    const caps = (id: string) => (id === "luna" ? ["approvals"] : []);
    const pending = { type: "card_pending", ts: 1, card: { id: "card_0a1b2c3d", kind: "tool", computer: "Studio", origin: "user", issuedAt: 1, expiresAt: null, options: [{ id: "approve", kind: "approve" }] } };
    expect(sendCoreEvent({ connections: () => [layer.c, other.c, shared.c], pluginCapabilities: caps }, pending)).toBe(1);
    expect(layer.got).toHaveLength(1);
    expect(sendCoreEvent({ connections: () => [layer.c] }, pending)).toBe(0); // no registry: no capability
  });

  test("a plugin's own events (its host half's ui.send, its store's changes) reach only that plugin's own layer", () => {
    const luna = conn("layer", ["plugins"], { caller: { kind: "plugin", pluginId: "luna" } });
    const sol = conn("layer", ["plugins"], { caller: { kind: "plugin", pluginId: "sol" } });
    const child = conn("layer", ["plugins"], { caller: { kind: "plugin", pluginId: "luna/extra" } });
    const app = conn("app", ["plugins"]);
    const host = conn("plugin-host", ["plugins"], { caller: { kind: "plugin", pluginId: "luna" }, hostProcess: { hostProcess: "own", pluginId: "luna" } as never });
    const all = { connections: () => [luna.c, sol.c, child.c, app.c, host.c] };
    const message = { type: "plugin_ui_message", ts: 1, pluginId: "luna", event: "stage", value: { v: 1 } };
    expect(sendCoreEvent(all, message)).toBe(1);
    expect(luna.got).toEqual([["core.event", message]]);
    const changed = { type: "plugin_store_changed", ts: 2, pluginId: "luna", key: "stage" };
    expect(sendCoreEvent(all, changed)).toBe(1);
    expect(luna.got).toHaveLength(2);
    for (const other of [sol, child, app, host]) expect(other.got).toEqual([]);
  });

  test("unknown, session-scoped and malformed events aren't sent, with fixed log lines; a closed connection doesn't stop the rest", () => {
    const lines: string[] = [];
    const bad = conn("app", ["approvals"], { throws: true }), app = conn("app", ["approvals"]);
    const r = { connections: () => [bad.c, app.c], log: (l: string) => lines.push(l), now: () => 77 };
    expect(sendCoreEvent(r, { type: "made_up" })).toBe(0);
    expect(sendCoreEvent(r, { type: "card_resolved", id: "card_0a1b2c3d", outcome: "nope" })).toBe(0);
    expect(lines).toEqual(['[core.event] not a core event, not sent: "made_up"', "[core.event] a card_resolved event didn't parse; not sent"]);
    expect(sendCoreEvent(r, { type: "card_resolved", id: "card_0a1b2c3d", outcome: "denied" })).toBe(1);
    expect(app.got).toEqual([["core.event", { type: "card_resolved", ts: 77, id: "card_0a1b2c3d", outcome: "denied" }]]);
  });

  test("an owner-scoped event is refused without a `to`; a plugin never learns which device answered a card", () => {
    const lines: string[] = [];
    const app = conn("app", ["computers", "browser", "approvals"]);
    const layer = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "luna" } });
    const r = { connections: () => [app.c, layer.c], log: (l: string) => lines.push(l), pluginCapabilities: () => ["approvals"] };
    const out = { type: "terminal_output", ts: 1, terminalId: "t1", data: "hi" };
    expect(sendCoreEvent(r, out)).toBe(0);
    expect(lines).toEqual(["[core.event] a terminal_output event belongs to its owner and came with no `to`; not sent"]);
    for (const t of ["terminal_output", "tab_changed", "tab_closed", "cdp_event", "tool_output", "tree_changed"]) expect(OWNER_SCOPED_EVENTS.has(t)).toBe(true);
    expect(sendCoreEvent(r, { type: "tab_closed", ts: 1 } as never, {})).toBe(0);
    const answered = { ...resolved, device: "f".repeat(32) };
    expect(sendCoreEvent(r, answered)).toBe(2);
    expect(app.got.at(-1)).toEqual(["core.event", answered]);
    expect(layer.got.at(-1)).toEqual(["core.event", resolved]);
  });

  test("only the connections the caller names", () => {
    const a = conn("app", ["approvals"]), b = conn("app", ["approvals"]);
    expect(sendCoreEvent({ connections: () => [a.c, b.c] }, resolved, { to: (c) => c === b.c })).toBe(1);
    expect(a.got).toEqual([]);
  });
});

describe("the broker's cards as core events", () => {
  test("requested: the sealed card to the app, its meta to plugins with approvals; resolved to every one", async () => {
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock, levels: () => "ask" });
    const app = conn("app", ["approvals"]), layer = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "luna" } });
    const r = { connections: () => [app.c, layer.c], pluginCapabilities: () => ["approvals"] };
    const off = approvalCoreEvents(broker, (e, o) => sendCoreEvent(r, e, o), () => clock.now());
    const pending = broker.request({
      kind: "tool", session: "s1", origin: "user", bot: "luna", computers: ["Studio"], effect: "execute",
      fields: { title: { type: "text", text: "Run a command" }, command: { type: "code", code: "make", language: "sh" } },
    });
    await Bun.sleep(0);
    const [[, requested]] = app.got as [[string, { type: string; card: { id: string; hash: string; fields: unknown } }]];
    expect(requested.type).toBe("card_requested");
    expect(requested.card.fields).toMatchObject({ command: { code: "make" } });
    const [[, meta]] = layer.got as [[string, { type: string; card: Record<string, unknown> }]];
    expect(meta.type).toBe("card_pending");
    expect(meta.card.fields).toBeUndefined();
    broker.cancelSession("s1");
    await pending;
    expect(app.got.at(-1)).toEqual(["core.event", { type: "card_resolved", ts: clock.now(), id: requested.card.id, outcome: "cancelled" }]);
    expect(layer.got.at(-1)).toEqual(app.got.at(-1));
    off();
  });
});

describe("a card is heard by its own bot's plugin and the bundled tree, no other plugin", () => {
  const raise = (bot: string | undefined) => ({
    kind: "tool" as const, session: "s1", origin: "user" as const, ...(bot === undefined ? {} : { bot }), computers: ["Studio"], effect: "execute" as const,
    fields: { title: { type: "text" as const, text: "Run a command" } },
  });
  function setup() {
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock, levels: () => "ask" });
    const luna = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "luna" } });
    const lunaPart = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "luna/extra" } });
    const sol = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "sol" } });
    const tree = conn("layer", ["approvals"], { caller: { kind: "plugin", pluginId: "clover/island" } });
    const app = conn("app", ["approvals"]);
    const r = { connections: () => [luna.c, lunaPart.c, sol.c, tree.c, app.c], pluginCapabilities: () => ["approvals"] };
    const off = approvalCoreEvents(broker, (e, o) => sendCoreEvent(r, e, o), () => clock.now());
    return { broker, luna, lunaPart, sol, tree, app, off };
  }
  const types = (got: unknown[]) => (got as [string, { type: string }][]).map(([, e]) => e.type);

  test("luna's bot's card: luna's layers and the tree hear it pending and resolved; sol does not", async () => {
    const w = setup();
    const p = w.broker.request(raise("luna"));
    await Bun.sleep(0);
    expect(types(w.luna.got)).toEqual(["card_pending"]);
    expect(types(w.lunaPart.got)).toEqual(["card_pending"]);
    expect(types(w.tree.got)).toEqual(["card_pending"]);
    expect(types(w.sol.got)).toEqual([]);
    expect(types(w.app.got)).toEqual(["card_requested"]); // the sealed card to the app is unchanged
    w.broker.cancelSession("s1");
    await p;
    expect(types(w.luna.got)).toEqual(["card_pending", "card_resolved"]);
    expect(types(w.tree.got)).toEqual(["card_pending", "card_resolved"]);
    expect(types(w.sol.got)).toEqual([]);
    w.off();
  });

  test("a card with no bot (the user's own session) reaches the tree alone", async () => {
    const w = setup();
    const p = w.broker.request(raise(undefined));
    await Bun.sleep(0);
    expect(types(w.tree.got)).toEqual(["card_pending"]);
    expect(types(w.luna.got)).toEqual([]);
    expect(types(w.sol.got)).toEqual([]);
    w.broker.cancelSession("s1");
    await p;
    w.off();
  });
});
