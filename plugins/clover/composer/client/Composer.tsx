// The composer: where the user writes to a bot. Enter sends, Shift+Enter starts a new line, Escape
// stops a running turn. A message sent while the bot is mid-turn interrupts it at once (spec §6.4).
// While no computer running the bot can be reached, the draft stays and sending waits.
//
// `onSend` runs inside the key press or click itself, never after an await or a timer: the app
// counts a send as the user's only while that event's activation is still fresh (spec §5.5).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { IconArrowUp, IconCheck, IconChevronDown, IconCross, IconFile, IconMic, IconMoon, IconPlus, IconStop } from "./icons";
import { canSend, keyAction } from "./keys";
import { S } from "./strings";
import type { ComposerActionId, ComposerModelChoice, ComposerProps } from "./types";

/** At most this many attachments ride one message (the daemon refuses more). */
export const MAX_ATTACHMENTS = 20;
/** The field grows with its text up to this height, then scrolls. */
export const MAX_FIELD_HEIGHT = 240;

function hasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

function ModelMenu({ choice, onClose }: { choice: ComposerModelChoice; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (e: MouseEvent) => {
      if (menu.current && e.target instanceof Node && !menu.current.contains(e.target) && !(e.target as Element).closest?.(".cl-composer__model")) onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [onClose]);
  return (
    <div
      ref={menu}
      className="cl-composer__menu"
      role="menu"
      aria-label={S.modelMenu}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {choice.models.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitemradio"
          aria-checked={m.id === choice.model}
          className="cl-composer__menu-item"
          onClick={() => {
            choice.onChange({ model: m.id, effort: choice.effort });
            onClose();
          }}
        >
          <span className="cl-composer__menu-check">{m.id === choice.model ? <IconCheck /> : null}</span>
          <span>{m.label}</span>
          {m.detail && <span className="cl-composer__menu-detail">{m.detail}</span>}
        </button>
      ))}
      {choice.efforts && choice.efforts.length > 0 && (
        <>
          <div className="cl-composer__menu-title">{S.effort}</div>
          <div className="cl-composer__efforts" role="group" aria-label={S.effort}>
            {choice.efforts.map((effort) => (
              <button
                key={effort}
                type="button"
                role="menuitemradio"
                aria-checked={effort === choice.effort}
                className="cl-composer__effort"
                onClick={() => choice.onChange({ model: choice.model, effort })}
              >
                {effort}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
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
    voice,
    maxAttachments = MAX_ATTACHMENTS,
    placeholder,
    autoFocus,
    renderAction,
    initialMenuOpen = false,
  } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(initialMenuOpen && model !== undefined);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const tooMany = attachments.length > maxAttachments;
  const sendable = canSend(value, attachments.length, maxAttachments, asleep !== undefined);
  const empty = value.trim().length === 0 && attachments.length === 0;
  const listening = voice?.listening === true;

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
      send();
    } else if (action === "stop" && onStop) {
      e.preventDefault();
      onStop();
    }
  };

  const action = (id: ComposerActionId, standard: ReactNode): ReactNode => (renderAction ? renderAction(id, standard) : standard);

  const attach = onAttach
    ? action(
        "attach",
        <button key="attach" type="button" className="cl-composer__button" aria-label={S.attach} title={S.attach} onClick={onAttach}>
          <IconPlus />
        </button>,
      )
    : null;

  const modelButton = model
    ? action(
        "model",
        <button
          key="model"
          type="button"
          className="cl-composer__model"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={S.model(model.models.find((m) => m.id === model.model)?.label ?? model.model)}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span>{model.models.find((m) => m.id === model.model)?.label ?? model.model}</span>
          {model.effort && <span className="cl-composer__model-effort">{model.effort}</span>}
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
          className="cl-composer__button cl-composer__voice"
          aria-label={S.holdToTalk}
          title={S.holdToTalk}
          aria-pressed={listening}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            voice.onPressStart();
          }}
          onPointerUp={() => voice.onPressEnd()}
          onPointerCancel={() => voice.onPressEnd()}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              voice.onPressStart();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              voice.onPressEnd();
            }
          }}
        >
          <IconMic />
        </button>,
      )
    : null;

  // Mid-turn with nothing typed, the one round button stops the turn; with a draft it sends (which
  // interrupts), and Stop stands beside it.
  const stopButton =
    running && onStop
      ? action(
          "stop",
          <button key="stop" type="button" className="cl-composer__button cl-composer__primary" aria-label={S.stop} title={S.stop} onClick={onStop}>
            <IconStop />
          </button>,
        )
      : null;
  const sendButton =
    running && empty && stopButton
      ? null
      : action(
          "send",
          <button key="send" type="button" className="cl-composer__button cl-composer__primary" aria-label={S.send} title={S.send} disabled={!sendable} onClick={send}>
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
      <div className="cl-composer__card">
        {attachments.length > 0 && (
          <ul className="cl-composer__attachments">
            {attachments.map((a) => (
              <li key={a.id} className="cl-composer__attachment" data-kind={a.kind} title={a.path ?? a.name}>
                {a.kind === "image" && a.previewUrl ? <img className="cl-composer__thumb" src={a.previewUrl} alt="" /> : <IconFile />}
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
            if (onAddFiles && files.length > 0) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
        />
        <div className="cl-composer__bar">
          {attach}
          <span className="cl-composer__spacer" />
          {modelButton}
          {voiceButton}
          {sendButton && stopButton ? (
            <>
              {stopButton}
              {sendButton}
            </>
          ) : (
            sendButton ?? stopButton
          )}
        </div>
        {menuOpen && model && <ModelMenu choice={model} onClose={closeMenu} />}
        {dragging && <div className="cl-composer__drop">{S.dropHere}</div>}
      </div>
      {note}
    </div>
  );
}
