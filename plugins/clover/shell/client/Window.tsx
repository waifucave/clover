// The window: the sidebar, the main column (a title bar with the open tab's name and the panel
// toggles, then the bot's or session's view, with the session column beside it when it's open), the
// right-hand panel when one is open, and a layer for dialogs over all of it. It holds the shell's
// spots: `sidebar`, `main`, `panel` (spec §5.5); what fills them comes in as nodes.
import type { ReactNode } from "react";
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
  /** The `main` spot: the conversation and the composer, or a settings page, or an app. */
  children: ReactNode;
  /** The session column beside the conversation (environment, context, outputs, changes). */
  side?: ReactNode;
  /** The `panel` spot, when a panel is open. */
  panel?: ReactNode;
  /** A dialog over the window: settings, the language chooser. */
  dialog?: ReactNode;
}

export function Window({ sidebar, title, onTitleMenu, toggles, children, side, panel, dialog }: WindowProps) {
  return (
    <div className="cl-window" data-panel={panel ? "open" : undefined} data-side={side ? "open" : undefined}>
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
          <span className="cl-window__spacer" />
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
      </section>
      {panel && <aside className="cl-window__panel">{panel}</aside>}
      {dialog && <div className="cl-window__dialog">{dialog}</div>}
    </div>
  );
}

/** The bot tab's own layout inside `main`: the conversation over the composer. */
export function BotTab({ conversation, composer }: { conversation: ReactNode; composer: ReactNode }) {
  return (
    <div className="cl-bot-tab">
      <div className="cl-bot-tab__conversation">{conversation}</div>
      <div className="cl-bot-tab__composer">{composer}</div>
    </div>
  );
}
