// The chrome around the live page: back, forward, reload and the address bar on top, the frame the browser's live
// view fills, and the annotate tools in a strip of their own below the frame.
//
// The live view is a native view the browser draws above all of the page's DOM, at the frame's place on screen, so
// nothing of this panel ever sits over the frame: the failure notice is a line above it, the annotate tools a strip
// below it, and nothing here is positioned out of the flow. Inside the frame there is only the placeholder, or the
// paused tab's last picture, and only while the browser's view is not on screen (no tab, the tab not shown yet, or
// the live view in another panel; the paused mark is a line above the frame).
import { useEffect, useId, useState, type ReactNode } from "react";
import { IconAlert, IconBack, IconBox, IconForward, IconGlobe, IconPause, IconPen, IconPointer, IconReload, IconStop, IconText } from "./icons";
import { S } from "./strings";
import type { AnnotateTool, BrowserChromeProps } from "./types";

const TOOL_ICONS: Record<AnnotateTool, () => ReactNode> = { pointer: IconPointer, pen: IconPen, box: IconBox, text: IconText };

export function BrowserChrome({ tab, live, onBack, onForward, onReload, onNavigate, error, paused, frameRef, annotate }: BrowserChromeProps) {
  const errorId = useId();
  // What the user is typing, while they are: it belongs to one tab, and the bar follows the page whenever there is
  // none. A page that loads or redirects under the user's typing does not take it away.
  const [draft, setDraft] = useState<{ tab: string; text: string } | null>(null);
  const typed = draft !== null && draft.tab === tab?.id ? draft.text : undefined;
  const address = typed ?? tab?.url ?? "";
  useEffect(() => setDraft(null), [tab?.id]);

  const submit = async (text: string) => {
    if (!tab || !onNavigate || text.trim().length === 0) return;
    // A failed address stays in the bar so a typo can be fixed; an opened one hands the bar back to the page.
    const result = await onNavigate(text.trim());
    if (result !== false) setDraft(null);
  };

  return (
    <div className="cl-browser">
      <div className="cl-browser__top">
        <div className="cl-browser__bar">
          <button type="button" className="cl-browser__button" aria-label={S.back} title={S.back} disabled={!onBack} onClick={onBack}>
            <IconBack />
          </button>
          <button type="button" className="cl-browser__button" aria-label={S.forward} title={S.forward} disabled={!onForward} onClick={onForward}>
            <IconForward />
          </button>
          <button type="button" className="cl-browser__button" aria-label={S.reload} title={S.reload} disabled={!onReload} onClick={onReload}>
            <IconReload />
          </button>
          <input
            className="cl-browser__address"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={S.address}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={address}
            disabled={!tab}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => tab && setDraft({ tab: tab.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit(address);
              } else if (e.key === "Escape") {
                setDraft(null);
              }
            }}
          />
        </div>
        {error && (
          <p className="cl-browser__error" id={errorId} role="alert">
            <IconAlert />
            <span className="cl-browser__error-text">{error}</span>
          </p>
        )}
        {paused && !live && (
          <p className="cl-browser__paused" role="status">
            <IconPause />
            <span className="cl-browser__paused-text">{S.paused}</span>
          </p>
        )}
      </div>
      <div ref={frameRef} className="cl-browser__frame" aria-label={tab ? S.view(tab.title) : S.noTab} aria-busy={tab?.loading || undefined} role="region">
        {paused && !live && (
          <button type="button" className="cl-browser__still" aria-label={S.resume} title={S.resume} onClick={paused.onResume}>
            {paused.picture !== undefined && <img className="cl-browser__still-picture" src={paused.picture} alt="" />}
          </button>
        )}
        {!paused && !live && (
          <div className="cl-browser__placeholder">
            <IconGlobe />
            <p className="cl-browser__placeholder-title">{tab ? S.placeholderTitle : S.noTab}</p>
            {tab && <p className="cl-browser__placeholder-text">{S.placeholderText}</p>}
          </div>
        )}
      </div>
      {annotate && tab && (
        <div className="cl-browser__annotate" role="toolbar" aria-label={S.annotate}>
          {(["pointer", "pen", "box", "text"] as const).map((tool) => {
            const Icon = TOOL_ICONS[tool];
            return (
              <button
                key={tool}
                type="button"
                className="cl-browser__tool"
                aria-pressed={annotate.tool === tool}
                aria-label={S.tools[tool]}
                title={S.tools[tool]}
                onClick={() => annotate.onTool(annotate.tool === tool ? null : tool)}
              >
                <Icon />
              </button>
            );
          })}
          <span className="cl-browser__tool-gap" />
          <button type="button" className="cl-browser__tool" aria-label={S.stopAnnotating} title={S.stopAnnotating} onClick={() => annotate.onTool(null)}>
            <IconStop />
          </button>
        </div>
      )}
    </div>
  );
}
