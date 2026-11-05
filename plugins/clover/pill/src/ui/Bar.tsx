// The pill's bar (the Swift reference's `DispatchPillComposerBar` row): who the pill messages at the leading end (Clover:
// the target's portrait, `pill.target`), the text field, ↗ and ⋯ floating over the field's end while there
// is room, and the trailing circle — send with text, stop while the bot works, the voice glyph otherwise.
// One bar for the compact and the typing pill, so the field survives the first keystroke.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { accessoriesVisible, type CircleRole, type Presentation } from "../model/metrics";
import { t } from "../strings";
import { Glyph } from "./glyphs";

/** Someone the pill can message: every bot, and whatever else plugins add to `pill.target`. */
export interface PillTarget {
  id: string;
  name: string;
  /** An image URL inside the target's plugin; without one the pill draws its initial. */
  portrait?: string;
  /** The initial's background. */
  color?: string;
}

export interface PortraitProps {
  target: PillTarget;
  size?: number;
}

export function Portrait({ target, size = 24 }: PortraitProps): ReactElement {
  const initial = Array.from(target.name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span className="clp-portrait" style={{ width: size, height: size, ...(target.color && !target.portrait ? { background: target.color } : {}) }} aria-hidden="true">
      {target.portrait ? <img src={target.portrait} alt="" draggable={false} /> : initial}
    </span>
  );
}

export type BarMenu = "more" | "targets" | null;

export interface BarProps {
  presentation: Presentation;
  target: PillTarget;
  /** Every target the user can pick; the portrait opens the list when there is more than one. */
  targets?: readonly PillTarget[];
  draft: string;
  /** The working look: the plume shows, the field hides (it stays mounted, so a keystroke still lands). */
  working: boolean;
  circle: CircleRole;
  placeholder: string | null;
  stopping?: boolean;
  /** A card or a pinned turn covers the bar: hidden, mounted, out of the way of clicks. */
  covered?: boolean;
  /** ↗ and ⋯ may show (the typing pill, nothing covering it); they still give way to text that nears them. */
  accessories?: boolean;
  menu?: BarMenu;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onDraft?: (text: string) => void;
  /** The text's own height (its lines and the field's padding), whenever it changes: the pill grows with it. */
  onContentHeight?: (height: number) => void;
  onSend?: () => void;
  onStop?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onEscape?: () => void;
  /** A click on the working pill: open the typing pill over the running turn. */
  onOpen?: () => void;
  onMenu?: (menu: BarMenu) => void;
  onFullScreen?: () => void;
}

