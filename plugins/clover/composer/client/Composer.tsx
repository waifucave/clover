// The composer: where the user writes to a bot. Enter sends, Shift+Enter starts a new line, Escape
// stops a running turn. A message sent while the bot is mid-turn interrupts it at once (spec §6.4).
// While no computer running the bot can be reached, the draft stays and sending waits.
//
// `onSend` runs inside the key press or click itself, never after an await or a timer: the app
// counts a send as the user's only while that event's activation is still fresh (spec §5.5).
//
// Layout: a box holding the attachments, + to attach, the text, the microphone and Send (or Stop);
// beneath it, the approval-level pill and the model pill. A menu opens inside the part, in the flow
// above the box, so it never lies over the conversation where a sealed card's buttons sit (review
// item 1); it also closes when a card arrives.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconArrowUp, IconCheck, IconChevronDown, IconCross, IconFile, IconMic, IconMoon, IconPlus, IconShield, IconStop } from "./icons";
import { canSend, keyAction } from "./keys";
import { S } from "./strings";
import type { ComposerActionId, ComposerProps } from "./types";

/** At most this many attachments ride one message (the daemon refuses more). */
export const MAX_ATTACHMENTS = 20;
/** The field grows with its text up to this height, then scrolls. */
export const MAX_FIELD_HEIGHT = 240;

function hasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

/** An image the host resolved (`blob:`, inline data, the app's asset scheme); never a web URL. */
function safeAsset(url: string | undefined): string | undefined {
  return url && /^(blob:|data:image\/(png|jpeg|gif|webp|avif|svg\+xml)[;,]|clover-asset:)/i.test(url) ? url : undefined;
}

interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  /** A short tag after the label ("Asked for"). */
  tag?: string;
  checked: boolean;
  onPick: () => void;
}

interface MenuSection {
  title?: string;
  items: MenuItem[];
}

/** A menu of radio items. Arrow keys, Home and End move through it; Escape or a pick closes it and
 *  hands focus back to the pill that opened it. */
function Menu({
  label,
  side,
  sections,
  note,
  opener,
  onClose,
}: {
  label: string;
  /** Which edge of the composer the menu lines up with: its pill's. */
  side: "start" | "end";
  sections: MenuSection[];
  /** A line under the items that says how a pick works. */
  note?: string;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(
    (restoreFocus: boolean) => {
      onClose();
      if (restoreFocus) opener.current?.focus();
    },
    [onClose, opener],
  );
  useEffect(() => {
    const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? items?.[0])?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || menu.current?.contains(target) || opener.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [onClose, opener]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      close(false);
      return;
    }
    if (next !== undefined) {
      e.preventDefault();
      items[next]?.focus();
    }
  };
  return (
    <div ref={menu} className="cl-composer__menu" data-side={side} role="menu" aria-label={label} onKeyDown={move}>
      {sections.map((section, i) => (
        <div key={section.title ?? i} className="cl-composer__menu-section" role="group" aria-label={section.title}>
          {section.title && <div className="cl-composer__menu-title">{section.title}</div>}
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              tabIndex={-1}
              className="cl-composer__menu-item"
              onClick={() => {
                item.onPick();
                close(true);
              }}
            >
              <span className="cl-composer__menu-check">{item.checked ? <IconCheck /> : null}</span>
              <span className="cl-composer__menu-label">
                {item.label}
                {item.tag && <span className="cl-composer__menu-tag">{item.tag}</span>}
              </span>
              {item.detail && <span className="cl-composer__menu-detail">{item.detail}</span>}
            </button>
          ))}
        </div>
      ))}
      {note && <p className="cl-composer__menu-note">{note}</p>}
    </div>
  );
}

/** Push-to-talk. The hold ends however the press ends: the button let go, the pointer lost, the
 *  button or the window losing focus, the window hidden (review item 7). Only the primary button
 *  starts a hold. */
function useHold(voice: ComposerProps["voice"]) {
  const holding = useRef(false);
  const latest = useRef(voice);
  latest.current = voice;
  const start = useCallback(() => {
    if (holding.current || !latest.current) return;
    holding.current = true;
    latest.current.onPressStart();
  }, []);
  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    latest.current?.onPressEnd();
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "visible") end();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", hidden);
      end();
    };
  }, [end]);
  return { start, end };
}

