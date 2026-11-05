// The terminal panel: tabs across the top (one per terminal, and + for a new one), then the active
// terminal's output, which takes the keyboard while it has focus and sends what is typed to the PTY.
// It fills the `panel.view` spot keyed `terminal`.
import { useLayoutEffect, useRef } from "react";
import { keyToData } from "./keys";
import { S } from "./strings";
import type { TerminalPanelProps } from "./types";

export function TerminalPanel({ tabs, active, chunks, onInput, onSelect, onNew, onClose }: TerminalPanelProps) {
  const screen = useRef<HTMLPreElement>(null);
  const tab = tabs.find((t) => t.id === active);
  // New output keeps the last line in view.
  useLayoutEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks]);
  return (
    <div className="cl-term">
      <div className="cl-term__tabs" role="tablist" aria-label={S.terminals}>
        {tabs.map((t) => (
          <div key={t.id} className="cl-term__tab" data-active={t.id === active || undefined}>
            <button type="button" role="tab" aria-selected={t.id === active} className="cl-term__tab-button" onClick={() => onSelect?.(t.id)}>
              {t.title}
            </button>
            {onClose && tabs.length > 1 && (
              <button type="button" className="cl-term__tab-close" aria-label={S.close(t.title)} onClick={() => onClose(t.id)}>
                ×
              </button>
            )}
          </div>
        ))}
        {onNew && (
          <button type="button" className="cl-term__new" aria-label={S.newTerminal} title={S.newTerminal} onClick={onNew}>
            +
          </button>
        )}
      </div>
      <pre
        ref={screen}
        className="cl-term__screen"
        role="log"
        aria-label={S.output(tab?.title ?? "")}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!onInput) return;
          const data = keyToData(e);
          if (data === undefined) return;
          e.preventDefault();
          onInput(data);
        }}
        onPaste={(e) => {
          const text = e.clipboardData?.getData?.("text/plain") ?? "";
          if (!onInput || text.length === 0) return;
          e.preventDefault();
          onInput(text);
        }}
      >
        {chunks.map((c, i) => (
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
    </div>
  );
}
