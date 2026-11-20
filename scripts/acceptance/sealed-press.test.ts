// The run's own reading of a sealed press (sealed-press.ts): the ready mark waited for, and the page's "press again" words.
import { describe, expect, test } from "bun:test";
import { pressTurnedDownAsEarly, waitSealedReady, type ReadyRead } from "./sealed-press";

/** A clock the reads advance: each read takes `step` ms. */
function clock(step = 100) {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, read: (values: ReadyRead[]) => { let i = 0; return async () => { const v = values[Math.min(i, values.length - 1)]; i++; t += step; return v; }; } };
}

describe("the sealed page's ready mark, waited for", () => {
  test("only a page that says yes is ready: a page just loaded reads none, a failed read reads nothing, a page not yet visible reads no", async () => {
    const c = clock();
    const r = await waitSealedReady(c.read(["none", undefined, "no", "no", "none", undefined, "yes"]), { timeoutMs: 30_000, noneForMs: 3_000, now: c.now, sleep: c.sleep });
    expect(r).toBe("yes");
  });
  test("a page that says nothing for the whole of noneForMs is an older build: the caller gives it a fixed wait", async () => {
    const c = clock();
    expect(await waitSealedReady(c.read(["none"]), { timeoutMs: 30_000, noneForMs: 3_000, now: c.now, sleep: c.sleep })).toBe("none");
    expect(c.now()).toBeGreaterThanOrEqual(3_000);
    expect(c.now()).toBeLessThan(4_000);
  });
  test("a none that is broken by a mark starts its count over", async () => {
    const c = clock();
    const values: ReadyRead[] = [...Array(10).fill("none"), "no", ...Array(10).fill("none"), "yes"];
    expect(await waitSealedReady(c.read(values), { timeoutMs: 30_000, noneForMs: 3_000, now: c.now, sleep: c.sleep })).toBe("yes");
  });
  test("a page that cannot be read for goneForMs running has gone: 'never' at once, for the caller to find the card's page again", async () => {
    const c = clock();
    expect(await waitSealedReady(c.read([undefined]), { timeoutMs: 30_000, noneForMs: 3_000, goneForMs: 2_000, now: c.now, sleep: c.sleep })).toBe("never");
    expect(c.now()).toBeLessThan(3_000);
  });
  test("a page that never says yes is 'never' at the timeout, not before", async () => {
    const c = clock();
    expect(await waitSealedReady(c.read(["no"]), { timeoutMs: 5_000, noneForMs: 3_000, now: c.now, sleep: c.sleep })).toBe("never");
    expect(c.now()).toBeGreaterThanOrEqual(5_000);
  });
});

describe("a press the page turned down as too early", () => {
  const line = (where: string, word: string) => `2026-11-20T21:02:26.181Z sealed: press on card_022e94a784466cc8c09cc58a button:approve in ${where}: ${word}\n`;
  test("not-visible, opening, settling, no-pointer and late are 'press again', on the island or in the window", () => {
    for (const word of ["not-visible", "opening", "settling", "no-pointer", "late"]) {
      expect(pressTurnedDownAsEarly(line("moss/island#island", word))).toBe(true);
      expect(pressTurnedDownAsEarly(line("the main window", word))).toBe(true);
    }
  });
  test("received, answering and covered are not: a covered press is never pressed again", () => {
    for (const word of ["received", "answering", "covered", "untrusted"]) expect(pressTurnedDownAsEarly(line("moss/island#island", word))).toBe(false);
    expect(pressTurnedDownAsEarly("2026-11-20T21:02:26.181Z sealed: press on card_x button:approve in moss/island#island: fresh report covered after 120 ms\n")).toBe(false);
    expect(pressTurnedDownAsEarly("")).toBe(false);
  });
});
