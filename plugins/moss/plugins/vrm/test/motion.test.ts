import { describe, expect, test } from "bun:test";
import { BLINK, Blinker, blinkCurve } from "../src/motion/blink";
import { IDLE, idlePose } from "../src/motion/idle";

describe("blinking", () => {
  test("a blink shuts fast and opens slower", () => {
    expect(blinkCurve(-1)).toBe(0);
    expect(blinkCurve(0)).toBe(0);
    expect(blinkCurve(BLINK.close)).toBe(1);
    expect(blinkCurve(BLINK.close / 2)).toBeCloseTo(0.5, 6);
    expect(blinkCurve(BLINK.close + BLINK.open)).toBe(0);
    expect(BLINK.open).toBeGreaterThan(BLINK.close);
  });

  test("every 2 to 6 seconds, the same for the same seed, sometimes twice", () => {
    const a = new Blinker(42).schedule(600);
    const b = new Blinker(42).schedule(600);
    expect(a).toEqual(b);
    const gaps = a.slice(1).map((s, i) => s - a[i]!);
    const pairs = gaps.filter((g) => g < BLINK.minGap);
    expect(pairs.length).toBeGreaterThan(0);
    for (const g of pairs) expect(g).toBeCloseTo(BLINK.close + BLINK.open + BLINK.doubleGap, 9);
    for (const g of gaps.filter((g) => g >= BLINK.minGap)) expect(g).toBeLessThanOrEqual(BLINK.maxGap + 1e-9);
    expect(new Blinker(7).schedule(600)).not.toEqual(a);
  });

  test("its value stays in [0, 1] and is shut at a blink's height", () => {
    const blinker = new Blinker(3);
    const first = blinker.schedule(10)[0]!;
    expect(blinker.value(first + BLINK.close)).toBe(1);
    for (let t = 0; t < 30; t += 0.013) {
      const v = blinker.value(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("the idle pose", () => {
  test("arms down from the T-pose, the two sides mirrored, elbows bent a little", () => {
    const pose = idlePose(1.3);
    expect(pose.leftUpperArm![2]).toBeLessThan(-1);
    expect(pose.rightUpperArm![2]).toBeGreaterThan(1);
    expect(pose.leftUpperArm![2]).toBeCloseTo(-pose.rightUpperArm![2], 9);
    expect(pose.leftLowerArm![1]).toBe(-IDLE.elbow);
    expect(pose.rightLowerArm![1]).toBe(IDLE.elbow);
  });

  test("it breathes over time, and holds still with reduced motion", () => {
    expect(idlePose(0.5).chest).not.toEqual(idlePose(1.9).chest);
    expect(idlePose(0.5, true)).toEqual(idlePose(17.2, true));
    for (const euler of Object.values(idlePose(3.3))) for (const angle of euler!) expect(Math.abs(angle)).toBeLessThan(1.5);
  });
});
