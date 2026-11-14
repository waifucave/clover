// Alpha's own bar drags the window (checklist row 2.36, `shell.dragWindow`): with the stock bar not drawn on her tab (the stock
// sidebar is beside it, as on every tab; her tab draws her own controls, `.ac`, which keep a handle `.ac__drag` that calls
// `shell.dragWindow()` on a press), a real
// pointer press on that handle, a move and a release, as the frame sees them, must move the window by the cursor's offset.
// The window is offscreen, so where it went is read from the app's own log, which says the window's own position before
// and after (`window: moved by its title area, from (x, y) to (x, y)`, index.ts dragEnd). A refused drag logs "a drag was refused".
import { fail, sleep, treeDocs, until, type ExampleCtx, toAlphasTab } from "./example-steps";

export const DRAG_STEP = "Alpha's own controls drag the window: a real press on her drag handle (shell.dragWindow), a move and a release move the window by the cursor's offset, on her own handle in her own layer";

export const DRAG_BY = { x: 120, y: 60 } as const;

/** The window's move read from the app's log lines (the last one after `since`): its offset, or why not. Exported for the unit test. */
export function moveOf(lines: readonly string[], since: number): { dx: number; dy: number; line: string } | undefined {
  const mine = lines.filter((l) => l.includes("window: moved by its title area")).slice(since);
  const line = mine[mine.length - 1];
  if (line === undefined) return undefined;
  const m = /from \((-?\d+), (-?\d+)\) to \((-?\d+), (-?\d+)\)/.exec(line);
  if (m === null) return undefined;
  return { dx: Number(m[3]) - Number(m[1]), dy: Number(m[4]) - Number(m[2]), line };
}

export async function dragStep(ctx: ExampleCtx, _session: string): Promise<string> {
  await toAlphasTab(ctx);
  const { cdp } = ctx;
  const handle = await until("Alpha's drag handle (.ac__drag in her controls)", 60_000, async () => {
    for (const d of await treeDocs(cdp)) {
      if ((await cdp.evaluate(d.session, "!!document.querySelector('.ac')").catch(() => false)) !== true) continue;
      const c = await cdp.centerOf(d.session, ".ac__drag").catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  });
  // The press must land on her handle itself, in her layer's document: a native drag region of the stock bar can't be the
  // cause, since a DevTools press never starts an OS-level drag, so the window can only move through `shell.dragWindow`.
  const hit = await cdp.evaluate(handle.session, `(() => { const e = document.elementFromPoint(${handle.c.x}, ${handle.c.y}); return e && e.closest('.ac__drag') ? location.origin : null; })()`);
  if (typeof hit !== "string" || !hit.startsWith("clover-plugin://alpha")) fail(`the point (${Math.round(handle.c.x)},${Math.round(handle.c.y)}) isn't Alpha's drag handle in her own layer (${String(hit)})`);
  const log = () => ctx.appLog().split("\n");
  const was = log().filter((l) => l.includes("window: moved by its title area")).length;
  const refusedBefore = log().filter((l) => l.includes("window: a drag was refused")).length;
  const { x, y } = handle.c;
  const press = (type: string, px: number, py: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x: px, y: py, button: "left", buttons, clickCount: 1 }, handle.session);
  await press("mouseMoved", x, y, 0);
  await press("mousePressed", x, y, 1);
  for (let i = 1; i <= 6; i++) { await press("mouseMoved", x + i * (DRAG_BY.x / 6), y + i * (DRAG_BY.y / 6), 1); await sleep(40); }
  await press("mouseReleased", x + DRAG_BY.x, y + DRAG_BY.y, 0);
  const move = await until("the app's log of the window's move", 8_000, async () => moveOf(log(), was)).catch(() => undefined);
  const refused = log().filter((l) => l.includes("window: a drag was refused")).slice(refusedBefore);
  if (move === undefined) return fail(`a drag of (${DRAG_BY.x}, ${DRAG_BY.y}) from Alpha's handle (${Math.round(x)},${Math.round(y)}) moved the window nowhere${refused.length > 0 ? `: ${refused[refused.length - 1]}` : ": the app logged no move and no refusal"} [apps/desktop/src/main/ui/electron.ts shell call → index.ts windowDrag]`);
  if (Math.abs(move.dx - DRAG_BY.x) > 4 || Math.abs(move.dy - DRAG_BY.y) > 4) fail(`the window moved by (${move.dx}, ${move.dy}), not the (${DRAG_BY.x}, ${DRAG_BY.y}) the cursor moved`);
  return `a real press on Alpha's drag handle (${Math.round(x)},${Math.round(y)}) and a move of (${DRAG_BY.x}, ${DRAG_BY.y}) moved the window by (${move.dx}, ${move.dy}): ${move.line.replace(/^\S+ /, "")}`;
}
