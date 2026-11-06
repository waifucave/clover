import { describe, expect, test } from "bun:test";
import { readSteps } from "../client/history";

const entries = [{ id: 7, url: "a" }, { id: 8, url: "b" }, { id: 9, url: "c" }];

describe("readSteps", () => {
  test("the entries before and after the current one", () => {
    expect(readSteps({ currentIndex: 1, entries })).toEqual({ back: 7, forward: 9 });
  });
  test("none before the first, none after the last", () => {
    expect(readSteps({ currentIndex: 0, entries })).toEqual({ forward: 8 });
    expect(readSteps({ currentIndex: 2, entries })).toEqual({ back: 8 });
    expect(readSteps({ currentIndex: 0, entries: [entries[0]] })).toEqual({});
  });
  test("an answer it does not understand is no history", () => {
    for (const bad of [undefined, null, {}, "x", { currentIndex: "1", entries }, { currentIndex: 1, entries: "no" }, { currentIndex: 1, entries: [null, null, null] }]) {
      expect(readSteps(bad)).toEqual({});
    }
  });
});