export function Bar(props: BarProps): ReactElement {
  const { presentation, target, targets = [], draft, working, circle, placeholder, stopping = false, covered = false, accessories = false, menu = null, inputRef } = props;
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? ownRef;
  const expanded = presentation === "expanded";
  const canPick = targets.length > 1;
  const [textWidth, setTextWidth] = useState(0);
  const onContentHeight = props.onContentHeight;

  // The field grows with its lines (up to the pill's ceiling, where it scrolls); ↗ and ⋯ give way to the text.
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = "0px";
    const height = input.scrollHeight > 0 ? input.scrollHeight : FALLBACK_LINE;
    input.style.height = `${height}px`;
    onContentHeight?.(height);
    setTextWidth(measureText(draft, input));
  }, [draft, presentation, ref, onContentHeight]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (draft.trim().length > 0) props.onSend?.();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onEscape?.();
    }
  };

  const showsAccessories = accessories && !covered && accessoriesVisible(draft, textWidth);
  const circleLabel = stopping ? t("clover.pill.stopping") : circle === "stop" ? t("clover.pill.stop") : circle === "send" ? t("clover.pill.send") : t("clover.pill.voice");

  return (
    <div
      className="clp-bar"
      data-covered={covered || undefined}
      style={covered ? { opacity: 0 } : undefined}
      aria-hidden={covered || undefined}
      onClick={(event) => {
        if (working && !covered && !(event.target as Element).closest("button")) props.onOpen?.();
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <button
          type="button"
          className="clp-portrait-button"
          aria-label={canPick ? t("clover.pill.target") : target.name}
          aria-haspopup={canPick ? "menu" : undefined}
          aria-expanded={canPick ? menu === "targets" : undefined}
          disabled={!canPick}
          data-menu-toggle="targets"
          onClick={() => props.onMenu?.(menu === "targets" ? null : "targets")}
          style={{ display: "inline-flex", opacity: working ? 0 : 1, transition: "opacity 250ms ease-out" }}
        >
          <Portrait target={target} />
        </button>
      </span>
      <div className="clp-field" data-hidden={working || covered || undefined} style={working || covered ? { opacity: 0 } : undefined}>
        <textarea
          ref={ref}
          className="clp-input"
          rows={1}
          value={draft}
          placeholder={placeholder ?? ""}
          aria-label={t("clover.pill.label", { name: target.name })}
          spellCheck
          tabIndex={working || covered ? -1 : 0}
          onChange={(event) => props.onDraft?.(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
        />
        {expanded ? (
          <div
            className="clp-accessories"
            data-shown={showsAccessories}
            style={showsAccessories ? undefined : { opacity: 0, transform: "scale(0.9)" }}
          >
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button type="button" className="clp-accessory" aria-label={t("clover.pill.more")} aria-haspopup="menu" aria-expanded={menu === "more"} data-menu-toggle="more" tabIndex={accessories ? 0 : -1} onClick={() => props.onMenu?.(menu === "more" ? null : "more")}>
                <Glyph name="ellipsis" />
              </button>
            </span>
            <button type="button" className="clp-accessory" aria-label={t("clover.pill.fullScreen")} tabIndex={accessories ? 0 : -1} onClick={props.onFullScreen}>
              <Glyph name="expand" />
            </button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="clp-circle"
        data-role={circle}
        data-stopping={stopping || undefined}
        aria-label={circleLabel}
        title={circleLabel}
        disabled={stopping}
        onClick={() => {
          if (circle === "stop") props.onStop?.();
          else if (circle === "send") props.onSend?.();
          // The voice circle is voice's place (lane K); it does nothing until voice lands.
        }}
      >
        {stopping ? <Spinner /> : <Glyph name={circle === "stop" ? "stop" : circle === "send" ? "arrowUp" : "mic"} />}
      </button>
    </div>
  );
}

/** The stop on its way: an arc turning, by SVG's own animation (no stylesheet keyframes). */
function Spinner(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false" data-glyph="spinner">
      <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

export interface MenuProps {
  side: "leading" | "trailing";
  label: string;
  onClose?: () => void;
  children?: ReactElement | ReactElement[];
}

/**
 * A small dark list floating above the pill, in the stack over it (it can't live inside the shape, which clips):
 * a click outside it, or Escape, closes it. The buttons that open it (`data-menu-toggle`) don't count as outside.
 */
export function Menu({ side, label, onClose, children }: MenuProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc || !onClose) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.("[data-menu-toggle]")) return;
      onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    doc.addEventListener("pointerdown", onPointer);
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.removeEventListener("pointerdown", onPointer);
      doc.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="clp-menu-row" data-side={side}>
      <div ref={ref} className="clp-menu" role="menu" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export interface BarMenusProps {
  menu: BarMenu;
  target: PillTarget;
  targets?: readonly PillTarget[];
  /** The main pill's width now: the row lines up with its edges. */
  width: number;
  onMenu?: (menu: BarMenu) => void;
  onTarget?: (id: string) => void;
  onOpenInApp?: () => void;
  onClearDraft?: () => void;
}

/** The bar's open menu, if any: who to message, or ⋯'s. Drawn in the stack above the main pill. */
export function BarMenus({ menu, target, targets = [], width, onMenu, onTarget, onOpenInApp, onClearDraft }: BarMenusProps): ReactElement | null {
  const close = () => onMenu?.(null);
  if (menu === "targets" && targets.length > 1) {
    return (
      <div style={{ width }}>
        <Menu side="leading" label={t("clover.pill.targets")} onClose={close}>
          {targets.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === target.id}
              className="clp-menu-item"
              onClick={() => {
                onTarget?.(option.id);
                close();
              }}
            >
              <Portrait target={option} size={20} />
              {option.name}
            </button>
          ))}
        </Menu>
      </div>
    );
  }
  if (menu === "more") {
    return (
      <div style={{ width }}>
        <Menu side="trailing" label={t("clover.pill.more")} onClose={close}>
          <button
            type="button"
            role="menuitem"
            className="clp-menu-item"
            onClick={() => {
              onOpenInApp?.();
              close();
            }}
          >
            <span className="clp-menu-glyph">
              <Glyph name="open" />
            </span>
            {t("clover.pill.openInApp", { name: target.name })}
          </button>
          <button
            type="button"
            role="menuitem"
            className="clp-menu-item"
            onClick={() => {
              onClearDraft?.();
              close();
            }}
          >
            <span className="clp-menu-glyph">
              <Glyph name="xmark" />
            </span>
            {t("clover.pill.clearDraft")}
          </button>
        </Menu>
      </div>
    );
  }
  return null;
}

/** One line of the field: its 20 px line and the 3 px padding above and below. */
const FALLBACK_LINE = 26;

let measureContext: CanvasRenderingContext2D | null | undefined;

/** The draft's first line's width in the field's own face; an estimate where there is no canvas (tests). */
export function measureText(text: string, input: HTMLElement | null): number {
  const line = text.split("\n")[0] ?? "";
  if (line.length === 0) return 0;
  if (measureContext === undefined) {
    try {
      measureContext = typeof document !== "undefined" ? (document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D | null) : null;
    } catch {
      measureContext = null;
    }
  }
  if (measureContext && input && typeof getComputedStyle === "function") {
    const style = getComputedStyle(input);
    measureContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return Math.ceil(measureContext.measureText(line).width);
  }
  return Math.ceil(line.length * 7.6);
}
