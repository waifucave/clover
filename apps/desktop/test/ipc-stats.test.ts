import { describe, expect, test } from "bun:test";
import { IpcStats, ipcLine, ipcStatsOn, parseIpcLine, startIpcStats } from "../src/main/ui/ipc-stats";

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

  test("runs only when asked, and never in a packaged build that is not test-marked", () => {
    const on = { CLOVER_IPC_STATS: "1" };
    expect(ipcStatsOn({ env: on, packaged: false, testBuild: false })).toBe(true);
    expect(ipcStatsOn({ env: on, packaged: true, testBuild: true })).toBe(true);
    expect(ipcStatsOn({ env: on, packaged: true, testBuild: false })).toBe(false);
    expect(ipcStatsOn({ env: {}, packaged: false, testBuild: true })).toBe(false);
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
});
