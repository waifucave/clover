import { describe, expect, test } from "bun:test";
import { EMPTY_ANSWERS_NO_LIST, EMPTY_ANSWERS_WITH_LIST, gateAnswer } from "../src/main/registry-gate";

/** The app's side of `loadRegistry`: the registry it holds, changed only when the gate says so. */
function app() {
  const s = { held: 0, applied: [] as number[], empty: 0, ready: false };
  return {
    s,
    answer(ui: number, o: { listed?: number; safeMode?: boolean } = {}) {
      const g = gateAnswer({ ui, listed: o.listed ?? 261, safeMode: o.safeMode ?? false, held: s.held, emptyBefore: s.empty });
      s.empty = g.emptyAnswers;
      s.ready = g.ready;
      if (g.apply) { s.held = ui; s.applied.push(ui); }
    },
  };
}

describe("an empty UI list while a shell shows", () => {
  test("non-empty, one empty answer, non-empty: the registry (and its mounted frames) is never replaced", () => {
    const a = app();
    a.answer(21);
    a.answer(0);
    expect(a.s.held).toBe(21);
    expect(a.s.ready).toBe(false);
    a.answer(21);
    expect(a.s.applied).toEqual([21, 21]); // the two real answers; the empty one was never applied
    expect(a.s.empty).toBe(0);
  });

  test("four empty answers in a row clear it, and only then is the fallback ready", () => {
    const a = app();
    a.answer(21);
    for (let i = 1; i < EMPTY_ANSWERS_WITH_LIST; i++) { a.answer(0); expect(a.s.held).toBe(21); expect(a.s.ready).toBe(false); }
    a.answer(0);
    expect(a.s.held).toBe(0);
    expect(a.s.ready).toBe(true);
  });

  test("safe mode applies an empty list at once", () => {
    const a = app();
    a.answer(21);
    a.answer(0, { safeMode: true });
    expect(a.s.held).toBe(0);
    expect(a.s.ready).toBe(true);
  });
});

describe("a start with no shell yet", () => {
  test("an empty answer is applied (nothing to keep) but is not ready until it lasts", () => {
    const a = app();
    a.answer(0);
    expect(a.s.applied).toEqual([0]);
    expect(a.s.ready).toBe(false);
  });

  test("an old daemon with no plugin list is ready after more empty answers, so it is not stuck on 'Starting'", () => {
    const a = app();
    for (let i = 1; i < EMPTY_ANSWERS_NO_LIST; i++) { a.answer(0, { listed: 0 }); expect(a.s.ready).toBe(false); }
    a.answer(0, { listed: 0 });
    expect(a.s.ready).toBe(true);
  });
});
