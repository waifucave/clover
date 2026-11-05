import type { ReactNode } from "react";
import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { IconFile, IconImage } from "../icons";
import { S } from "../strings";
import type { Attachment, UserItem } from "../types";

const TOKEN = /\[(Image|File) #(\d+)\]/g;

/** The user's text with each `[Image #n]` / `[File #n]` it names drawn as a chip. */
function withChips(text: string, attachments: readonly Attachment[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const kind = m[1] === "Image" ? "image" : "file";
    const n = Number(m[2]);
    const found = attachments.find((a) => a.kind === kind && a.n === n);
    if (!found) continue;
    const index = m.index ?? 0;
    out.push(text.slice(last, index));
    out.push(
      <span key={`${kind}${n}@${index}`} className="cl-conv-user__chip" title={found.path}>
        {kind === "image" ? <IconImage /> : <IconFile />}
        {found.name}
      </span>,
    );
    last = index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function UserMessage({ item, ctx }: { item: UserItem; ctx: MessageContext }) {
  const attachments = item.attachments ?? [];
  const images = attachments.filter((a) => a.kind === "image");
  const otherDevice = item.device !== undefined && item.device !== ctx.device;
  const time = formatTime(item.at, ctx.format);
  return (
    <article className="cl-conv-user" data-kind="user" aria-label={S.you}>
      {images.length > 0 && (
        <div className="cl-conv-user__images">
          {images.map((a) =>
            a.previewUrl ? (
              <img key={a.n} className="cl-conv-user__thumb" src={a.previewUrl} alt={a.name} title={a.path} />
            ) : (
              <span key={a.n} className="cl-conv-user__chip" title={a.path}>
                <IconImage />
                {a.name}
              </span>
            ),
          )}
        </div>
      )}
      <div className="cl-conv-user__bubble">{withChips(item.text, attachments)}</div>
      <div className="cl-conv-user__meta" data-always={otherDevice || item.late || undefined}>
        <time dateTime={new Date(item.at).toISOString()}>{time}</time>
        {otherDevice && <span>{S.fromDevice(item.device ?? "")}</span>}
        {item.late && <span>{S.arrivedLate}</span>}
      </div>
    </article>
  );
}
