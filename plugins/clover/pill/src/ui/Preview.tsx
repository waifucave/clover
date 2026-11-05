// A pinned turn shown alone (Winter's `ExpandedPillTurnPreview`): the prompt cut to one line, quiet, with
// where the turn sits ("3/7") on the right; under it the whole reply in plain words, scrolling once it
// passes the pill's ceiling. A click goes back to the message box.

import type { ReactElement } from "react";
import type { TurnPreview } from "../model/preview";
import { t } from "../strings";

export interface PreviewProps {
  preview: TurnPreview;
  onLeave?: () => void;
}

export function Preview({ preview, onLeave }: PreviewProps): ReactElement {
  return (
    <div className="clp-preview" role="article" aria-label={t("clover.pill.turn", { position: preview.position })} onClick={onLeave} title={t("clover.pill.leavePreview")}>
      <div className="clp-preview-head">
        <span className="clp-preview-prompt">{preview.prompt}</span>
        <span className="clp-preview-position">{preview.position}</span>
      </div>
      <div className="clp-preview-reply">{preview.reply}</div>
    </div>
  );
}
