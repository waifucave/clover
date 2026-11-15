// The streams clause's own checks: the generator and checksum the fixtures carry, and the count comparison.
import { expect, test } from "bun:test";
import { countedWrong, expected, fnv, gen } from "./streams-step";

test("the expected count and checksum don't depend on how the bytes are cut", () => {
  let sum = 0x811c9dc5;
  for (let at = 0; at < 100_000; at += 7_001) sum = fnv(sum, gen(2, at, Math.min(7_001, 100_000 - at)));
  expect(expected(2, 100_000)).toEqual({ count: 100_000, sum });
  expect(expected(1, 100_000).sum).not.toBe(expected(2, 100_000).sum);
});

test("a count is held to the byte count and the checksum; an error or nothing is named", () => {
  const want = expected(1, 10);
  expect(countedWrong("x", { ...want }, want)).toBeUndefined();
  expect(countedWrong("x", { count: 9, sum: want.sum }, want)).toContain("counted 9 bytes");
  expect(countedWrong("x", { count: 10, sum: want.sum + 1 }, want)).toContain("checksum");
  expect(countedWrong("x", { error: "boom" }, want)).toBe("x: boom");
  expect(countedWrong("x", undefined, want)).toContain("no count");
});
