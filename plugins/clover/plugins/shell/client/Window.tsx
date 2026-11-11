// The window frame (it fills `app.root` and holds the shell's spots `sidebar`, `main` and `panel`, spec
// §5.5): the sidebar on the window's material, the main column (a translucent title bar with the open tab's
// name and the panel toggles, over the bot's or session's view, with the session column beside it), the
// right-hand panel when one is open, and a layer for dialogs. What fills the spots comes in as nodes.
//
// Sealed cards (§5.5) count a click only while nothing covers them:
// - **Dialogs.** While any card this window will draw is waiting, no dialog opens, and one already open
//   closes (the same rule as the composer's menus). That includes a card raised from the dialog itself:
//   asking Settings for a level change or to remove a device closes Settings, and the card shows where
//   the window draws it. The bar says why.
// - **The title bar.** It is translucent, and the conversation scrolls under it. The bot tab tells the
//   conversation how tall the bar is (`--cl-inset-top`), so its content starts below the bar and a card it
//   brings into view stops below it.
//
// While the session column shows, the frame also tells the bot tab how far right to move its reading
// column and composer (`--cl-axis-shift`): toward the main column's middle, as far as the column leaves
// room.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChromeActionRow, ChromeContext, SidebarButton, type ChromeApi, type ChromePartId } from "./chrome";
import { IconChevronDown } from "./icons";
import { S } from "./strings";

/** The shell tokens of one bot, from the tokens the main process hands the shell (`shell.<bot>.<name>`): the groups it
 *  sets, whole, as a plain map (`bar`, `bar.text`, `sidebar`…); `undefined` when it sets none. */
export function skinOf(tokens: Readonly<Record<string, string | number>>, bot: string): Record<string, string> | undefined {
  const prefix = `shell.${bot.replace(/\//g, "--")}.`;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) if (name.startsWith(prefix) && typeof value === "string") out[name.slice(prefix.length)] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

const SKIN_VARS: Record<string, string> = {
  "bar.text": "--cl-skin-bar-text",
  "bar.rule": "--cl-skin-bar-rule",
  "sidebar.text": "--cl-skin-sidebar-text",
  "sidebar.muted": "--cl-skin-sidebar-muted",
  "sidebar.selected": "--cl-skin-sidebar-selected",
  "sidebar.hover": "--cl-skin-sidebar-hover",
  accent: "--cl-skin-accent",
};

/** The groups a skin holds, as the attribute the stylesheet keys on (`bar sidebar accent`). */
const groupsOf = (skin: Record<string, string> | undefined): string | undefined => {
  if (!skin) return undefined;
  const g = ["bar", "sidebar", "accent"].filter((n) => skin[n] !== undefined);
  return g.length > 0 ? g.join(" ") : undefined;
};

/** The shape the bot's theme `shell` tokens give the chrome (`SHELL_SHAPE`), as the window draws it: data attributes the stylesheet
 *  keys on and the lengths it uses. Every value was checked by the main process; one that is missing is the standard. */
export interface ChromeShape {
  bar: "standard" | "none" | "float";
  sidebar: "edge" | "float" | "rail";
  start: "expanded" | "collapsed";
  density: "compact" | "regular" | "roomy";
  material: "glass" | "solid" | "none";
  panel: "column" | "drawer" | "float" | "sheet";
  vars: Record<string, string>;
}

const pick = <T extends string>(v: string | undefined, choices: readonly T[], fallback: T): T => (choices as readonly string[]).includes(v ?? "") ? (v as T) : fallback;

