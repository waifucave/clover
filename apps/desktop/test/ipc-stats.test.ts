import { describe, expect, test } from "bun:test";
import { IpcStats, cpuMeter, ipcLine, ipcStatsOn, parseIpcLine, startIpcStats } from "../src/main/ui/ipc-stats";

describe("the IPC counter", () => {
  test("counts by channel and message type, and a take starts a fresh window", () => {
    const s = new IpcStats();
    for (let i = 0; i < 3; i++) s.received("clover:props");
    s.received("clover:size");
    s.sent("props");
    const w = s.take(5);
    expect(w.in.get("clover:props")).toBe(3);
    expect(w.in.get("clover:size")).toBe(1);
    expect(w.out.get("props")).toBe(1);
    const next = s.take(5);
    expect(next.in.size + next.out.size).toBe(0);
  });

  test("the line names the busiest channels and every process's share, and reads back", () => {
    const s = new IpcStats();
    for (let i = 0; i < 50; i++) s.received("clover:props");
    for (let i = 0; i < 5; i++) s.received("clover:size");
    for (let i = 0; i < 10; i++) s.sent("props");
    const line = ipcLine(s.take(5), [{ type: "Browser", percent: 4.123 }, { type: "Tab", percent: 2 }, { type: "Tab", percent: 1.5 }, { type: "GPU", percent: 0.25 }]);
    expect(line).toBe("ipc: 5 s in 11.0/s (props 50, size 5) out 2.0/s (props 10) cpu Browser 4.1% Tab 2.0% Tab 1.5% GPU 0.3%");
    const p = parseIpcLine(`2026-11-12 10:00:00 ${line}`)!;
    expect(p.seconds).toBe(5);
    expect(p.inPerSecond).toBe(11);
    expect(p.outPerSecond).toBe(2);
    expect(p.cpu.map((c) => `${c.type} ${c.percent}`)).toEqual(["Browser 4.1", "Tab 2", "Tab 1.5", "GPU 0.3"]);
    expect(parseIpcLine("layers: something else")).toBeUndefined();
  });

  test("an empty window says so with no channels", () => {
    const line = ipcLine(new IpcStats().take(5), [{ type: "Browser", percent: 0 }]);
    expect(parseIpcLine(line)).toEqual({ seconds: 5, inPerSecond: 0, outPerSecond: 0, cpu: [{ type: "Browser", percent: 0 }] });
  });

  test("runs only when asked: the variable or the file in the home, in any build", () => {
    expect(ipcStatsOn({ env: { CLOVER_IPC_STATS: "1" }, flagFile: false })).toBe(true);
    expect(ipcStatsOn({ env: {}, flagFile: true })).toBe(true);
    expect(ipcStatsOn({ env: {}, flagFile: false })).toBe(false);
    expect(ipcStatsOn({ env: { CLOVER_IPC_STATS: "0" }, flagFile: false })).toBe(false);
  });

  test("the sampler says one line per window and stops when told", () => {
    const s = new IpcStats();
    const lines: string[] = [];
    let tick: (() => void) | undefined;
    let stopped = false;
    const stop = startIpcStats(s, () => [{ type: "Browser", percent: 1 }], (l) => lines.push(l), 5_000, (fn) => { tick = fn; return () => { stopped = true; }; });
    s.received("clover:callback");
    tick!();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("callback 1");
    stop();
    expect(stopped).toBe(true);
  });
  test("each process's CPU is its cumulative seconds' growth over the window, not Electron's percent (which read 0.0 for renderers)", () => {
    let t = 0;
    let list = [{ pid: 1, type: "Browser", seconds: 10 }, { pid: 2, type: "Tab", seconds: 3 }, { pid: 3, type: "GPU" }];
    const meter = cpuMeter(() => list, () => t);
    expect(meter()).toEqual([]);
    t = 2_000;
    list = [{ pid: 1, type: "Browser", seconds: 10.1 }, { pid: 2, type: "Tab", seconds: 4.32 }, { pid: 4, type: "Tab", seconds: 1 }];
    const r = meter();
    expect(r.map((p) => [p.type, Math.round(p.percent * 10) / 10])).toEqual([["Browser", 5], ["Tab", 66]]);
    const line = ipcLine(new IpcStats().take(2), r);
    expect(parseIpcLine(line)?.cpu.map((c) => c.percent)).toEqual([5, 66]);
  });
});
