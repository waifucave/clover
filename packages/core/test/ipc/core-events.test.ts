import { describe, expect, test } from "bun:test";
import type { Caller, CloverRole } from "@waifucave/clover-protocol";
import { sendCoreEvent } from "../../src/ipc/core-events";
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
    const off = approvalCoreEvents(broker, (e) => sendCoreEvent(r, e), () => clock.now());
    const pending = broker.request({
      kind: "tool", session: "s1", origin: "user", computers: ["Studio"], effect: "execute",
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
