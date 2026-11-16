import type { ReactNode } from "react";
import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { MarkdownText, StreamingMarkdown } from "../Markdown";
import { CopyButton } from "../parts";
import { actionsFor, MessageActions, useMessageNote } from "./actions";
import { S } from "../strings";
import type { BotItem } from "../types";

/** The bot's words. `final` marks its last word in a stretch of work, which alone carries its actions (copy, and the
 *  plugins' buttons, such as MOSS Voice's speak): a message between tool calls is a step, not the answer.
 *  `extra` is the reply's add-ons (`conversation.message.extra`) when a theme sets them in this row
 *  (`conversation.extra.inline`). */
export function BotMessage({ item, ctx, final, extra }: { item: BotItem; ctx: MessageContext; final?: boolean; extra?: ReactNode }) {
  const streaming = item.streaming === true;
  const [note, setNote] = useMessageNote();
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
