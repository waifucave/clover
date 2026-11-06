import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { MarkdownText } from "../Markdown";
import { CopyButton } from "../parts";
import { S } from "../strings";
import type { BotItem } from "../types";

/** The bot's words. `final` marks its last word in a stretch of work, which alone carries a copy
 *  button: a message between tool calls is a step, not the answer. */
export function BotMessage({ item, ctx, final }: { item: BotItem; ctx: MessageContext; final?: boolean }) {
  const streaming = item.streaming === true;
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
        <MarkdownText text={item.text} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />
      </div>
      {item.interrupted && <div className="cl-conv-bot__interrupted">{S.interrupted}</div>}
      {final && !streaming && (
        <div className="cl-conv-bot__actions">
          <CopyButton text={item.text} label={S.copyMessage} onCopy={ctx.actions.onCopy} />
        </div>
      )}
    </article>
  );
}
