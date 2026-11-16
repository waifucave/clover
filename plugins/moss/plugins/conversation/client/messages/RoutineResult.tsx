import type { MessageContext } from "../context";
import { formatDuration, formatTime } from "../format";
import { IconClock, IconCross } from "../icons";
import { MarkdownText } from "../Markdown";
import { S } from "../strings";
import type { RoutineResultItem } from "../types";
import { Collapsible } from "./Collapsible";

/** A routine ran in a side thread on its computer and posted this short result (spec §7). */
export function RoutineResult({ item, ctx }: { item: RoutineResultItem; ctx: MessageContext }) {
  const open = ctx.actions.onOpenThread;
  const facts = [S.routineRan(item.routine.computer), formatTime(item.at, ctx.format)];
  if (item.durationMs !== undefined) facts.push(formatDuration(item.durationMs));
  return (
    <section className="cl-conv-event" data-kind="routine-result" data-status={item.status}>
      <header className="cl-conv-event__head">
        {item.status === "failed" ? <IconCross /> : <IconClock />}
        <span className="cl-conv-event__title">{item.routine.name}</span>
        {item.status === "failed" && <span className="cl-conv-event__badge">{S.routineFailed}</span>}
        <span className="cl-conv-event__facts">{facts.join(" · ")}</span>
      </header>
      {item.trigger && <div className="cl-conv-event__sub">{item.trigger}</div>}
      <div className="cl-conv-md cl-conv-event__body">
        <Collapsible text={item.summary}>
          <MarkdownText text={item.summary} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />
        </Collapsible>
      </div>
      {open && (
        <div className="cl-conv-event__actions">
          <button type="button" className="cl-conv-link-button" onClick={() => open(item.threadId)}>
            {S.routineOpenRun}
          </button>
        </div>
      )}
    </section>
  );
}
