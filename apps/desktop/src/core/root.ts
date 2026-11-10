// The window's core root (`clover-core://app/`, spec §5.5): core code, no plugin's. It mounts the entry that fills
// `app.root` (a surface window: its one `app.surface` entry) as a frame from that plugin's own layer, and owns what
// the core draws around it: the safe-mode banner (§5.8), the note when nothing fills the window, and the placeholder
// with a reload when the shell's layer stops (S9: detected by the main process's census).
import { showPlugins, showWelcome } from "./pages";
import { EMPTY_STRINGS, translate, type LayerBridge, type LayerMessage, type MountInfo, type SpotView, type StringTable } from "@waifucave/clover-plugin-sdk/ui/bridge";

interface RootBridge {
  frameMetrics(m: { top: number; start: number; end: number }): void;
  command(name: string): void;
  call(name: string, params?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    cloverRoot?: RootBridge;
  }
  interface Navigator {
    windowControlsOverlay?: EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect };
  }
}

const bridge = window.cloverLayer as LayerBridge;
const root = window.cloverRoot as RootBridge;
const stage = document.getElementById("clover-stage")!;
const banner = document.getElementById("clover-banner")!;
const pageHost = document.getElementById("clover-page")!;

function cssName(token: string): string {
  return `--clover-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
}

function applyTokens(tokens: Readonly<Record<string, string | number>>): void {
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(cssName(name), String(value));
}

function note(lines: string[], action?: { label: string; run: () => void }): void {
  stage.replaceChildren();
  const box = document.createElement("div");
  box.className = "clover-core-note";
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

let info: MountInfo;
let shown: { mount: string; url: string } | undefined;
let strings: StringTable = EMPTY_STRINGS;
/** The core's own text, in the app's language (`clover.core.…`, core-strings.ts). */
const t = (key: string, params?: Record<string, string | number>) => translate(strings, `clover.core.${key}`, params);

function mount(item: { mount: string; url: string; ref: string; layer: string }): void {
  if (shown?.mount === item.mount && shown.url === item.url && stage.querySelector("iframe") !== null) return;
  const frame = document.createElement("iframe");
  frame.src = item.url;
  frame.title = item.ref;
  frame.dataset.cloverEntry = item.ref;
  frame.dataset.cloverLayer = item.layer;
  frame.dataset.cloverMount = item.mount;
  frame.setAttribute("allow", "");
  frame.referrerPolicy = "no-referrer";
  stage.replaceChildren(frame);
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
      if ((state as { ready?: unknown } | undefined)?.ready !== true) {
        note([t("root.starting")]);
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
  const drag = document.getElementById("clover-drag");
  if (drag === null) return;
  drag.hidden = info?.context.surface !== undefined || (stage.querySelector("iframe") !== null && page === null);
}

function onMessage(m: LayerMessage): void {
  if (m.type === "respot") void render();
  if (m.type === "rect-query") {
    // The menu broker asks where the frame is in the window.
    const el = Array.from(stage.querySelectorAll("iframe")).find((f) => f.dataset.cloverMount === m.child);
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
  if (m.type === "child-reload" && m.child === shown?.mount) {
    const frame = stage.querySelector("iframe");
    mount({ mount: m.child, url: m.url, ref: frame?.dataset.cloverEntry ?? "", layer: frame?.dataset.cloverLayer ?? "" });
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
let page: "welcome" | "plugins" | null = null;
async function showPage(which: "welcome" | "plugins" | null): Promise<void> {
  page = which;
  if (which === null || info.context.surface !== undefined) {
    pageHost.hidden = true;
    pageHost.replaceChildren();
    syncDrag();
    return;
  }
  const close = () => void showPage(null);
  if (which === "welcome") await showWelcome(pageHost, t, root.call, close);
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
    if ((current === "welcome" || current === "plugins") && page === null) void showPage(current);
  }, () => undefined);
  reportTitlebar();
  navigator.windowControlsOverlay?.addEventListener("geometrychange", reportTitlebar);
  await render();
}

void start();
