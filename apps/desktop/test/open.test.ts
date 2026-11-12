// `app.window.open` with a fake main window and shell (open.ts): the route its own sidebar uses is sent as the shell's
// act, the answer waits until the shell says the place shows, an unknown target is refused with the targets there are,
// a hidden window changes nothing, and `where` sends nothing.
import { describe, expect, test } from "bun:test";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import type { ShellAct } from "@waifucave/clover-plugin-sdk/ui/bridge";
import type { CapturedWindow } from "@waifucave/clover-protocol";
import { openWindow, planOpen, type OpenDeps } from "../src/main/open";

const known = { bots: ["alpha", "luna"], pages: ["ex-timeline", "reel"] };
const state = (tab: ShellState["tab"], side: "bots" | "code" = "bots"): ShellState => ({ tab, ...(tab.kind === "bot" ? { bot: tab.id } : {}), sidebar: { collapsed: false, side }, panels: { open: [], available: [] }, safeArea: { left: 80, top: 44 } });
const win = (drawn = true): CapturedWindow => ({ name: "main", bounds: { x: 0, y: 0, width: 1280, height: 820 }, scale: 2, visible: drawn, drawn, ...(drawn ? {} : { note: "hidden: not drawn" }), views: [], frames: [{ origin: "clover-core://app", width: 1280, height: 820, visibility: "visible" }] });

/** A shell that shows what each act asks for after `delay` checks, or never. */
function fake(o: { drawn?: boolean; shows?: (act: ShellAct) => ShellState | undefined; delay?: number } = {}) {
  const acts: ShellAct[] = [];
  let now: ShellState = state({ kind: "bot", id: "alpha" });
  let pending: { at: number; to: ShellState } | undefined;
  let checks = 0;
  const deps: OpenDeps = {
    known: () => known,
    look: async (frames) => ({ ...win(o.drawn ?? true), ...(frames ? {} : { frames: undefined }) }),
    state: () => {
      checks++;
      if (pending && checks >= pending.at) { now = pending.to; pending = undefined; }
      return now;
    },
    act: (a) => {
      acts.push(a);
      const to = o.shows ? o.shows(a) : undefined;
      if (to !== undefined) pending = { at: checks + (o.delay ?? 3), to };
    },
    waitMs: 300,
    sleep: async () => {},
  };
  return { deps, acts };
}

const show = (a: ShellAct): ShellState | undefined => {
  if (a.kind === "settings") return state({ kind: "settings" });
  if (a.kind !== "go") return undefined;
  const t = a.target as Record<string, string>;
  if (t.bot) return state({ kind: "bot", id: t.bot });
  if (t.app) return state({ kind: "app", id: t.app });
  if (t.page) return state({ kind: t.page as "plugins" });
  if (t.side === "code") return state({ kind: "agent", id: "c1" }, "code");
  return undefined;
};

describe("app.window.open", () => {
  test("each target is the shell's own act, and the answer waits until the place shows", async () => {
    for (const [target, act, where] of [
      ["settings", { kind: "settings" }, { kind: "settings" }],
      ["settings:devices", { kind: "settings", section: "devices" }, { kind: "settings" }],
      ["bot:luna", { kind: "go", target: { bot: "luna" } }, { kind: "bot", id: "luna" }],
      ["app:reel", { kind: "go", target: { app: "reel" } }, { kind: "app", id: "reel" }],
      ["ex-timeline", { kind: "go", target: { app: "ex-timeline" } }, { kind: "app", id: "ex-timeline" }],
      ["plugins", { kind: "go", target: { page: "plugins" } }, { kind: "plugins" }],
      ["archive", { kind: "go", target: { page: "archive" } }, { kind: "archive" }],
      ["code", { kind: "go", target: { side: "code" } }, { kind: "agent", id: "c1" }],
    ] as const) {
      const f = fake({ shows: show });
      const r = await openWindow(f.deps, { target, frames: true });
      expect({ target, acts: f.acts, shown: r.shown, tab: r.where?.tab, frames: r.frames?.length }).toEqual({ target, acts: [act as ShellAct], shown: true, tab: where, frames: 1 });
    }
  });

  test("a place that never shows says so after the wait; a wrong place doesn't count", async () => {
    const f = fake({ shows: () => state({ kind: "bot", id: "alpha" }) });
    const r = await openWindow(f.deps, { target: "bot:luna" });
    expect({ shown: r.shown, reason: r.reason }).toEqual({ shown: false, reason: "luna's tab didn't show within 0 s" });
  });

  test("an unknown target is refused with the targets, bots and pages there are; nothing is sent", async () => {
    const f = fake({ shows: show });
    for (const target of ["bot:nobody", "app:nope", "nope", "plugins:x"]) {
      const r = await openWindow(f.deps, { target });
      expect({ target, shown: r.shown }).toEqual({ target, shown: false });
      expect(r.reason).toContain("targets: bot:<id>, app:<key> or a page's key, settings[:<section>], plugins, archive, code; bots: alpha, luna; pages: ex-timeline, reel");
    }
    expect(f.acts).toEqual([]);
  });

  test("a hidden or minimised main window is not drawn: nothing is sent, and it says so", async () => {
    const f = fake({ drawn: false, shows: show });
    const r = await openWindow(f.deps, { target: "settings" });
    expect({ shown: r.shown, drawn: r.drawn, reason: r.reason, frames: r.frames }).toEqual({ shown: false, drawn: false, reason: "the main window is hidden: not drawn", frames: undefined });
    expect(f.acts).toEqual([]);
  });

  test("where: the place and the frames, nothing sent", async () => {
    const f = fake({ shows: show });
    const r = await openWindow(f.deps, {});
    expect(r).toEqual({ shown: true, drawn: true, where: { tab: { kind: "bot", id: "alpha" }, bot: "alpha", side: "bots" }, frames: win().frames });
    expect(f.acts).toEqual([]);
  });

  test("planOpen names the shell's acts only (go and settings: never a click, a key or a window act)", () => {
    for (const t of ["settings", "bot:alpha", "app:reel", "plugins", "archive", "code"]) {
      const p = planOpen(t, known);
      expect({ t, kind: "act" in p ? p.act.kind : "refused" }).toEqual({ t, kind: t === "settings" ? "settings" : "go" });
    }
  });
});
