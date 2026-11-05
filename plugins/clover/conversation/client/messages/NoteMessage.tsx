import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { IconError, IconInfo, IconPlug, IconWarning } from "../icons";
import { S } from "../strings";
import type { NoteItem } from "../types";

/** A quiet line: the core's notices, a hook's, or a plugin's note. Plain text always, and a plugin's
 *  or a hook's note names where it came from, so no note can pass for the bot or the user. */
export function NoteMessage({ item, ctx }: { item: NoteItem; ctx: MessageContext }) {
  const tone = item.tone ?? "info";
  const source =
    item.from?.kind === "plugin" ? S.notePlugin(item.from.name) : item.from?.kind === "hook" ? S.noteHook(item.from.plugin) : undefined;
  if (item.variant === "divider") {
    return (
      <div className="cl-conv-divider" data-kind="note" data-tone={tone} role="separator" aria-label={item.text}>
        <span className="cl-conv-divider__text">{item.text}</span>
      </div>
    );
  }
  const icon = tone === "error" ? <IconError /> : tone === "warning" ? <IconWarning /> : source ? <IconPlug /> : <IconInfo />;
  return (
    <div className="cl-conv-note" data-kind="note" data-tone={tone} title={formatTime(item.at, ctx.format)}>
      {icon}
      <span className="cl-conv-note__text">
        {source && <span className="cl-conv-note__source">{source}: </span>}
        {item.text}
      </span>
    </div>
  );
}
