// The browser panel: the tabs (in the panel's header), then back, forward, reload and the address bar,
// then the live page with the annotate tools floating at its foot. It fills `panel.view` keyed
// `browser`; the page itself is the Clover Browser's view (lane L), placed where `renderView` says.
import { useEffect, useState, type ReactNode } from "react";
import { S } from "./strings";
import type { AnnotateTool, BrowserPanelProps, BrowserTabsProps } from "./types";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="cl-browser-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const IconGlobe = () => (<Svg size={14}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></Svg>);
const IconClose = () => (<Svg size={12}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>);
const IconPlus = () => (<Svg><path d="M8 3v10M3 8h10" /></Svg>);
const IconBack = () => (<Svg><path d="M9.5 3.5L5 8l4.5 4.5" /></Svg>);
const IconForward = () => (<Svg><path d="M6.5 3.5L11 8l-4.5 4.5" /></Svg>);
const IconReload = () => (<Svg><path d="M12.5 8A4.5 4.5 0 1 1 11 4.6M12.5 2.5v3h-3" /></Svg>);
const IconPointer = () => (<Svg><path d="M4 2.5l8 5.5-3.5.8L10.5 13l-1.6.7-2-4.2L4 12z" /></Svg>);
const IconPen = () => (<Svg><path d="M3 13l1-3.5L11 2.5 13.5 5l-7 7z" /></Svg>);
const IconBox = () => (<Svg><rect x="3" y="3.5" width="10" height="9" rx="1" /></Svg>);
const IconText = () => (<Svg><path d="M4 4h8M8 4v8.5" /></Svg>);

const TOOL_ICONS: Record<AnnotateTool, () => ReactNode> = { pointer: IconPointer, pen: IconPen, box: IconBox, text: IconText };

/** The tabs, for the panel's header. */
export function BrowserTabs({ tabs, active, onSelect, onClose, onNew }: BrowserTabsProps) {
  return (
    <div className="cl-browser-tabs" role="tablist" aria-label={S.tabs}>
      {tabs.map((tab) => (
        <div key={tab.id} className="cl-browser-tabs__tab" data-active={tab.id === active || undefined}>
          <button type="button" role="tab" aria-selected={tab.id === active} className="cl-browser-tabs__select" title={tab.url} onClick={() => onSelect(tab.id)}>
            <IconGlobe />
            <span className="cl-browser-tabs__title">{tab.title}</span>
          </button>
          <button type="button" className="cl-browser-tabs__close" aria-label={S.close(tab.title)} onClick={() => onClose(tab.id)}>
            <IconClose />
          </button>
        </div>
      ))}
      {onNew && (
        <button type="button" className="cl-browser-tabs__new" aria-label={S.newTab} title={S.newTab} onClick={onNew}>
          <IconPlus />
        </button>
      )}
    </div>
  );
}

export function BrowserPanel({ tab, onBack, onForward, onReload, onNavigate, annotate, renderView }: BrowserPanelProps) {
  const [address, setAddress] = useState(tab?.url ?? "");
  useEffect(() => setAddress(tab?.url ?? ""), [tab?.url]);
  return (
    <div className="cl-browser">
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
          aria-label={S.address}
          value={address}
          disabled={!tab}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onNavigate && address.trim().length > 0) {
              e.preventDefault();
              onNavigate(address.trim());
            }
          }}
        />
      </div>
      <div className="cl-browser__frame" aria-label={tab ? S.view(tab.title) : S.noTab} aria-busy={tab?.loading || undefined} role="region">
        {tab && renderView ? (
          renderView(tab)
        ) : (
          <div className="cl-browser__placeholder">
            <IconGlobe />
            <p className="cl-browser__placeholder-title">{tab ? S.placeholderTitle : S.noTab}</p>
            {tab && <p className="cl-browser__placeholder-text">{S.placeholderText}</p>}
          </div>
        )}
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
              <IconClose />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
