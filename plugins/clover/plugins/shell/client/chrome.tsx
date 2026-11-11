// The window's chrome as parts a bot's tab layout places. A tab layout (data: `layout.json`) may place these spots anywhere in
// its page: `chrome.title`, `chrome.action` (keyed `edit`, `session`, `browser`), `chrome.actions` (every button not placed
// one by one), `chrome.sidebar` (the sidebar's button), `chrome.drag` (a region that drags the window) and `chrome.panels`
// (where the panels show). The shell draws each one, in the shape the bot's theme `shell` tokens say, and a press on one is the
// app's own press: no plugin script runs for any of it. A part the layout places leaves the standard bar; with `bar.mode: "none"`
// a part it does not place is not shown, except the sidebar's button and a place to drag the window, which the shell then adds
// in a small fallback (`Window`).
//
// The parts reach the shell's state through one context, which only the shell's own `Window` and `Shell` provide; a tab drawn
// outside the shell (a gallery) has none and these parts draw nothing.
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import type { BotRef } from "../runtime/types";
import { IconChevronDown, IconEdit, IconSidebar } from "./icons";
import { PanelToggleButton } from "./PanelToggles";
import type { PanelViewId, SessionKind } from "./panel-types";
import { Spot } from "./sdk";
import { S } from "./strings";

/** The names a layout's placement is tracked by. */
export type ChromePartId = "title" | "action:edit" | "action:session" | "action:browser" | "actions" | "sidebar" | "drag" | "panels";

export interface ChromeApi {
  bot: BotRef | undefined;
  kind: SessionKind | undefined;
  title: string;
  onTitleMenu?: () => void;
  open: readonly string[];
  toggleView(id: PanelViewId): void;
  editBot(): void;
  sidebarCollapsed: boolean;
  toggleSidebar(): void;
  /** The panels, drawn once: here when a layout places `chrome.panels`, else in the window's own column. */
  panels: ReactNode;
  /** A placed part says so while it is mounted; the standard bar leaves it out. */
  place(id: ChromePartId): () => void;
}

export const ChromeContext = createContext<ChromeApi | null>(null);
export const useChrome = (): ChromeApi | null => useContext(ChromeContext);

/** A placed part: registered while mounted, so the bar and the fallback know the layout has it. */
function usePlaced(chrome: ChromeApi | null, id: ChromePartId): void {
  const place = chrome?.place;
  useLayoutEffect(() => (place === undefined ? undefined : place(id)), [place, id]);
}

/** The title: the bot's name, opening the tab's menu where the host has one. */
export function ChromeTitle(): ReactNode {
  const c = useChrome();
  usePlaced(c, "title");
  if (c === null) return null;
  return c.onTitleMenu ? (
    <button type="button" className="cl-window__title cl-chrome" aria-haspopup="menu" aria-label={S.sessionMenu(c.title)} onClick={c.onTitleMenu}>
      <span className="cl-window__title-text">{c.title}</span>
      <IconChevronDown />
    </button>
  ) : (
    <h1 className="cl-window__title cl-chrome">
      <span className="cl-window__title-text">{c.title}</span>
    </h1>
  );
}

export function ChromeEdit(): ReactNode {
  const c = useChrome();
  usePlaced(c, "action:edit");
  if (c === null || c.bot === undefined) return null;
  const label = S.editBot(c.bot.name);
  return (
    <button type="button" className="cl-panel-toggle cl-chrome" aria-label={label} title={label} onClick={c.editBot}>
      <IconEdit />
    </button>
  );
}

function ChromeToggle({ id }: { id: "session" | "browser" }): ReactNode {
  const c = useChrome();
  usePlaced(c, id === "session" ? "action:session" : "action:browser");
  if (c === null || c.kind === undefined) return null;
  return <PanelToggleButton id={id} kind={c.kind} open={c.open} onToggle={c.toggleView} />;
}
export const ChromeSession = (): ReactNode => <ChromeToggle id="session" />;
export const ChromeBrowser = (): ReactNode => <ChromeToggle id="browser" />;

/** The buttons the layout does not place one by one, in the order the bar has them. */
export function ChromeActions(): ReactNode {
  const c = useChrome();
  usePlaced(c, "actions");
  if (c === null || c.bot === undefined) return null;
  return <ChromeActionRow />;
}

/** Plugins' bar buttons, then the editor and the toggles that nothing placed (`Window` hands the same row to the standard bar). */
export function ChromeActionRow({ skip = [] }: { skip?: readonly ChromePartId[] }): ReactNode {
  const c = useChrome();
  if (c === null || c.bot === undefined || c.kind === undefined) return null;
  const not = new Set<string>(skip);
  return (
    <div className="cl-window__toggles cl-chrome" role="toolbar" aria-label={S.panelToggles}>
      <Spot name="bot.header.action" props={{ bot: c.bot }} />
      {!not.has("action:edit") && <ChromeEditButton />}
      <div className="cl-panel-toggles" data-kind={c.kind}>
        {(["session", "browser"] as const).filter((id) => !not.has(`action:${id}`)).map((id) => <PanelToggleButton key={id} id={id} kind={c.kind!} open={c.open} onToggle={c.toggleView} />)}
      </div>
    </div>
  );
}

function ChromeEditButton(): ReactNode {
  const c = useChrome();
  if (c === null || c.bot === undefined) return null;
  const label = S.editBot(c.bot.name);
  return (
    <button type="button" className="cl-panel-toggle" aria-label={label} title={label} onClick={c.editBot}>
      <IconEdit />
    </button>
  );
}

/** The sidebar's show/hide button. */
export function ChromeSidebar(): ReactNode {
  const c = useChrome();
  usePlaced(c, "sidebar");
  if (c === null) return null;
  return <SidebarButton />;
}

export function SidebarButton({ className = "cl-panel-toggle cl-chrome" }: { className?: string }): ReactNode {
  const c = useChrome();
  if (c === null) return null;
  const label = c.sidebarCollapsed ? S.showSidebar : S.hideSidebar;
  return (
    <button type="button" className={className} aria-label={label} aria-expanded={!c.sidebarCollapsed} title={label} onClick={c.toggleSidebar}>
      <IconSidebar />
    </button>
  );
}

/** A region the window drags by. */
export function ChromeDrag(): ReactNode {
  const c = useChrome();
  usePlaced(c, "drag");
  if (c === null) return null;
  return <div className="cl-chrome-drag" aria-hidden="true" />;
}

/** Where the panels show: the layout's container gives them their shape. */
export function ChromePanels(): ReactNode {
  const c = useChrome();
  usePlaced(c, "panels");
  if (c === null) return null;
  return <div className="cl-chrome-panels">{c.panels}</div>;
}