/** The shape in a skin (`skinOf`): `standard` everywhere when the bot says nothing, so a tab with no `shell` shape looks as it always did. */
export function shapeOf(skin: Record<string, string> | undefined): ChromeShape {
  const vars: Record<string, string> = {};
  const len = (name: string, prop: string) => { const v = skin?.[name]; if (v !== undefined && /^\d{1,3}$/.test(v)) vars[prop] = `${v}px`; };
  len("bar.height", "--cl-shape-bar-height");
  len("bar.inset", "--cl-shape-bar-inset");
  len("bar.radius", "--cl-shape-bar-radius");
  len("sidebar.width", "--cl-shape-sidebar-width");
  len("sidebar.inset", "--cl-shape-sidebar-inset");
  len("sidebar.radius", "--cl-shape-sidebar-radius");
  len("panel.width", "--cl-shape-panel-width");
  len("panel.radius", "--cl-shape-panel-radius");
  const sidebar = pick(skin?.["sidebar.mode"], ["edge", "float", "rail"] as const, "edge");
  return {
    bar: pick(skin?.["bar.mode"], ["standard", "none", "float"] as const, "standard"),
    sidebar,
    start: pick(skin?.["sidebar.start"], ["expanded", "collapsed"] as const, sidebar === "rail" ? "collapsed" : "expanded"),
    density: pick(skin?.["sidebar.density"], ["compact", "regular", "roomy"] as const, "regular"),
    material: pick(skin?.["sidebar.material"], ["glass", "solid", "none"] as const, "glass"),
    panel: pick(skin?.["panel.mode"], ["column", "drawer", "float", "sheet"] as const, "column"),
    vars,
  };
}

/** A paint layer under a chrome surface. A new skin fades in over the one leaving (which fades out), so a switch is a
 *  cross-fade and the stock colours never show between two skins; with reduced motion the swap is instant (the CSS). */
function SkinPaint({ id, paint }: { id: string; paint: string | undefined }) {
  const [layers, setLayers] = useState<{ key: number; paint: string; out: boolean }[]>(() => (paint ? [{ key: 0, paint, out: false }] : []));
  const last = useRef<string | undefined>(paint);
  const next = useRef(1);
  useEffect(() => {
    if (last.current === paint) return;
    last.current = paint;
    setLayers((prev) => [...prev.map((l) => ({ ...l, out: true })), ...(paint ? [{ key: next.current++, paint, out: false }] : [])]);
    const t = setTimeout(() => setLayers((prev) => prev.filter((l) => !l.out)), 320);
    return () => clearTimeout(t);
  }, [paint]);
  return (
    <div className="cl-skin-paint" data-for={id} aria-hidden="true">
      {layers.map((l) => (
        <div key={l.key} className="cl-skin-paint__layer" data-out={l.out || undefined} style={{ background: l.paint }} />
      ))}
    </div>
  );
}

