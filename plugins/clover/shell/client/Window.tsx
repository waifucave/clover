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
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconChevronDown } from "./icons";
import { S } from "./strings";

export interface WindowProps {
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
  /** A dialog over the window: settings, the language chooser. */
  dialog?: ReactNode;
  /** Any card (an approval or a question) this window will draw is waiting: the shown session's, an agent's
   *  in the panel, or one raised from a dialog (Settings asking for a level change or to remove a device).
   *  No dialog opens while one does, and an open one closes through `onCloseDialog`. */
  cardPending?: boolean;
  /** Closes the dialog: on Escape, and when a card arrives or is already waiting. */
  onCloseDialog?: () => void;
  /** The `status` bar at the bottom of the main column, when anything fills it (Winter's tiles, §12). */
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

export function Window({ sidebar, title, onTitleMenu, toggles, children, side, panel, dialog, cardPending = false, onCloseDialog, translucent = false, status }: WindowProps) {
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

  return (
    <div className="cl-window" data-panel={panel ? "open" : undefined} data-side={side ? "open" : undefined} data-translucent={translucent || undefined}>
      <div className="cl-window__sidebar">{sidebar}</div>
      <section className="cl-window__main" aria-label={title}>
        <header className="cl-window__bar">
          {onTitleMenu ? (
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
          {toggles && (
            <div className="cl-window__toggles" role="toolbar" aria-label={S.panelToggles}>
              {toggles}
            </div>
          )}
        </header>
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
      {panel && <aside className="cl-window__panel">{panel}</aside>}
      {showDialog && <DialogLayer onClose={onCloseDialog}>{dialog}</DialogLayer>}
    </div>
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
