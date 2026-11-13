// `app.window.render` (the daemon asks for a bot's `AppScreenshot`): a place in the app drawn in a render window — a
// hidden, offscreen copy of the main window the user never sees — and its picture, so a bot that builds or fixes a
// plugin can look at what it made. The user's own main window is never moved: the render window takes the route the
// sidebar uses (the shell's `shell-act`, as `app open` does), is captured once the place shows, and is destroyed after
// the capture or the timeout. One at a time, queued.
//
// The render window's rule (the coordinator's, 14e): it never creates a live sealed frame. Where a card's sealed field
// or button would be, it draws a plain placeholder of the same size (runtime.ts `#placeholderOf`); it registers no
// answer key, counts for nothing in a card's timing or visibility, takes no input (focusable false, mouse ignored,
// keys dropped), plays no sound or voice (muted, and speech goes to the main window alone), and is never shown.
//
// `window` is the user's main window as it is now (app.capture's picture), refused while Settings shows there; a
// hidden or minimised window is "not drawn". Settings itself is never a target.
import type { AppRenderResult, AppWindowRenderParams, CapturedWindow } from "@waifucave/clover-protocol";
import type { ShellState } from "@waifucave/clover-plugin-sdk";
import type { ShellAct } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { OPEN_TARGETS, planOpen } from "./open";

export const RENDER_TARGETS = "app:<plugin id or page key>, bot:<id>, plugins, archive, code, window";
/** The longest a render may take, start to picture. */
export const RENDER_TIMEOUT_MS = 20_000;
/** How long after the place shows before the picture at least (its images and fonts, a part's first layout). */
export const RENDER_SETTLE_MS = 900;
/** Then until its frames have stopped coming (a conversation's history, a card's frames) for this long, up to the cap. */
export const RENDER_QUIET_MS = 700;
export const RENDER_SETTLE_CAP_MS = 6_000;
/** A model's copy is at most this on its long edge (the full picture is kept as it was drawn). */
export const PREVIEW_LONG_EDGE = 1568;
/** At most this many of a page's console lines come back. */
export const RENDER_CONSOLE_MAX = 30;

/** One console line a page of the render window wrote (an error or a warning), with the plugin whose frame wrote it. */
export interface RenderConsoleLine {
  plugin: string;
  level: "error" | "warning";
  message: string;
}

/** A render window while it is open. */
export interface RenderHandle {
  /** What its shell last said of its place. */
  state(): ShellState | undefined;
  /** Sends its shell an act (the route the sidebar uses). */
  act(act: ShellAct): void;
  /** Its picture (and frames), drawn at the size asked. */
  capture(frames: boolean): Promise<CapturedWindow>;
  /** How many frames its page holds now (the place settles when this stops changing). */
  frameCount?(): number;
  /** The console lines its pages wrote so far. */
  console(): readonly RenderConsoleLine[];
  /** Destroys it (and everything mounted in it). */
  close(): void;
}

export interface RenderDeps {
  known(): { bots: readonly string[]; pages: readonly string[] };
  /** Opens a render window of that content size, its core page loaded. `early` is told how to destroy the window as soon
   *  as it exists, before its page has loaded (a load that hangs is still closed at the timeout). */
  open(size: { width: number; height: number }, early?: (destroy: () => void) => void): Promise<RenderHandle>;
  /** The user's main window as `app.capture` sees it, with its picture. */
  look(frames: boolean): Promise<CapturedWindow | undefined>;
  /** What the main window's shell last said of its place. */
  mainState(): ShellState | undefined;
  /** A smaller copy of a PNG (base64) whose long edge is at most `edge`, for a model. */
  shrink?(png: string, edge: number): { png: string; width: number; height: number } | undefined;
  timeoutMs?: number;
  settleMs?: number;
  quietMs?: number;
  sleep?(ms: number): Promise<void>;
}

/** One render at a time: each waits for the one before it. */
export class RenderQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;
  get waiting(): number {
    return this.#waiting;
  }
  run<T>(job: () => Promise<T>): Promise<T> {
    this.#waiting++;
    const next = this.#tail.catch(() => undefined).then(job).finally(() => { this.#waiting--; });
    this.#tail = next;
    return next;
  }
}

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function picture(shot: CapturedWindow, deps: RenderDeps): Pick<AppRenderResult, "png" | "pixels" | "preview" | "drawn" | "note"> {
  if (!shot.drawn || shot.png === undefined) return { drawn: false, ...(shot.note !== undefined ? { note: shot.note } : {}) };
  const pixels = shot.pixels ?? { width: 0, height: 0 };
  const long = Math.max(pixels.width, pixels.height);
  const preview = long > PREVIEW_LONG_EDGE ? deps.shrink?.(shot.png, PREVIEW_LONG_EDGE) : undefined;
  return { drawn: true, png: shot.png, pixels, ...(preview !== undefined ? { preview } : {}), ...(shot.note !== undefined ? { note: shot.note } : {}) };
}

const placeOf = (s: ShellState | undefined): AppRenderResult["where"] => (s === undefined ? undefined : {
  tab: { kind: s.tab.kind, ...(s.tab.id !== undefined ? { id: s.tab.id } : {}) },
  ...(s.bot !== undefined ? { bot: s.bot } : {}),
  side: s.sidebar.side,
  ...(s.dialog !== undefined ? { dialog: s.dialog } : {}),
});

