// The update's idle gate (src/update/gate.ts): busy sources other lanes register, the verdict `update.status` serves,
// the wait for an idle moment, and the lease check (an update's short restart leaves the bots on this computer).
import { describe, expect, test } from "bun:test";
import { isContractError } from "../../src/contracts/common";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FAKE_LEASE_MARGIN_MS, FAKE_LEASE_TTL_MS, FakeLeaseAuthority } from "../../src/contracts/fakes/lease";
import { UpdateGate } from "../../src/update/gate";

describe("the update's idle gate", () => {
  test("idle with nothing registered; busy while any source counts work, named with its count", () => {
    const gate = new UpdateGate();
    expect(gate.verdict()).toEqual({ idle: true, busy: [] });
    let turns = 0, approvals = 0;
    gate.register({ name: "turns", count: () => turns });
    const off = gate.register({ name: "approvals", count: () => approvals });
    expect(gate.names()).toEqual(["turns", "approvals"]);
    expect(gate.verdict()).toEqual({ idle: true, busy: [] });
    turns = 1; approvals = 2;
    expect(gate.verdict()).toEqual({ idle: false, busy: ["turns:1", "approvals:2"] });
    off();
    expect(gate.verdict()).toEqual({ idle: false, busy: ["turns:1"] });
    turns = 0;
    expect(gate.verdict().idle).toBe(true);
  });

  test("a source that throws or counts nonsense is busy: never install over the unknown", () => {
    const gate = new UpdateGate();
    gate.register({ name: "runners", count: () => { throw new Error("gone"); } });
    gate.register({ name: "bots", count: () => Number.NaN });
    expect(gate.verdict()).toEqual({ idle: false, busy: ["runners:1", "bots:?"] });
  });

  test("a second source under one name replaces the first; the first's removal then leaves it", () => {
    const gate = new UpdateGate();
    const offA = gate.register({ name: "k", count: () => 1 });
    gate.register({ name: "k", count: () => 0 });
    offA();
    expect(gate.names()).toEqual(["k"]);
    expect(gate.verdict().idle).toBe(true);
  });

  test("whenIdle resolves at the first idle moment, and a stopped wait rejects", async () => {
    const gate = new UpdateGate();
    let n = 2;
    gate.register({ name: "turns", count: () => n-- > 0 ? 1 : 0 });
    await gate.whenIdle(1);
    expect(n).toBeLessThan(0);
    gate.register({ name: "stuck", count: () => 1 });
    const stop = new AbortController();
    const waiting = gate.whenIdle(1, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow(/stopped/);
  });

  test("the steps before a restart all run; a failing or hanging one is logged and never blocks it", async () => {
    const gate = new UpdateGate();
    const ran: string[] = [];
    const lines: string[] = [];
    gate.beforeRestart(() => { ran.push("renew"); });
    gate.beforeRestart(async () => { throw new Error("offline"); });
    gate.beforeRestart(() => new Promise<void>(() => {}));
    const off = gate.beforeRestart(() => { ran.push("removed"); });
    off();
    await gate.prepareRestart(20, (l) => lines.push(l));
    expect(ran).toEqual(["renew"]);
    expect(lines.sort()).toEqual(["update: a step before the restart failed: offline", "update: a step before the restart failed: took over 20 ms"]);
  });

  test("closing for a restart: idle, closed, the steps, idle still; a turn that starts during the steps reopens it", async () => {
    const gate = new UpdateGate();
    let turns = 0;
    gate.register({ name: "turns", count: () => turns });
    expect(gate.closed).toBe(false);
    expect(await gate.closeForRestart()).toBe(true);
    expect(gate.closed).toBe(true);
    gate.reopen();
    // Busy at the start: never closes.
    turns = 1;
    expect(await gate.closeForRestart()).toBe(false);
    expect(gate.closed).toBe(false);
    // A turn that starts during the steps before the restart (it slipped past the latch): reopened, and false.
    turns = 0;
    const off = gate.beforeRestart(() => { expect(gate.closed).toBe(true); turns = 1; });
    expect(await gate.closeForRestart()).toBe(false);
    expect(gate.closed).toBe(false);
    off();
  });

  test("a close that no restart follows reopens by itself", async () => {
    const gate = new UpdateGate();
    gate.close(20);
    expect(gate.closed).toBe(true);
    await Bun.sleep(60);
    expect(gate.closed).toBe(false);
  });

  // The lease under H's timings (contracts/lease.ts: "30 s and a 5 s margin are sound"; the fake carries them until
  // lane H's real lease): an update's restart is not Hand over and quit. The lease renews just before the restart
  // (`beforeRestart`), the daemon is down for 10-20 s, and nothing on another computer can take the bots meanwhile.
  test("a 10-20 s restart for an update leaves the lease, and the bots, on this computer", async () => {
    expect(FAKE_LEASE_TTL_MS).toBe(30_000);
    expect(FAKE_LEASE_MARGIN_MS).toBe(5_000);
    for (const downMs of [10_000, 20_000]) {
      const clock = new FakeClock();
      const authority = new FakeLeaseAuthority({ clock, main: "studio" });
      const studio = authority.lease("studio");
      const laptop = authority.lease("laptop");
      await studio.acquire();
      clock.advance(8_000); // some time into the lease, as at any update

      const gate = new UpdateGate();
      gate.beforeRestart(async () => { await studio.renew(); });
      await gate.prepareRestart();
      // The daemon stops; the new one starts `downMs` later. Throughout, the laptop sees the lease held here.
      for (let t = 0; t < downMs; t += 1_000) {
        clock.advance(1_000);
        expect(laptop.state()).toMatchObject({ holder: "studio", state: "held" });
        expect(isContractError(await laptop.acquire().catch((e: unknown) => e), "not_main")).toBe(true);
      }
      // The new daemon takes the lease back under the same epoch: no handover happened.
      const back = authority.lease("studio");
      expect(await back.acquire()).toMatchObject({ holder: "studio", epoch: 1 });
      expect(back.canAct()).toBe(true);
    }
  });

  test("the bound: a restart longer than the lease (TTL after the last renew) would hand the bots over", async () => {
    const clock = new FakeClock();
    const authority = new FakeLeaseAuthority({ clock, main: "studio" });
    const studio = authority.lease("studio");
    await studio.acquire();
    clock.advance(FAKE_LEASE_TTL_MS);
    expect(await authority.lease("laptop").acquire()).toMatchObject({ holder: "laptop", epoch: 2 });
  });
});
