import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { IconError, IconInfo, IconPlug, IconWarning } from "../icons";
import { S } from "../strings";
import type { NoteItem, NoteSource } from "../types";

/** Who wrote a note that isn't the core's. Names are the plugin's own choice, so each sits in `<bdi>`
 *  (bidi controls in a name can't reorder the label around it), and a plugin's id shows beside its
 *  name, since two plugins may pick the same name. */
function SourceLabel({ from }: { from: Exclude<NoteSource, { kind: "core" }> }) {
  if (from.kind === "hook") {
    return (
      <span className="cl-conv-note__source">
        {S.noteHookFrom} <bdi>{from.plugin}</bdi>
      </span>
    );
  }
  return (
    <span className="cl-conv-note__source">
      <bdi>{from.name}</bdi> <span className="cl-conv-note__id">({S.notePluginId} <bdi>{from.id}</bdi>)</span>
    </span>
  );
}

/** The source as plain text, for a separator's accessible name. */
function sourceText(from: Exclude<NoteSource, { kind: "core" }>): string {
  return from.kind === "hook" ? `${S.noteHookFrom} ${from.plugin}` : `${from.name} (${S.notePluginId} ${from.id})`;
}

/** A quiet line: the core's notices, a hook's, or a plugin's note. Plain text always. A note from a
 *  plugin or a hook always names where it came from, as a line or as a divider, so none can pass for
 *  the core's own (a compaction) or for the bot or the user (review item 4). */
export function NoteMessage({ item, ctx }: { item: NoteItem; ctx: MessageContext }) {
  const tone = item.tone ?? "info";
  const from = item.from && item.from.kind !== "core" ? item.from : undefined;
  if (item.variant === "divider") {
    return (
      <div
        className="cl-conv-divider"
        data-kind="note"
        data-tone={tone}
        data-from={from?.kind ?? "core"}
        role="separator"
        aria-label={from ? `${sourceText(from)}: ${item.text}` : item.text}
      >
        <span className="cl-conv-divider__text">
          {from && (
            <>
              <SourceLabel from={from} />
              {": "}
            </>
          )}
          {item.text}
        </span>
      </div>
    );
  }
  const icon = tone === "error" ? <IconError /> : tone === "warning" ? <IconWarning /> : from ? <IconPlug /> : <IconInfo />;
  return (
    <div className="cl-conv-note" data-kind="note" data-tone={tone} data-from={from?.kind ?? "core"} title={formatTime(item.at, ctx.format)}>
      {icon}
      <span className="cl-conv-note__text">
        {from && (
          <>
            <SourceLabel from={from} />
            {": "}
          </>
        )}
        {item.text}
      </span>
    </div>
  );
}
