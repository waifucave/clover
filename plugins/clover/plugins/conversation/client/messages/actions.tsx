// A message's small buttons from plugins (`conversation.message.action`): data the view draws in the message's row of
// actions, no frame and no component. A press asks the host to run the entry's handler for this one message (its `seq`
// in the log), and the handler's one sentence, when it gives one, shows under the message for a moment.
import { useEffect, useRef, useState } from "react";
import type { MessageContext } from "../context";
import { IconSparkles } from "../icons";
import { S } from "../strings";
import type { ActionOutcome, MessageAction } from "../types";

/** How long a note under a message (an action's, a speak's) stays. */
export const NOTE_MS = 6000;

/** One short note under a message, gone after `NOTE_MS`. */
export function useMessageNote(): [string | undefined, (note: string | undefined) => void] {
  const [note, setNote] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (note === undefined) return;
    const t = setTimeout(() => setNote(undefined), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  return [note, setNote];
}

/** The plugins' actions this message carries: `on` says which side (a finished reply by default). */
export function actionsFor(ctx: MessageContext, side: "assistant" | "user"): readonly MessageAction[] {
  return (ctx.messageActions ?? []).filter((a) => a.on === side || a.on === "both");
}

/** A plugin's picture, only as the app serves a plugin's own image (`/_t/…`). */
const ownImage = (icon: string | undefined) => (icon !== undefined && /^\/_t\/[^?#]+$/.test(icon) && !icon.includes("..") ? icon : undefined);

/** The message's action buttons, each one press at a time. */
export function MessageActions({ actions, seq, ctx, onNote }: { actions: readonly MessageAction[]; seq: number; ctx: MessageContext; onNote: (note: string | undefined) => void }) {
  const run = ctx.actions.onMessageAction;
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  if (!run || actions.length === 0) return null;
  const press = (a: MessageAction) => {
    if (busy !== undefined) return;
    setBusy(a.ref);
    onNote(undefined);
    Promise.resolve()
      .then(() => run(a, { seq }))
      .then(
        (r: ActionOutcome | void) => {
          if (!live.current) return;
          setBusy(undefined);
          if (r && typeof r.note === "string" && r.note.trim() !== "") onNote(r.note.trim());
        },
        (err: unknown) => {
          if (!live.current) return;
          setBusy(undefined);
          const reason = err instanceof Error ? err.message.trim() : "";
          onNote(reason !== "" && reason.length <= 300 ? reason : S.actionFailed);
        },
      );
  };
  return (
    <>
      {actions.map((a) => {
        const icon = ownImage(a.icon);
        return (
          <button
            key={a.ref}
            type="button"
            className="cl-conv-action"
            data-action={a.ref}
            aria-label={a.title}
            title={a.title}
            aria-busy={busy === a.ref || undefined}
            disabled={busy !== undefined && busy !== a.ref}
            onClick={() => press(a)}
          >
            {icon ? <img className="cl-conv-action__icon" src={icon} alt="" width={16} height={16} draggable={false} /> : <IconSparkles />}
          </button>
        );
      })}
    </>
  );
}
