// The window's core root (`moss-core://app/`, spec §5.5): core code, no plugin's. It mounts the entry that fills
// `app.root` (a surface window: its one `app.surface` entry) as a frame from that plugin's own layer, and owns what
// the core draws around it: the safe-mode banner (§5.8), the note when nothing fills the window, and the placeholder
// with a reload when the shell's layer stops (S9: detected by the main process's census).
import { showKey, showPlugins, showWelcome } from "./pages";
import { EMPTY_STRINGS, translate, type LayerBridge, type LayerMessage, type MountInfo, type SpotView, type StringTable } from "@waifucave/moss-plugin-sdk/ui/bridge";

interface RootBridge {
  frameMetrics(m: { top: number; start: number; end: number }): void;
  command(name: string): void;
  call(name: string, params?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    mossRoot?: RootBridge;
  }
  interface Navigator {
    windowControlsOverlay?: EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect };
  }
}

const bridge = window.mossLayer as LayerBridge;
const root = window.mossRoot as RootBridge;
const stage = document.getElementById("moss-stage")!;
const banner = document.getElementById("moss-banner")!;
const pageHost = document.getElementById("moss-page")!;

function cssName(token: string): string {
  return `--moss-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
}

function applyTokens(tokens: Readonly<Record<string, string | number>>): void {
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(cssName(name), String(value));
}

function note(lines: string[], action?: { label: string; run: () => void }): void {
  stage.replaceChildren();
  const box = document.createElement("div");
  box.className = "moss-core-note";
  box.setAttribute("role", "status");
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    box.append(p);
  }
  if (action !== undefined) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    box.append(b);
  }
  stage.append(box);
}

/** What the app says of its release (the main process's `ReleaseNotice`, release.ts): the words, and "Switch now" while a newer app waits. */
interface ReleaseNoticeView { kind: string; phase?: string; needs?: string; incoming?: string; turns?: number; agents?: number; command?: string }
function releaseWords(n: ReleaseNoticeView): { text: string; action?: { label: string; run: () => void } } {
  const p = { needs: n.needs ?? "", incoming: n.incoming ?? "", turns: n.turns ?? 0, agents: n.agents ?? 0, command: n.command ?? "" };
  if (n.kind === "cannot" && n.command !== undefined) return { text: t("release.cannot-reset", p) };
  if (n.kind === "updating") return { text: t(`release.${n.phase ?? "checking"}`, p) };
  if (n.kind === "waiting") {
    return { text: t(p.turns + p.agents > 0 ? "release.waiting-for" : "release.waiting", p), action: { label: t("release.switch-now"), run: () => void root.call("release.switchNow") } };
  }
  if (n.kind === "engine-down") return { text: t("release.engine-down", p), action: { label: t("release.retry"), run: () => void root.call("release.retry") } };
  return { text: t(`release.${n.kind}`, p) };
}
const releaseBanner = document.getElementById("moss-release")!;
/** The release notice as a banner over a shell that is showing (the older app that is already open, updating itself). */
async function drawRelease(): Promise<void> {
  const state = await root.call("registry.state").catch(() => undefined) as { release?: ReleaseNoticeView } | undefined;
  releaseBanner.replaceChildren();
  // With no shell mounted the stage's note says it (renderOrNote); the banner is for a shell that is showing.
  if (state?.release === undefined || shown === undefined) { releaseBanner.hidden = true; return; }
  const w = releaseWords(state.release);
  releaseBanner.hidden = false;
  releaseBanner.append(w.text);
  if (w.action !== undefined) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w.action.label;
    b.addEventListener("click", w.action.run);
    releaseBanner.append(b);
  }
}

let info: MountInfo;
let shown: { mount: string; url: string } | undefined;
let strings: StringTable = EMPTY_STRINGS;
/** The core's own text, in the app's language (`moss.core.…`, core-strings.ts). */
const t = (key: string, params?: Record<string, string | number>) => translate(strings, `moss.core.${key}`, params);

function frameFor(item: { mount: string; url: string; ref: string; layer: string; isolated?: true; autoplay?: true; microphone?: true }): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = item.url;
  frame.title = item.ref;
  frame.dataset.mossEntry = item.ref;
  frame.dataset.mossLayer = item.layer;
  frame.dataset.mossMount = item.mount;
  // Only a plugin whose manifest asks (`client.isolated`) gets a cross-origin isolated frame. A plugin's page is placed inside
  // the `moss` layer's frames (the shell, the main spot), and a frame is isolated only when every frame above it passes the
  // permission down: so the `moss` layer's frames carry it too (the delegation only; they isolate no plugin).
  // A frame may open the microphone when a plugin of its own layer holds `microphone` (the runtime's `microphone` flag; main's
  // permission handler answers by the same layer).
  const allow = [
    item.isolated === true || item.layer === "moss" ? "cross-origin-isolated" : "",
    item.microphone === true ? "microphone" : "",
    item.autoplay === true ? "autoplay" : "",
  ];
  frame.setAttribute("allow", allow.filter((a) => a !== "").join("; "));
  frame.referrerPolicy = "no-referrer";
  return frame;
}

/** A reload's new document, waiting to take the old one's place: called when it has drawn (its first size report). */
const rendered = new Map<string, () => void>();

/** The same mount's document loaded again (a layer installed after it was served, which it may now frame): the new
 *  frame loads hidden and inert behind the one showing (no input, no focus, nothing of it seen: a card it draws shows
 *  only once it is the page), and takes its place once its part has drawn (the size report every part's document
 *  sends after its first render), so the window never shows an empty stage or a first page that isn't the user's (the
 *  parts keep their place with `useKept`). The old one is inert meanwhile: main let it go already. After 5 s the new
 *  one takes the place anyway, but never before it has loaded (a document that hasn't is the blank one). */
function reloadIn(item: { mount: string; url: string; ref: string; layer: string; isolated?: true; autoplay?: true; microphone?: true }): void {
  const frames = Array.from(stage.querySelectorAll("iframe")).filter((f) => f.dataset.mossMount === item.mount);
  // A load still pending from an earlier reload is for a token main has spent: it goes, and the frame showing stays.
  for (const f of frames) if (f.dataset.mossPending !== undefined) f.remove();
  const old = frames.filter((f) => f.isConnected);
  if (old.length === 0) return mount(item);
  for (const f of old) f.inert = true;
  const frame = frameFor(item);
  frame.style.visibility = "hidden";
  frame.inert = true;
  frame.dataset.mossPending = "";
  let swapped = false;
  let loaded = false;
  let capped = false;
  const swap = () => {
    if (swapped || !frame.isConnected) return;
    swapped = true;
    if (rendered.get(item.mount) === swap) rendered.delete(item.mount);
    frame.style.visibility = "";
    frame.inert = false;
    delete frame.dataset.mossPending;
    for (const f of old) f.remove();
  };
  rendered.set(item.mount, swap);
  frame.addEventListener("load", () => {
    loaded = true;
    if (capped) swap();
  }, { once: true });
  setTimeout(() => {
    capped = true;
    if (loaded) swap();
  }, 5_000);
  stage.append(frame);
  shown = { mount: item.mount, url: item.url };
}

function mount(item: { mount: string; url: string; ref: string; layer: string; isolated?: true; autoplay?: true; microphone?: true }): void {
  if (shown?.mount === item.mount && shown.url === item.url && stage.querySelector("iframe") !== null) return;
  stage.replaceChildren(frameFor(item));
  shown = { mount: item.mount, url: item.url };
}

async function render(): Promise<void> {
  let view: SpotView;
  try {
    view = await bridge.resolve(info.mount, info.spot);
  } catch (err) {
    note([t("root.failed", { error: err instanceof Error ? err.message : String(err) })]);
    return;
  }
  const item = view.items.find((i) => i.kind === "frame");
  if (item === undefined || item.kind !== "frame") {
    shown = undefined;
    syncDrag();
    // Not yet: the daemon is still opening its registry (a cold start), and a nudge will draw the shell. The fallback is for
    // a daemon that answered with its registry open and nothing to fill the window.
    if (!info.context.safeMode && info.context.surface === undefined) {
      const state = await root.call("registry.state").catch(() => undefined);
      const release = (state as { release?: ReleaseNoticeView } | undefined)?.release;
      if (release !== undefined) {
        // Behind or ahead of the engine's release: that, and not "Starting MOSS…", is what the window is waiting for.
        const w = releaseWords(release);
        note([w.text], w.action);
        syncDrag();
        return;
      }
      if ((state as { ready?: unknown } | undefined)?.ready !== true) {
        // "Starting MOSS…" is never the end: after a long time with no daemon the root says so, and what to do (the
        // app keeps trying, and draws the shell as soon as a daemon answers).
        note([(state as { down?: unknown } | undefined)?.down === true ? t("root.down") : t("root.starting")]);
        syncDrag();
        return;
      }
    }
    note(info.context.safeMode ? [t("root.empty-safe")] : [t("root.empty")], info.context.safeMode ? undefined : { label: t("root.restart-safe"), run: () => root.command("restart-safe-mode") });
    syncDrag();
    return;
  }
  mount(item);
  syncDrag();
}

/** The core's own drawing (the note, a page) is in this main frame, which is where Chromium honors a drag region: a strip
 *  over the title area drags the window. With the shell's frame showing, the strip is off (the shell's own drag goes through
 *  the main process, which checks it). The banner's buttons stay clickable (they sit above the strip). */
function syncDrag(): void {
  const drag = document.getElementById("moss-drag");
  if (drag === null) return;
  drag.hidden = info?.context.surface !== undefined || (stage.querySelector("iframe") !== null && page === null);
}

function onMessage(m: LayerMessage): void {
  if (m.type === "respot") { void render(); void drawRelease(); }
  if (m.type === "rect-query") {
    // The menu broker asks where the frame is in the window.
    const el = Array.from(stage.querySelectorAll("iframe")).find((f) => f.dataset.mossMount === m.child);
    const b = el?.getBoundingClientRect();
    bridge.rectReply(m.id, b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height });
  }
  if (m.type === "tokens" && m.tokens[info.mount] !== undefined) applyTokens(m.tokens[info.mount]!);
  if (m.type === "strings") {
    strings = m.strings;
    document.documentElement.lang = strings.lang;
    drawBanner();
    if (shown === undefined) void render();
    if (page !== null) void showPage(page);
  }
  if (m.type === "core-page") void showPage(m.page);
  // A reload's new document drew: it takes the old one's place (the old one is let go in main, so this is the new one's).
  if (m.type === "child-size") rendered.get(m.child)?.();
  if (m.type === "child-reload" && m.child === shown?.mount) {
    const frame = stage.querySelector("iframe");
    // The new frame gets the flags main sends with the reload: its `allow` as main has it now, as a first load's item gives it.
    reloadIn({ mount: m.child, url: m.url, ref: frame?.dataset.mossEntry ?? "", layer: frame?.dataset.mossLayer ?? "", ...(m.isolated === true ? { isolated: true as const } : {}), ...(m.autoplay === true ? { autoplay: true as const } : {}), ...(m.microphone === true ? { microphone: true as const } : {}) });
  }
  if (m.type === "child-gone" && m.child === shown?.mount) {
    const child = m.child;
    note([t("root.stopped")], {
      label: t("root.reload"),
      run: () => void bridge.reload(child).then((url) => {
        if (url === undefined) return;
        shown = undefined;
        void render();
      }),
    });
  }
}

/** The title bar's area, where the OS draws the window's own controls over the page (Windows and Linux), for the
 *  frame's variables. macOS's traffic lights are a fixed inset, which the main process knows. */
function reportTitlebar(): void {
  const wco = navigator.windowControlsOverlay;
  if (wco === undefined || !wco.visible) return;
  const r = wco.getTitlebarAreaRect();
  root.frameMetrics({ top: r.height, start: r.x, end: Math.max(0, window.innerWidth - (r.x + r.width)) });
}

function drawBanner(): void {
  if (!info.context.safeMode || info.context.surface !== undefined) return;
  banner.hidden = false;
  banner.textContent = t("safe.banner");
  const manage = document.createElement("button");
  manage.type = "button";
  manage.textContent = t("safe.manage");
  manage.addEventListener("click", () => void showPage("plugins"));
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = t("safe.restart-normally");
  b.addEventListener("click", () => root.command("restart-normally"));
  banner.append(manage, b);
}

/** The core's own page over the window, if any: the welcome guide, the plugin manager (core code; pages.ts). */
let page: "welcome" | "plugins" | "key" | null = null;
/** One page drawn at a time, in the order asked (a second ask while one draws waits for it). */
let pageRun: Promise<void> = Promise.resolve();
function showPage(which: "welcome" | "plugins" | "key" | null): Promise<void> {
  pageRun = pageRun.then(() => drawPage(which)).catch(() => undefined);
  return pageRun;
}
async function drawPage(which: "welcome" | "plugins" | "key" | null): Promise<void> {
  page = which;
  if (which === null || info.context.surface !== undefined) {
    pageHost.hidden = true;
    pageHost.replaceChildren();
    syncDrag();
    return;
  }
  const close = () => void showPage(null);
  if (which === "welcome") await showWelcome(pageHost, t, root.call, close);
  else if (which === "key") await showKey(pageHost, t, root.call, close);
  else await showPlugins(pageHost, t, root.call, close);
  syncDrag();
}

async function start(): Promise<void> {
  info = await bridge.describe();
  strings = info.strings ?? EMPTY_STRINGS;
  document.documentElement.lang = strings.lang;
  applyTokens(info.tokens);
  document.documentElement.dataset.material = info.context.material;
  drawBanner();
  bridge.onMessage(onMessage);
  // A page the main process wants shown before this document was ready (the welcome guide on a first start).
  if (info.context.surface === undefined) void root.call("page.current").then((r) => {
    const current = (r as { page?: unknown } | undefined)?.page;
    if ((current === "welcome" || current === "plugins" || current === "key") && page === null) void showPage(current);
  }, () => undefined);
  reportTitlebar();
  navigator.windowControlsOverlay?.addEventListener("geometrychange", reportTitlebar);
  await render();
}

void start();