/** Settings shows in a window: the dialog over its tab (or, from an older shell, the tab itself). */
const settingsShows = (s: ShellState | undefined): boolean => s?.dialog === "settings" || s?.tab.kind === "settings";

/** The answer to `app.window.render`. Never throws for a place that doesn't draw: `shown: false` says why. */
export async function renderPlace(deps: RenderDeps, params: AppWindowRenderParams): Promise<AppRenderResult> {
  const { target, size } = params;
  const frames = params.frames !== false;
  const base = { target, size };
  if (target === "window") {
    const state = deps.mainState();
    // A window whose shell hasn't said where it is might be showing Settings: not captured (fail closed).
    if (state === undefined) return { ...base, shown: false, drawn: false, reason: "the user's window hasn't said what it shows: it isn't captured for a bot" };
    if (settingsShows(state)) return { ...base, shown: false, drawn: false, reason: "Settings is showing in the user's window: it isn't captured for a bot" };
    const shot = await deps.look(frames);
    if (shot === undefined) return { ...base, shown: false, drawn: false, reason: "the app has no main window open" };
    // Settings may have opened while the picture was taken: it is never handed over.
    if (deps.mainState() === undefined || settingsShows(deps.mainState())) return { ...base, shown: false, drawn: false, reason: "Settings is showing in the user's window: it isn't captured for a bot" };
    const pic = picture(shot, deps);
    return {
      ...base, shown: pic.drawn, ...pic, ...(pic.drawn ? {} : { reason: `the user's window is ${shot.note ?? "not drawn"}` }),
      ...(placeOf(state) ? { where: placeOf(state) } : {}), ...(frames && shot.frames !== undefined ? { frames: shot.frames } : {}),
    };
  }
  const plan = planOpen(target, deps.known());
  if ("refused" in plan) return { ...base, shown: false, drawn: false, reason: plan.refused.replace(OPEN_TARGETS, RENDER_TARGETS) };
  if (plan.act.kind === "settings") return { ...base, shown: false, drawn: false, reason: "Settings isn't drawn for a bot" };
  const sleep = deps.sleep ?? sleeper;
  const timeoutMs = deps.timeoutMs ?? RENDER_TIMEOUT_MS;
  const end = Date.now() + timeoutMs;
  let handle: RenderHandle | undefined;
  let destroy: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    if (handle !== undefined) { closed = true; handle.close(); } else if (destroy !== undefined) { closed = true; destroy(); }
  };
  const work = (async (): Promise<AppRenderResult> => {
    handle = await deps.open(size, (d) => { destroy = d; });
    if (closed) handle.close();
    // The shell says where it starts once it draws; then the route, unless it starts there.
    let sent = false;
    for (;;) {
      if (closed) throw new Error("timed out");
      const s = handle.state();
      if (s !== undefined && plan.shows(s)) break;
      if (s !== undefined && !sent) { handle.act(plan.act); sent = true; }
      if (Date.now() > end) return { ...base, shown: false, drawn: false, reason: `${plan.what} didn't show within ${Math.round(timeoutMs / 1000)} s`, ...(placeOf(s) ? { where: placeOf(s) } : {}), console: handle.console().slice(0, RENDER_CONSOLE_MAX) };
      await sleep(50);
    }
    await sleep(deps.settleMs ?? RENDER_SETTLE_MS);
    // Its frames settle: a fresh window loads the place's history and a waiting card's frames after it shows.
    if (handle.frameCount !== undefined) {
      const cap = Date.now() + RENDER_SETTLE_CAP_MS;
      let count = handle.frameCount();
      let since = Date.now();
      while (Date.now() < cap && Date.now() - since < (deps.quietMs ?? RENDER_QUIET_MS)) {
        await sleep(100);
        const now = handle.frameCount();
        if (now !== count) { count = now; since = Date.now(); }
      }
    }
    // Settings never shows in a picture for a bot, in this window either (before the capture and after it).
    const settings = { ...base, shown: false, drawn: false, reason: "Settings showed in the render window: it isn't captured for a bot" } as const;
    if (settingsShows(handle.state())) return settings;
    const shot = await handle.capture(frames);
    if (settingsShows(handle.state())) return settings;
    const pic = picture(shot, deps);
    return {
      ...base, shown: true, ...pic, ...(pic.drawn ? {} : { reason: `the render window ${shot.note ?? "drew nothing"}` }),
      ...(placeOf(handle.state()) ? { where: placeOf(handle.state()) } : {}),
      ...(frames && shot.frames !== undefined ? { frames: shot.frames } : {}),
      console: handle.console().slice(0, RENDER_CONSOLE_MAX),
    };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<AppRenderResult>((resolve) => {
    timer = setTimeout(() => resolve({ ...base, shown: false, drawn: false, reason: `${plan.what} didn't draw within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs + 2_000);
  });
  try {
    return await Promise.race([work.catch((err: unknown) => ({ ...base, shown: false, drawn: false, reason: `the render window failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 480) })), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    close();
    // A window still opening when the time ran out is closed as soon as it is there.
    void work.catch(() => undefined).then(() => close());
  }
}
