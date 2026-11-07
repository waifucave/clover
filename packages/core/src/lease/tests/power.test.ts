// Keeping a computer awake while it works (spec §6.4 "Sleep"): one helper however many holds, gone with the last; the
// right helper per OS; and the core noticing a wake by itself (the boot clock running on while the awake clock stood).
import { describe, expect, test } from "bun:test";
import { watchSleep } from "../boot-clock";
import { osPowerKeeper } from "../power";

describe("power", () => {
  test("one helper while anything holds the keeper, per OS, gone with the last hold", () => {
    const started: string[][] = [];
    let killed = 0;
    const keeper = osPowerKeeper({ platform: "darwin", spawn: (argv) => (started.push([...argv]), { kill: () => void killed++ }) });
    const a = keeper.hold("a turn");
    const b = keeper.hold("an agent");
    expect(started).toHaveLength(1);
    expect(started[0]!.slice(0, 3)).toEqual(["/usr/bin/caffeinate", "-i", "-w"]);
    a();
    a();
    expect(killed).toBe(0);
    b();
    expect(killed).toBe(1);
    expect(keeper.held).toBe(0);

    const linux: string[][] = [];
    const lk = osPowerKeeper({ platform: "linux", spawn: (argv) => (linux.push([...argv]), { kill: () => undefined }) });
    lk.hold("a routine")();
    expect(linux[0]!.slice(0, 2)).toEqual(["systemd-inhibit", "--what=idle:sleep"]);

    const states: number[] = [];
    const wk = osPowerKeeper({ platform: "win32", setExecutionState: (f) => states.push(f >>> 0) });
    wk.hold("a turn")();
    expect(states).toEqual([0x80000001, 0x80000000]);
  });

  test("a wake is noticed when the boot clock ran on while the awake clock stood still", () => {
    let boot = 0;
    let awake = 0;
    let tick: (() => void) | undefined;
    const woke: number[] = [];
    const off = watchSleep((ms) => woke.push(ms), {
      clocks: { boot: () => boot, awake: () => awake }, everyMs: 2_000,
      setInterval: (fn) => ((tick = fn), 1), clearInterval: () => undefined,
    });
    boot += 2_000;
    awake += 2_000;
    tick!();
    expect(woke).toEqual([]);
    // Asleep for a minute: only the boot clock moved.
    boot += 62_000;
    awake += 2_000;
    tick!();
    expect(woke).toEqual([60_000]);
    off();
  });
});
