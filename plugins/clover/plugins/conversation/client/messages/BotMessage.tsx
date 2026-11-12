import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { MarkdownText, StreamingMarkdown } from "../Markdown";
import { CopyButton, SpeakButton } from "../parts";
import { actionsFor, MessageActions, useMessageNote } from "./actions";
import { S } from "../strings";
import type { BotItem, SpeakOutcome } from "../types";

/** A speak the core said started, but no speaking was ever heard of within this: the button goes back to rest. */
export const SPEAK_SETTLE_MS = 4000;

/** The speak button's own state for one reply: asked, then speaking until the bot's voice goes quiet (or never seen
 *  speaking within `SPEAK_SETTLE_MS`), and the core's note when it said it wouldn't speak. */
function useSpeak(item: BotItem, ctx: MessageContext, setNote: (note: string | undefined) => void) {
  const [state, setState] = useState<"idle" | "asking" | "speaking">("idle");
  const heard = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // While this reply is the one asked for: the bot's voice going quiet after it spoke ends it.
  useEffect(() => {
    if (state !== "speaking") return;
    if (ctx.speaking) heard.current = true;
    else if (heard.current) setState("idle");
  }, [state, ctx.speaking]);
  useEffect(() => {
    if (state !== "speaking") return;
    const t = setTimeout(() => {
      if (!heard.current) setState("idle");
    }, SPEAK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [state]);
  const speak = ctx.actions.onSpeak;
  const press = () => {
    if (!speak || state === "asking") return;
    heard.current = false;
    setNote(undefined);
    setState("asking");
    Promise.resolve()
      .then(() => speak(item))
      .then(
        (r: SpeakOutcome | void) => {
          if (!live.current) return;
          if (r && r.speaking === false) {
            setState("idle");
            if (r.note) setNote(r.note);
          } else setState("speaking");
        },
        (err: unknown) => {
          if (!live.current) return;
          setState("idle");
          const reason = err instanceof Error ? err.message.trim() : "";
          setNote(reason !== "" && reason.length <= 300 ? reason : S.speakFailed);
        },
      );
  };
  return { state, press };
}

/** The bot's words. `final` marks its last word in a stretch of work, which alone carries its actions (copy, and
 *  speak when the host offers it for a reply from the log): a message between tool calls is a step, not the answer.
 *  `extra` is the reply's add-ons (`conversation.message.extra`) when a theme sets them in this row
 *  (`conversation.extra.inline`). */
export function BotMessage({ item, ctx, final, extra }: { item: BotItem; ctx: MessageContext; final?: boolean; extra?: ReactNode }) {
  const streaming = item.streaming === true;
  const [note, setNote] = useMessageNote();
  const speech = useSpeak(item, ctx, setNote);
  const speakable = ctx.actions.onSpeak !== undefined && item.seq !== undefined;
  const plugged = item.seq !== undefined ? actionsFor(ctx, "assistant") : [];
  return (
    <article
      className="cl-conv-bot"
      data-kind="bot"
      data-streaming={streaming || undefined}
      aria-label={S.botSaid(ctx.botName)}
      aria-busy={streaming || undefined}
      title={formatTime(item.at, ctx.format)}
    >
      <div className="cl-conv-md" data-empty={item.text.length === 0 || undefined}>
        {streaming
          ? <StreamingMarkdown text={item.text} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />
          : <MarkdownText text={item.text} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />}
      </div>
      {item.interrupted && <div className="cl-conv-bot__interrupted">{S.interrupted}</div>}
      {final && !streaming && (
        <div className="cl-conv-bot__actions">
          <CopyButton text={item.text} label={S.copyMessage} onCopy={ctx.actions.onCopy} />
          {speakable && <SpeakButton state={speech.state} onSpeak={speech.press} />}
          {plugged.length > 0 && <MessageActions actions={plugged} seq={item.seq!} ctx={ctx} onNote={setNote} />}
          {extra !== undefined && <div className="cl-conv__extra" data-inline="">{extra}</div>}
        </div>
      )}
      {note !== undefined && (
        <div className="cl-conv-bot__note" role="status">
          {note}
        </div>
      )}
    </article>
  );
}