export function Composer(props: ComposerProps) {
  const {
    botName,
    value,
    onChange,
    onSend,
    attachments = [],
    onAttach,
    onRemoveAttachment,
    onAddFiles,
    running = false,
    onStop,
    asleep,
    model,
    level,
    voice,
    cardPending = false,
    maxAttachments = MAX_ATTACHMENTS,
    placeholder,
    autoFocus,
    renderAction,
    initialMenu,
  } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const modelPill = useRef<HTMLButtonElement>(null);
  const levelPill = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<"model" | "level" | null>(() =>
    initialMenu === "model" && model ? "model" : initialMenu === "level" && level ? "level" : null,
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const hold = useHold(voice);
  const tooMany = attachments.length > maxAttachments;
  const sendable = canSend(value, attachments.length, maxAttachments, asleep !== undefined);
  const empty = value.trim().length === 0 && attachments.length === 0;
  const listening = voice?.listening === true;

  // A card arriving closes any menu, so nothing of the composer's competes with it.
  useEffect(() => {
    if (cardPending) setMenu(null);
  }, [cardPending]);

  // Grow with the text, up to a bound.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_HEIGHT)}px`;
  }, [value]);

  const send = () => {
    if (!sendable) return;
    onSend({ text: value, attachments });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = keyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode,
      },
      running,
    );
    if (action === "send") {
      e.preventDefault();
      // A held Enter repeats; only the first press sends.
      if (!e.repeat) send();
    } else if (action === "stop" && onStop) {
      e.preventDefault();
      onStop();
    }
  };

  const action = (id: ComposerActionId, standard: ReactNode): ReactNode => (renderAction ? renderAction(id, standard) : standard);

  const attach = onAttach
    ? action(
        "attach",
        <button key="attach" type="button" className="cl-composer__icon-button" aria-label={S.attach} title={S.attach} onClick={onAttach}>
          <IconPlus />
        </button>,
      )
    : null;

  const modelLabel = model ? (model.models.find((m) => m.id === model.model)?.label ?? model.model) : "";
  const modelButton = model
    ? action(
        "model",
        <button
          key="model"
          ref={modelPill}
          type="button"
          className="cl-composer__pill"
          aria-haspopup="menu"
          aria-expanded={menu === "model"}
          aria-label={S.model(model.effort ? `${modelLabel}, ${model.effort}` : modelLabel)}
          disabled={cardPending}
          onClick={() => setMenu((m) => (m === "model" ? null : "model"))}
        >
          <span className="cl-composer__pill-label">{modelLabel}</span>
          {model.effort && <span className="cl-composer__pill-detail">{model.effort}</span>}
          <IconChevronDown />
        </button>,
      )
    : null;

  const levelName = (id: string) => level?.levels.find((l) => l.id === id)?.label ?? id;
  const levelLabel = level ? levelName(level.level) : "";
  const requestedLabel = level?.requested && level.requested !== level.level ? levelName(level.requested) : undefined;
  const levelButton = level
    ? action(
        "level",
        <button
          key="level"
          ref={levelPill}
          type="button"
          className="cl-composer__pill"
          data-level={level.level}
          data-requested={requestedLabel ? level.requested : undefined}
          aria-haspopup="menu"
          aria-expanded={menu === "level"}
          aria-label={S.level(level.computer, levelLabel, requestedLabel)}
          disabled={cardPending}
          onClick={() => setMenu((m) => (m === "level" ? null : "level"))}
        >
          <IconShield />
          <span className="cl-composer__pill-label">{levelLabel}</span>
          <span className="cl-composer__pill-detail">{level.computer}</span>
          {requestedLabel && <span className="cl-composer__pill-request">{S.levelAsked(requestedLabel)}</span>}
          <IconChevronDown />
        </button>,
      )
    : null;

  const voiceButton = voice
    ? action(
        "voice",
        <button
          key="voice"
          type="button"
          className="cl-composer__icon-button cl-composer__voice"
          aria-label={S.holdToTalk}
          title={S.holdToTalk}
          aria-pressed={listening}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            hold.start();
          }}
          onPointerUp={hold.end}
          onPointerCancel={hold.end}
          onLostPointerCapture={hold.end}
          onBlur={hold.end}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              hold.start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              hold.end();
            }
          }}
        >
          <IconMic />
        </button>,
      )
    : null;

  // Mid-turn with nothing typed, Stop takes Send's place; with a draft, Send (which interrupts) sits
  // beside Stop. Stop is a square on the control colour, Send an arrow on the accent: never alike.
  const stopButton =
    running && onStop
      ? action(
          "stop",
          <button key="stop" type="button" className="cl-composer__stop" aria-label={S.stop} title={S.stop} onClick={onStop}>
            <IconStop />
          </button>,
        )
      : null;
  const sendButton =
    running && empty && stopButton
      ? null
      : action(
          "send",
          <button key="send" type="button" className="cl-composer__send" aria-label={S.send} title={S.send} disabled={!sendable} onClick={send}>
            <IconArrowUp />
          </button>,
        );

  const note = asleep ? (
    <div className="cl-composer__note" data-kind="asleep" id={noteId} role="status">
      <IconMoon />
      {S.asleep(botName, asleep.reason)}
    </div>
  ) : running && !empty ? (
    <div className="cl-composer__note" data-kind="interrupt" id={noteId}>
      {S.interruptHint(botName)}
    </div>
  ) : null;

  const openMenu =
    menu === "model" && model ? (
      <Menu
        label={S.modelMenu}
        side="end"
        opener={modelPill}
        onClose={closeMenu}
        sections={[
          {
            title: S.modelSection,
            items: model.models.map((m) => ({
              id: m.id,
              label: m.label,
              detail: m.detail,
              checked: m.id === model.model,
              onPick: () => model.onChange({ model: m.id, effort: model.effort }),
            })),
          },
          ...(model.efforts && model.efforts.length > 0
            ? [
                {
                  title: S.effort,
                  items: model.efforts.map((effort) => ({
                    id: `effort-${effort}`,
                    label: effort,
                    checked: effort === model.effort,
                    onPick: () => model.onChange({ model: model.model, effort }),
                  })),
                },
              ]
            : []),
        ]}
      />
    ) : menu === "level" && level ? (
      <Menu
        label={S.levelMenu(level.computer)}
        side="start"
        opener={levelPill}
        onClose={closeMenu}
        note={S.levelNote}
        sections={[
          {
            title: S.levelMenu(level.computer),
            items: level.levels.map((l) => ({
              id: l.id,
              label: l.label,
              detail: l.detail,
              tag: l.id === level.requested && l.id !== level.level ? S.levelAskedTag : undefined,
              checked: l.id === level.level,
              // A pick only asks: the level stays until the card is answered.
              onPick: () => {
                if (l.id !== level.level) level.onRequest(l.id);
              },
            })),
          },
        ]}
      />
    ) : null;

  return (
    <div
      className="cl-composer"
      data-running={running || undefined}
      data-asleep={asleep ? true : undefined}
      data-listening={listening || undefined}
      onDragEnter={(e) => {
        if (onAddFiles && hasFiles(e)) setDragging(true);
      }}
      onDragOver={(e) => {
        if (onAddFiles && hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (onAddFiles && files.length > 0) {
          e.preventDefault();
          onAddFiles(files);
        }
      }}
    >
      {openMenu}
      <div className="cl-composer__box">
        {attachments.length > 0 && (
          <ul className="cl-composer__attachments">
            {attachments.map((a) => (
              <li key={a.id} className="cl-composer__attachment" data-kind={a.kind} title={a.path ?? a.name}>
                {a.kind === "image" && safeAsset(a.previewUrl) ? <img className="cl-composer__thumb" src={safeAsset(a.previewUrl)} alt="" /> : <IconFile />}
                <span className="cl-composer__attachment-name">{a.name}</span>
                {onRemoveAttachment && (
                  <button type="button" className="cl-composer__remove" aria-label={S.remove(a.name)} onClick={() => onRemoveAttachment(a.id)}>
                    <IconCross />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {tooMany && (
          <div className="cl-composer__error" role="alert">
            {S.tooManyAttachments(maxAttachments)}
          </div>
        )}
        <div className="cl-composer__row">
          {attach}
          <textarea
            ref={field}
            className="cl-composer__field"
            rows={1}
            value={value}
            aria-label={S.label(botName)}
            aria-describedby={note ? noteId : undefined}
            placeholder={listening ? S.listening : placeholder ?? S.placeholder(botName)}
            readOnly={listening}
            autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!onAddFiles || files.length === 0) return;
              // Files go to the host; text pasted with them still lands in the field.
              const data = e.clipboardData;
              const text = typeof data?.getData === "function" ? data.getData("text/plain") : "";
              if (text.length === 0) e.preventDefault();
              onAddFiles(files);
            }}
          />
          {voiceButton}
          {stopButton}
          {sendButton}
        </div>
        {dragging && <div className="cl-composer__drop">{S.dropHere}</div>}
      </div>
      {(levelButton || modelButton) && (
        <div className="cl-composer__under">
          {levelButton}
          <span className="cl-composer__spacer" />
          {modelButton}
        </div>
      )}
      {note}
    </div>
  );
}
