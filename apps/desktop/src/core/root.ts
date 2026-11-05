// The window's core root (`clover-core://app/`, spec §5.5): core code, no plugin's. It mounts the entry that fills
// `app.root` (a surface window: its one `app.surface` entry) as a frame from that plugin's own layer, and owns what
// the core draws around it: the safe-mode banner (§5.8), the note when nothing fills the window, and the placeholder
// with a reload when the shell's layer stops (S9: detected by the main process's census).
import type { LayerBridge, LayerMessage, MountInfo, SpotView } from "@waifucave/clover-plugin-sdk/ui/bridge";

interface RootBridge {
  frameMetrics(m: { top: number; start: number; end: number }): void;
  command(name: string): void;
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
    note([`The window could not be drawn: ${err instanceof Error ? err.message : String(err)}`]);
    return;
  }
  const item = view.items.find((i) => i.kind === "frame");
  if (item === undefined || item.kind !== "frame") {
    shown = undefined;
    note(info.context.safeMode
      ? ["Nothing fills this window, even in safe mode."]
      : ["Nothing fills this window. A shell plugin may have been turned off or removed."], info.context.safeMode ? undefined : { label: "Restart in safe mode", run: () => root.command("restart-safe-mode") });
    return;
  }
  mount(item);
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
  if (m.type === "child-reload" && m.child === shown?.mount) {
    const frame = stage.querySelector("iframe");
    mount({ mount: m.child, url: m.url, ref: frame?.dataset.cloverEntry ?? "", layer: frame?.dataset.cloverLayer ?? "" });
  }
  if (m.type === "child-gone" && m.child === shown?.mount) {
    const child = m.child;
    note(["Clover's window stopped drawing. Its layer will start again when you reload."], {
      label: "Reload",
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

async function start(): Promise<void> {
  info = await bridge.describe();
  applyTokens(info.tokens);
  document.documentElement.dataset.material = info.context.material;
  if (info.context.safeMode && info.context.surface === undefined) {
    banner.hidden = false;
    banner.textContent = "Safe mode: only Clover's own plugins run.";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Restart normally";
    b.addEventListener("click", () => root.command("restart-normally"));
    banner.append(b);
  }
  bridge.onMessage(onMessage);
  reportTitlebar();
  navigator.windowControlsOverlay?.addEventListener("geometrychange", reportTitlebar);
  await render();
}

void start();
