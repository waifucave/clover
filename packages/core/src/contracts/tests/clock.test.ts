// Pins the Clock contract's helpers and FakeClock, which every other fake's timers run on.
import { describe, expect, test } from "bun:test";
import { compareStamps } from "../clock";
import { ContractError, RPC_ERROR_OF, isInside, normalizePosix } from "../common";
import { FAKE_EPOCH_MS, FakeClock, advanceAndSettle } from "../fakes/clock";

describe("FakeClock", () => {
  test("starts at a fixed time, synced to public time", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(FAKE_EPOCH_MS);
    expect(clock.monotonic()).toBe(0);
    expect(clock.status()).toEqual({ reference: "public", offsetMs: 0, accuracyMs: 0, synced: true });
  });

  test("fires due timers in order of due time, then of when they were set", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 200);
    clock.setTimeout(() => fired.push("a"), 100);
    clock.setTimeout(() => fired.push("a2"), 100);
    clock.setTimeout(() => fired.push("late"), 1000);
    clock.advance(500);
    expect(fired).toEqual(["a", "a2", "b"]);
    expect(clock.now()).toBe(FAKE_EPOCH_MS + 500);
    expect(clock.pending()).toBe(1);
  });

  test("a timer a firing timer sets fires in the same advance when it falls due", () => {
    const clock = new FakeClock();
    const at: number[] = [];
    clock.setTimeout(() => {
      at.push(clock.monotonic());
      clock.setTimeout(() => at.push(clock.monotonic()), 50);
    }, 100);
    clock.advance(200);
    expect(at).toEqual([100, 150]);
  });

  test("clearTimeout cancels", () => {
    const clock = new FakeClock();
    let fired = false;
    const h = clock.setTimeout(() => (fired = true), 10);
    clock.clearTimeout(h);
    clock.advance(100);
    expect(fired).toBe(false);
  });

  test("a sync moves shared time but never the monotonic clock or a timer", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => (fired = true), 1000);
    clock.correct(clock.now() + 3_600_000);
    expect(clock.monotonic()).toBe(0);
    clock.advance(999);
    expect(fired).toBe(false);
    clock.advance(1);
    expect(fired).toBe(true);
  });

  test("advanceAndSettle lets promise chains run between timers", async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    void (async () => {
      await new Promise<void>((r) => clock.setTimeout(r, 100));
      seen.push(clock.monotonic());
      await new Promise<void>((r) => clock.setTimeout(r, 100));
      seen.push(clock.monotonic());
    })();
    await advanceAndSettle(clock, 300, 50);
    expect(seen).toEqual([100, 200]);
  });
});

describe("send order", () => {
  test("by shared time, then by device id", () => {
    const stamps = [{ t: 2, device: "b" }, { t: 1, device: "z" }, { t: 2, device: "a" }];
    expect([...stamps].sort(compareStamps)).toEqual([{ t: 1, device: "z" }, { t: 2, device: "a" }, { t: 2, device: "b" }]);
    expect(compareStamps({ t: 5, device: "x" }, { t: 5, device: "x" })).toBe(0);
  });
});

describe("common", () => {
  test("a ContractError crosses a wire with its code, and an unknown code becomes `failed`", () => {
    const err = new ContractError("computer_offline", "Studio is offline", { computer: "Studio" });
    const back = ContractError.fromJSON(JSON.parse(JSON.stringify(err)));
    expect(back.code).toBe("computer_offline");
    expect(back.message).toBe("Studio is offline");
    expect(back.detail).toEqual({ computer: "Studio" });
    expect(ContractError.fromJSON({ code: "nope", message: "x" }).code).toBe("failed");
  });

  test("the protocol's error codes are the ones the IPC layer sends", () => {
    expect(RPC_ERROR_OF.computer_offline).toBe(-32013);
    expect(RPC_ERROR_OF.fenced).toBe(-32017);
    expect(RPC_ERROR_OF.not_main).toBe(-32018);
  });

  test("paths", () => {
    expect(normalizePosix("/a/b/../c/./d/")).toBe("/a/c/d");
    expect(normalizePosix("a/..")).toBe(".");
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a/../etc", "/a")).toBe(false);
    expect(isInside("/anything", "/")).toBe(true);
  });
});