export interface WindowProps {
  /** The active bot's shell skin (`skinOf`): the title bar, the sidebar and the accent in the bot's palette. */
  skin?: Record<string, string>;
  /** The `sidebar` spot. */
  sidebar: ReactNode;
  /** The open tab's name: a bot's, an agent's or a session's. */
  title: string;
  /** Opens the tab's menu (rename, fork, archive…) when the host has one. */
  onTitleMenu?: () => void;
  /** The panel toggles, at the title bar's end. */
  toggles?: ReactNode;
  /** The `main` spot: the bot tab (conversation and composer), a settings page, or an app. */
  children: ReactNode;
  /** The column beside the conversation: a code session's (where it runs, context, outputs, changes) or a
   *  bot's slim one (agents and tasks, context, outputs). */
  side?: ReactNode;
  /** The `panel` spot, when a panel is open. */
  panel?: ReactNode;
  /** The shape the bot's theme gives the chrome (`shapeOf`); the standard when absent. */
  shape?: ChromeShape;
  /** What the chrome's parts need (`chrome.tsx`): the window adds where the panels show and which parts a layout placed. */
  chrome?: Omit<ChromeApi, "place" | "panels">;
  /** The bar's content, given the standard one as `stock` (the shell passes a bot-scoped `bar` spot whose fallback it is): a bot's own plugin may fill it. */
  barFill?: (stock: ReactNode) => ReactNode;
  /** The handles the bot's own plugin says its controls offer (`shell.provide`): with no bar, the window adds a minimal one for each nothing offers. */
  provides?: { sidebar: boolean; drag: boolean };
  /** A dialog over the window: settings, the language chooser. */
  dialog?: ReactNode;
  /** Any card (an approval or a question) this window will draw is waiting: the shown session's, an agent's
   *  in the panel, or one raised from a dialog (Settings asking for a level change or to remove a device).
   *  No dialog opens while one does, and an open one closes through `onCloseDialog`. */
  cardPending?: boolean;
  /** Closes the dialog: on Escape, and when a card arrives or is already waiting. */
  onCloseDialog?: () => void;
  /** The `status` bar at the bottom of the main column, when anything fills it (the inherited tiles, §12). */
  status?: ReactNode;
  /** The window has a system material behind it (sidebar vibrancy on macOS, acrylic on Windows 11; lane E):
   *  the sidebar lets it through. Without one (Linux), the sidebar is a solid colour. */
  translucent?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The dialog layer: it takes the focus in, keeps Tab inside, closes on Escape, and gives the focus back
 *  to whatever had it when the dialog opened. */
function DialogLayer({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = layer.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      first.focus();
    }
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The dialog handled it itself (an inner menu closing, say).
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && onClose) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...(layer.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="cl-window__dialog" ref={layer} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

const STANDARD_SHAPE: ChromeShape = { bar: "standard", sidebar: "edge", start: "expanded", density: "regular", material: "glass", panel: "column", vars: {} };

export function Window({ sidebar, title, onTitleMenu, toggles, children, side, panel, dialog, cardPending = false, onCloseDialog, translucent = false, status, skin, shape = STANDARD_SHAPE, chrome, barFill, provides }: WindowProps) {
  // The colours stay as the last skin left them while the paint fades out, so text never jumps ahead of its ground.
  const [shown, setShown] = useState(skin);
  useEffect(() => { if (skin) setShown(skin); }, [skin]);
  const vars: Record<string, string> = {};
  for (const [name, prop] of Object.entries(SKIN_VARS)) { const v = (skin ?? shown)?.[name]; if (v) vars[prop] = v; }
  // A dialog asked for while a card waits stays shut, and one open when a card arrives closes; either way
  // the bar says so until the card is answered.
  const [held, setHeld] = useState(false);
  const wantsDialog = dialog !== undefined && dialog !== null && dialog !== false;
  useEffect(() => {
    if (cardPending && wantsDialog) {
      setHeld(true);
      onCloseDialog?.();
    }
  }, [cardPending, wantsDialog, onCloseDialog]);
  useEffect(() => {
    if (!cardPending) setHeld(false);
  }, [cardPending]);
  const showDialog = wantsDialog && !cardPending;

  // The parts a bot's layout placed (`chrome.*`): counted while mounted. They leave the standard bar; with no bar, a part nothing
  // placed is not shown, but the sidebar's button and a place to drag the window always are (a small fallback).
  const counts = useRef(new Map<ChromePartId, number>());
  const [placed, setPlaced] = useState<ReadonlySet<ChromePartId>>(new Set());
  const place = useCallback((id: ChromePartId) => {
    counts.current.set(id, (counts.current.get(id) ?? 0) + 1);
    setPlaced(new Set(counts.current.keys()));
    return () => {
      const n = (counts.current.get(id) ?? 1) - 1;
      if (n <= 0) counts.current.delete(id);
      else counts.current.set(id, n);
      setPlaced(new Set(counts.current.keys()));
    };
  }, []);
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  const panelsPlaced = placed.has("panels");
  const api = useMemo<ChromeApi | null>(() => (chrome ? { ...chrome, panels: panel, place } : null), [chrome, panel, place]);
  const noBar = shape.bar === "none";
  const needSidebarButton = noBar && settled && !placed.has("sidebar") && provides?.sidebar !== true;
  const needDrag = noBar && settled && !placed.has("drag") && provides?.drag !== true;

  // A floating sidebar lets the page run under it: the page's CSS reads how far in from the left the sidebar reaches
  // (`--cl-sidebar-reserve`), measured, so a layout can keep its cards clear of it whatever its width.
  const sideRef = useRef<HTMLDivElement>(null);
  const [reserve, setReserve] = useState(0);
  const floating = shape.sidebar !== "edge";
  useEffect(() => {
    const el = sideRef.current;
    if (!floating || !el || typeof ResizeObserver === "undefined") { setReserve(0); return; }
    const inset = Number.parseInt(shape.vars["--cl-shape-sidebar-inset"] ?? "12", 10) || 12;
    const measure = () => setReserve(Math.round(el.getBoundingClientRect().width) + inset * 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [floating, shape.vars, chrome?.sidebarCollapsed]);
  // The window controls' reach (the macOS buttons the sidebar already leaves 80 px for): nothing of a layout's may sit under them.
  const chromeVars: Record<string, string> = { ...shape.vars, "--cl-sidebar-reserve": `${floating ? reserve : 0}px`, "--cl-safe-left": "var(--cl-window-controls, 80px)", "--cl-safe-top": "44px" };
  if (shape.bar === "standard" && shape.vars["--cl-shape-bar-height"] !== undefined) chromeVars["--clover-plugin-clover-bar-height"] = shape.vars["--cl-shape-bar-height"];

  const stockBar = (
    <>
          {placed.has("title") ? null : onTitleMenu ? (
            <button type="button" className="cl-window__title" aria-haspopup="menu" aria-label={S.sessionMenu(title)} onClick={onTitleMenu}>
              <span className="cl-window__title-text">{title}</span>
              <IconChevronDown />
            </button>
          ) : (
            <h1 className="cl-window__title">
              <span className="cl-window__title-text">{title}</span>
            </h1>
          )}
          <span className="cl-window__note" role="status">
            {cardPending && held ? S.dialogHeld : ""}
          </span>
          {toggles ? (
            <div className="cl-window__toggles" role="toolbar" aria-label={S.panelToggles}>
              {toggles}
            </div>
          ) : chrome?.bot && !placed.has("actions") ? (
            <ChromeActionRow skip={[...placed]} />
          ) : null}
    </>
  );

  return (
    <ChromeContext.Provider value={api}>
    <div className="cl-window" data-panel={panel ? "open" : undefined} data-side={side ? "open" : undefined} data-translucent={translucent || undefined} data-skin={groupsOf(skin)}
      data-bar-mode={shape.bar} data-sidebar-mode={shape.sidebar} data-collapsed={chrome?.sidebarCollapsed || undefined} data-density={shape.density} data-material={shape.material} data-panel-mode={shape.panel} data-sidebar-over={shape.sidebar !== "edge" || undefined} data-panel-over={shape.panel !== "column" || undefined}
      style={{ ...vars, ...chromeVars } as CSSProperties}>
      <div className="cl-window__sidebar" ref={sideRef}>
        <SkinPaint id="sidebar" paint={skin?.["sidebar"]} />
        <div className="cl-window__sidebar-content">{sidebar}</div>
      </div>
      <section className="cl-window__main" aria-label={title}>
        {!noBar && (
        <header className="cl-window__bar">
          <SkinPaint id="bar" paint={skin?.["bar"]} />
          {barFill ? barFill(stockBar) : stockBar}
        </header>
        )}
        {needDrag && <div className="cl-chrome-drag cl-chrome-drag--fallback" aria-hidden="true" />}
        {needSidebarButton && <SidebarButton className="cl-chrome-fallback" />}
        <div className="cl-window__body">
          <div className="cl-window__content">{children}</div>
          {side && <aside className="cl-window__side">{side}</aside>}
        </div>
        {status && (
          <footer className="cl-window__status" role="status" aria-label={S.statusBar}>
            {status}
          </footer>
        )}
      </section>
      {panel && !panelsPlaced && <aside className="cl-window__panel">{panel}</aside>}
      {showDialog && <DialogLayer onClose={onCloseDialog}>{dialog}</DialogLayer>}
    </div>
    </ChromeContext.Provider>
  );
}

/** A bot tab's or a session's own layout: the stage when something stands on it, then the conversation over the
 *  composer. In `main`, the conversation runs up under the title bar (`--cl-inset-top` tells it how far down its content
 *  starts) and both follow the axis shift; with a stage, the stage takes the top instead. In the panel (an agent opened
 *  from a bot's slim column), neither applies. */
export function BotTab({ stage, conversation, composer }: { stage?: ReactNode; conversation: ReactNode; composer: ReactNode }) {
  return (
    <div className="cl-bot-tab">
      {stage && <div className="cl-bot-tab__stage">{stage}</div>}
      <div className="cl-bot-tab__conversation">{conversation}</div>
      <div className="cl-bot-tab__composer">{composer}</div>
    </div>
  );
}
