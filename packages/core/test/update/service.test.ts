// `update.status` and `update.apply` (src/update/service.ts): what the app reads to know when to install, checked
// against the protocol's own result schemas.
import { describe, expect, test } from "bun:test";
import { CLOVER_METHODS } from "@waifucave/clover-protocol";
import type { CloverConn } from "../../src/ipc/clover";
import { UpdateGate } from "../../src/update/gate";
import { acceptUpdateExit, updateHandlers, type SelfUpdate } from "../../src/update/service";
import { ERR } from "@waifucave/clover-protocol";
import { rpcFromCloverRefusal } from "../../src/ipc/server";
import { CloverLegRefusal } from "../../src/runtime-sdk/session-driver";
import { UPDATE_RESTARTING_MESSAGE } from "../../src/update/gate";

const conn = {} as CloverConn;
const parse = (method: string, result: unknown) => CLOVER_METHODS.get(method)!.result.parse(result);

describe("update.status and update.apply", () => {
  test("status says idle or what is busy, in the protocol's shape", async () => {
    const gate = new UpdateGate();
    let turns = 0;
    gate.register({ name: "turns", count: () => turns });
    const h = updateHandlers({ gate, current: "1.2.3", channel: () => "latest" });
    expect(parse("update.status", await h["update.status"]!(conn, {}))).toEqual({ current: "1.2.3", channel: "latest", ready: false, idle: true, busy: [] });
    turns = 2;
    expect(parse("update.status", await h["update.status"]!(conn, {}))).toMatchObject({ idle: false, busy: ["turns:2"] });
  });

  test("a long busy list stays inside the protocol's bounds", async () => {
    const gate = new UpdateGate();
    for (let i = 0; i < 40; i++) gate.register({ name: `${"x".repeat(70)}${i}`, count: () => 1 });
    const r = parse("update.status", await updateHandlers({ gate, current: "1", channel: () => "beta" })["update.status"]!(conn, {})) as { busy: string[] };
    expect(r.busy).toHaveLength(32);
    expect(r.busy.every((b) => b.length <= 64)).toBe(true);
  });

  test("on an app install, apply readies the restart (the lease's renew) only when idle", async () => {
    const gate = new UpdateGate();
    let busy = 1, renewed = 0;
    gate.register({ name: "turns", count: () => busy });
    gate.beforeRestart(() => { renewed++; });
    const h = updateHandlers({ gate, current: "1.2.3", channel: () => "latest" });
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "when-idle" });
    expect(renewed).toBe(0);
    busy = 0;
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "now" });
    expect(renewed).toBe(1);
  });

  test("apply closes the gate for the restart; a turn that starts during the steps before it makes the answer when-idle, gate open", async () => {
    const gate = new UpdateGate();
    let turns = 0;
    gate.register({ name: "turns", count: () => turns });
    const h = updateHandlers({ gate, current: "1.2.3", channel: () => "latest" });
    expect(acceptUpdateExit(gate)).toBe(false); // not closed yet
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "now" });
    expect(gate.closed).toBe(true);
    // Closed but busy: the app's exit is refused, and the gate reopens at once.
    turns = 1;
    expect(acceptUpdateExit(gate)).toBe(false);
    expect(gate.closed).toBe(false);
    turns = 0;
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "now" });
    // Accepted: committed, closed however long the restart takes.
    expect(acceptUpdateExit(gate)).toBe(true);
    expect(gate.committed).toBe(true);
    gate.reopen();
    expect(gate.closed).toBe(true);
    const fresh = new UpdateGate();
    fresh.register({ name: "turns", count: () => turns });
    const h2 = updateHandlers({ gate: fresh, current: "1.2.3", channel: () => "latest" });
    turns = 0;
    fresh.beforeRestart(() => { turns = 1; });
    expect(parse("update.apply", await h2["update.apply"]!(conn, {}))).toEqual({ at: "when-idle" });
    expect(fresh.closed).toBe(false);
  });

  test("on a server, apply starts the daemon's own update: now when idle, when-idle otherwise", async () => {
    const gate = new UpdateGate();
    let busy = 1, applied = 0;
    gate.register({ name: "approvals", count: () => busy });
    const self: SelfUpdate = { available: () => "1.3.0", ready: () => true, apply: () => { applied++; } };
    const h = updateHandlers({ gate, current: "1.2.3", channel: () => "latest", self: () => self });
    expect(parse("update.status", await h["update.status"]!(conn, {}))).toMatchObject({ available: "1.3.0", ready: true, idle: false });
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "when-idle" });
    busy = 0;
    expect(parse("update.apply", await h["update.apply"]!(conn, {}))).toEqual({ at: "now" });
    expect(applied).toBe(2);
  });

  test("a turn refused for the update's restart reaches a client as a RETRY, never INTERNAL", () => {
    let mapped: unknown;
    try { rpcFromCloverRefusal(new CloverLegRefusal("daemon_shutting_down", UPDATE_RESTARTING_MESSAGE, "update-restarting")); } catch (err) { mapped = err; }
    expect(mapped).toMatchObject({ code: ERR.RETRY, data: { code: "daemon_shutting_down", reason: "update-restarting", retryable: true } });
  });
});
