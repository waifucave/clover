// `app.window.open` (the daemon asks for the user's `clover-core app open <target>` and `app where`): the main window
// moved to a place by the route its own sidebar and commands use (the shell's `shell-act`, the same acts a bot's own
// controls send through `shell.*`), then the window's place as its shell reports it, and its frames. Navigation only:
// no click or key press goes into a page, and the window is never shown, raised, focused, moved or resized. A hidden or
// minimised main window is "not drawn": nothing is sent to it.
import type { AppOpenResult, CapturedWindow } from "@waifucave/clover-protocol";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import type { ShellAct } from "@waifucave/clover-plugin-sdk/ui/bridge";

/** A target as the shell's act and the place that shows it once it is there. Settings is a dialog over the tab (the
 *  shell's `dialog`); every other place shows only with no dialog over it. */
export interface OpenPlan {
  act: ShellAct;
  shows(state: ShellState): boolean;
  what: string;
}

export const OPEN_TARGETS = "bot:<id>, app:<key> or a page's key, settings[:<section>], plugins, archive, code";

/** What `target` asks for, or why it isn't one (with the targets there are). `bots` are the bots' ids; `pages` the keys
 *  the app's pages are opened by (its plugins' `main` entries and sidebar buttons). */
export function planOpen(target: string, known: { bots: readonly string[]; pages: readonly string[] }): OpenPlan | { refused: string } {
  const list = () => `targets: ${OPEN_TARGETS}${known.bots.length > 0 ? `; bots: ${known.bots.join(", ")}` : ""}${known.pages.length > 0 ? `; pages: ${known.pages.join(", ")}` : ""}`;
  const [head, ...rest] = target.split(":");
  const arg = rest.join(":");
  if (head === "settings") {
    return { act: { kind: "settings", ...(arg !== "" ? { section: arg } : {}) }, shows: (s) => s.dialog === "settings" || s.tab.kind === "settings", what: arg !== "" ? `Settings at ${arg}` : "Settings" };
  }
  if ((head === "plugins" || head === "archive") && arg === "") return { act: { kind: "go", target: { page: head } }, shows: (s) => s.dialog === undefined && s.tab.kind === head, what: head === "plugins" ? "Plugins" : "Archive" };
  if (head === "code" && arg === "") return { act: { kind: "go", target: { side: "code" } }, shows: (s) => s.dialog === undefined && s.sidebar.side === "code" && s.tab.kind === "agent", what: "the coding side" };
  if (head === "bot") {
    if (!known.bots.includes(arg)) return { refused: `no bot ${arg === "" ? "named" : arg} here (${list()})` };
    return { act: { kind: "go", target: { bot: arg } }, shows: (s) => s.dialog === undefined && s.tab.kind === "bot" && s.tab.id === arg, what: `${arg}'s tab` };
  }
  const key = head === "app" ? arg : target;
  if (key !== "" && known.pages.includes(key)) return { act: { kind: "go", target: { app: key } }, shows: (s) => s.dialog === undefined && s.tab.kind === "app" && s.tab.id === key, what: `the page ${key}` };
  return { refused: `${target} isn't a place in the app (${list()})` };
}

export interface OpenDeps {
  /** The bots' ids and the pages' keys there are now. */
  known(): { bots: readonly string[]; pages: readonly string[] };
  /** The main window as `app.capture` sees it (drawn, its frames), or undefined when there is none. */
  look(frames: boolean): Promise<CapturedWindow | undefined>;
  /** What the main window's shell last said of its place. */
  state(): ShellState | undefined;
  /** Sends the shell its act (main's own, like a command from the menu). */
  act(act: ShellAct): void;
  /** How long the shell has to show it. */
  waitMs?: number;
  sleep?(ms: number): Promise<void>;
}

const place = (s: ShellState | undefined): AppOpenResult["where"] => (s === undefined ? undefined : {
  tab: { kind: s.tab.kind, ...(s.tab.id !== undefined ? { id: s.tab.id } : {}) },
  ...(s.bot !== undefined ? { bot: s.bot } : {}),
  side: s.sidebar.side,
  ...(s.dialog !== undefined ? { dialog: s.dialog } : {}),
});

/** The answer to `app.window.open`: with a target, the window taken there and whether it shows; without, where it is. */
export async function openWindow(deps: OpenDeps, params: { target?: string; frames?: boolean }): Promise<AppOpenResult> {
  const frames = params.frames !== false;
  const target = params.target !== undefined ? { target: params.target } : {};
  const before = await deps.look(false);
  if (before === undefined) return { ...target, shown: false, reason: "the app has no main window open", drawn: false };
  if (!before.drawn) return { ...target, shown: false, reason: `the main window is ${before.note ?? "not drawn"}`, drawn: false, ...(place(deps.state()) ? { where: place(deps.state()) } : {}) };
  const finish = async (shown: boolean, reason?: string): Promise<AppOpenResult> => {
    const now = await deps.look(frames);
    return { ...target, shown, ...(reason !== undefined ? { reason } : {}), drawn: now?.drawn ?? true, ...(place(deps.state()) ? { where: place(deps.state()) } : {}), ...(frames && now?.frames !== undefined ? { frames: now.frames } : {}) };
  };
  if (params.target === undefined) return finish(true);
  const plan = planOpen(params.target, deps.known());
  if ("refused" in plan) return finish(false, plan.refused);
  deps.act(plan.act);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = Date.now() + (deps.waitMs ?? 5_000);
  for (;;) {
    const s = deps.state();
    if (s !== undefined && plan.shows(s)) return finish(true);
    if (Date.now() > end) return finish(false, `${plan.what} didn't show within ${Math.round((deps.waitMs ?? 5_000) / 1000)} s`);
    await sleep(50);
  }
}
