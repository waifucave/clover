// The terminal panel: the active terminal's output, which takes the keyboard while it has focus and sends
// what is typed to the PTY. Its tabs (one per terminal, and + for a new one) go in the panel's header
// (`TerminalTabs`). It fills the `panel` spot keyed `terminal`.
//
// Input has two doors. Key presses go through `onInput`, as the bytes a terminal sends. A paste goes
// through `onPaste`, never `onInput`, so the host can bracket it for the shell and ask before a paste
// of several lines runs: ⌘V on macOS, Ctrl+V or Ctrl+Shift+V on Windows and Linux. On the runtime both go
// as the events themselves (`onEvent`, lane B's `TerminalApi.input`): the app derives what reaches the shell
// from a trusted event, never from what the component says. The terminal keeps
// Tab for the shell, so F6 leaves it (Shift+F6 goes back the other way), and it says so (WCAG 2.1.2).
// It belongs to a code session: it runs in that session's folder, on the computer that holds it.
import { useId, useLayoutEffect, useRef } from "react";
import { IconClose, IconPlus } from "./icons";
import { currentPlatform, keyToData } from "./keys";
import { S } from "./strings";
import type { TerminalPanelProps, TerminalTabsProps } from "./types";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Moves the focus to the next (or previous) focusable thing in the document after `from`. */
export function focusPast(from: HTMLElement, back: boolean): void {
  const all = [...from.ownerDocument.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el === from || !from.contains(el));
  const at = all.indexOf(from);
  const next = back ? all[at - 1] : all[at + 1];
  (next ?? from).focus();
  if (!next) from.blur();
}

/** The tabs, for the panel's header: one per terminal, and + for a new one. */
export function TerminalTabs({ tabs, active, onSelect, onNew, onClose }: TerminalTabsProps) {
  return (
    <div className="cl-term-tabs" role="tablist" aria-label={S.terminals}>
      {tabs.map((t) => (
        <div key={t.id} className="cl-term-tabs__tab" data-active={t.id === active || undefined}>
          <button type="button" role="tab" aria-selected={t.id === active} className="cl-term-tabs__select" onClick={() => onSelect?.(t.id)}>
            {t.title}
          </button>
          {onClose && tabs.length > 1 && (
            <button type="button" className="cl-term-tabs__close" aria-label={S.close(t.title)} title={S.close(t.title)} onClick={() => onClose(t.id)}>
              <IconClose />
            </button>
          )}
        </div>
      ))}
      {onNew && (
        <button type="button" className="cl-term-tabs__new" aria-label={S.newTerminal} title={S.newTerminal} onClick={onNew}>
          <IconPlus />
        </button>
      )}
    </div>
  );
}

export function TerminalPanel({ tabs, active, chunks, lines, onInput, onPaste, onEvent, platform = currentPlatform() }: TerminalPanelProps) {
  const screen = useRef<HTMLPreElement>(null);
  const hintId = useId();
  const tab = tabs.find((t) => t.id === active);
  // New output keeps the last line in view.
  useLayoutEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks, lines]);
  return (
    <div className="cl-term">
      <pre
        ref={screen}
        className="cl-term__screen"
        role="log"
        aria-label={S.output(tab?.title ?? "")}
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={(e) => {
          // The way out: Tab belongs to the shell, F6 leaves.
          if (e.key === "F6") {
            e.preventDefault();
            focusPast(e.currentTarget, e.shiftKey);
            return;
          }
          if (!onInput && !onEvent) return;
          const data = keyToData(e, platform);
          if (data === undefined) return;
          e.preventDefault();
          if (onEvent) onEvent(e.nativeEvent);
          else onInput?.(data);
        }}
        onPaste={(e) => {
          // Never typed into the shell as keys: the host decides how a paste goes in.
          e.preventDefault();
          if (onEvent) {
            onEvent(e.nativeEvent);
            return;
          }
          const text = e.clipboardData?.getData?.("text/plain") ?? "";
          if (onPaste && text.length > 0) onPaste(text);
        }}
      >
        {lines
          ? lines.map((line, i) => (
              <span key={i} className="cl-term__line">
                {line.map((r, j) => (
                  <span
                    key={j}
                    className="cl-term__run"
                    data-fg={r.fg}
                    data-bold={r.bold}
                    data-dim={r.dim}
                    data-italic={r.italic}
                    data-underline={r.underline}
                    data-inverse={r.inverse}
                  >
                    {r.text}
                  </span>
                ))}
                {i < lines.length - 1 ? "\n" : ""}
              </span>
            ))
          : chunks.map((c, i) => (
              <span key={i} className="cl-term__chunk" data-style={c.style}>
                {c.text}
              </span>
            ))}
        {tab?.exited ? (
          <span className="cl-term__chunk" data-style="dim">
            {`\n${S.exited(tab.exited.code)}\n`}
          </span>
        ) : (
          <span className="cl-term__cursor" aria-hidden="true" />
        )}
      </pre>
      <p className="cl-term__hint" id={hintId}>
        {S.leaveHint}
      </p>
    </div>
  );
}
