import type { MessageContext } from "../context";
import { formatDuration } from "../format";
import { IconAgent, IconTerminal } from "../icons";
import { MarkdownText } from "../Markdown";
import { S } from "../strings";
import type { TaskNotificationItem } from "../types";
import { Collapsible } from "./Collapsible";

/** A background agent or command finished: its final report, and where its whole transcript is
 *  (spec §9.3). */
export function TaskNotification({ item, ctx }: { item: TaskNotificationItem; ctx: MessageContext }) {
  const { task } = item;
  const facts: string[] = [];
  if (task.computer) facts.push(S.toolOnComputer(task.computer));
  if (item.durationMs !== undefined) facts.push(formatDuration(item.durationMs));
  if (task.kind === "command" && typeof task.exitCode === "number") facts.push(S.taskExitCode(task.exitCode));
  const title =
    task.kind === "agent" ? `${task.name} ${S.taskAgentStatus[item.status]}` : S.taskCommandStatus[item.status];
  const openAgent = task.kind === "agent" ? ctx.actions.onOpenAgent : undefined;
  const openFile = ctx.actions.onOpenFile;
  return (
    <section className="cl-conv-event" data-kind="task-notification" data-status={item.status}>
      <header className="cl-conv-event__head">
        {task.kind === "agent" ? <IconAgent /> : <IconTerminal />}
        <span className="cl-conv-event__title">{title}</span>
        {facts.length > 0 && <span className="cl-conv-event__facts">{facts.join(" · ")}</span>}
      </header>
      {task.kind === "agent" && task.backend && <div className="cl-conv-event__sub">{task.backend}</div>}
      {task.kind === "command" && <code className="cl-conv-event__command">{task.command}</code>}
      {item.report && (
        <div className="cl-conv-md cl-conv-event__body">
          <Collapsible text={item.report}>
            <MarkdownText text={item.report} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />
          </Collapsible>
        </div>
      )}
      {(openAgent || (item.transcriptPath && openFile)) && (
        <div className="cl-conv-event__actions">
          {openAgent && task.kind === "agent" && (
            <button type="button" className="cl-conv-link-button" onClick={() => openAgent(task.agentId)}>
              {S.taskOpenTab}
            </button>
          )}
          {item.transcriptPath && openFile && (
            <button type="button" className="cl-conv-link-button" onClick={() => openFile(item.transcriptPath ?? "")} title={item.transcriptPath}>
              {S.taskOpenTranscript}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
