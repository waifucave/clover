import { describe, expect, test } from "bun:test";
import { coalesced } from "../src/layer/clover/coalesce";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rect = (w: number, h: number) => [{ x: 0, y: 0, width: w, height: h }];

describe("a surface part's requests to its window", () => {
  test("many changes in a frame make one request; the first show and a shrinking region go at once", async () => {
    const sent: unknown[] = [];
    const host = coalesced((p) => sent.push(p));
    host.setWindow({ visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } } as never);
    await wait(0);
    expect(sent).toHaveLength(1); // the first show: at once
    host.setInteractiveRegions(rect(100, 100)); // grows: rides the timer
    host.setWindow({ visible: true, bounds: { x: 0, y: 0, width: 20, height: 20 } } as never);
    host.setWindow({ visible: true, bounds: { x: 0, y: 0, width: 30, height: 30 } } as never);
    await wait(0);
    expect(sent).toHaveLength(1);
    await wait(40);
    expect(sent).toHaveLength(2);
    expect((sent[1] as { bounds: { width: number } }).bounds.width).toBe(30); // merged: the last wins
    host.setInteractiveRegions(rect(10, 10)); // shrinks: at once
    await wait(0);
    expect(sent).toHaveLength(3);
    host.dispose();
  });
  test("after the part unmounts nothing waiting is sent", async () => {
    const sent: unknown[] = [];
    const host = coalesced((p) => sent.push(p));
    host.setWindow({ visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } } as never);
    await wait(0);
    host.setInteractiveRegions(rect(500, 500));
    host.dispose();
    await wait(40);
    expect(sent).toHaveLength(1);
  });
});
