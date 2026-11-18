// A sealed button's frame stuck under load (sealed-redraw.ts, ported from MOSS Code): a page that never says visible gets its
// frame hidden and shown again at 700 ms and 2 s after it loaded, at most twice, through its embedder with no user gesture; a
// page that said visible once is never touched.
import { describe, expect, test } from "bun:test";
import { SEALED_REDRAW_AT_MS, watchSealedDraw, type RedrawDeps, type RedrawFrame } from "../src/main/sealed-redraw";

function world(opts: { seen?: boolean; visibleNow?: boolean; element?: string } = {}) {
  const calls: { code: string; gesture: boolean | undefined }[] = [];
  const parent: RedrawFrame = { url: "moss-app://app/", detached: false, parent: null, executeJavaScript: async (code, gesture) => { calls.push({ code, gesture }); return true; } };
  const url = "moss-sealed://card/card_x/button:approve?token=se_tok";
  const frame: RedrawFrame = { url, detached: false, parent, executeJavaScript: async () => true };
  const timers: { at: number; fn: () => void }[] = [];
  const lines: string[] = [];
  const everSeen = new Set<string>(opts.seen === true ? ["se_tok"] : []);
  const deps: RedrawDeps = {
    frameOf: () => frame,
    sealed: { elementOf: () => opts.element ?? "button:approve", cardOf: () => "card_x", isPending: () => true, isTokenVisible: () => opts.visibleNow === true },
    everSeen, inWindow: () => true, log: (l) => lines.push(l), setTimeout: (fn, at) => { timers.push({ at, fn }); return 0; },
  };
  const runAll = async () => { for (const t of timers) t.fn(); await new Promise((r) => setTimeout(r, 10)); };
  return { deps, calls, timers, lines, runAll, everSeen };
}

describe("a sealed button's frame that never says it shows", () => {
  test("is hidden and shown again at 700 ms and 2 s, twice at most, by its embedder with no user gesture", async () => {
    const w = world();
    watchSealedDraw(w.deps, 1, 2);
    expect(w.timers.map((t) => t.at)).toEqual([...SEALED_REDRAW_AT_MS]);
    expect(SEALED_REDRAW_AT_MS).toEqual([700, 2000]);
    await w.runAll();
    expect(w.calls).toHaveLength(2);
    expect(w.calls.every((c) => c.gesture === false)).toBe(true);
    expect(w.calls[0]!.code).toContain('f.style.visibility = "hidden"');
    expect(w.lines.every((l) => l.includes("in MOSS's window said nothing visible"))).toBe(true);
  });

  test("a page that said visible once, or shows now, is never touched; nor is a frame that isn't a button's", async () => {
    for (const w of [world({ seen: true }), world({ visibleNow: true })]) {
      watchSealedDraw(w.deps, 1, 2);
      await w.runAll();
      expect(w.calls).toEqual([]);
    }
    const field = world({ element: "field:title" });
    watchSealedDraw(field.deps, 1, 2);
    expect(field.timers).toEqual([]);
    // Said visible between the two marks: the second one does nothing.
    const later = world();
    watchSealedDraw(later.deps, 1, 2);
    later.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    later.everSeen.add("se_tok");
    later.timers[1]!.fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(later.calls).toHaveLength(1);
  });
});
