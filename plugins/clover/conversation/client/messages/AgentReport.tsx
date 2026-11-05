import type { MessageContext } from "../context";
import { formatTime } from "../format";
import { IconAgent, IconMessage, IconPlug } from "../icons";
import { MarkdownText } from "../Markdown";
import { S } from "../strings";
import type { AgentReportItem } from "../types";

/** A message another session sent this bot: a background agent's report while it works, or another
 *  bot's message, folded into the turn (spec §6.4, §9.3). Never drawn as the user's. */
export function AgentReport({ item, ctx }: { item: AgentReportItem; ctx: MessageContext }) {
  const { from } = item;
  const role =
    from.kind === "agent"
      ? S.reportAgent(from.backend)
      : from.kind === "bot"
        ? S.reportBot
        : from.kind === "plugin"
          ? S.reportPlugin(from.id)
          : S.reportSession;
  const facts = [role];
  if (from.computer) facts.push(S.toolOnComputer(from.computer));
  facts.push(formatTime(item.at, ctx.format));
  if (item.folded) facts.push(S.reportFolded);
  const openAgent = from.kind === "agent" ? ctx.actions.onOpenAgent : undefined;
  return (
    <section className="cl-conv-event" data-kind="agent-report" data-from={from.kind}>
      <header className="cl-conv-event__head">
        {from.kind === "agent" ? <IconAgent /> : from.kind === "plugin" ? <IconPlug /> : <IconMessage />}
        {openAgent ? (
          <button type="button" className="cl-conv-event__title cl-conv-link-button" onClick={() => openAgent(from.id)}>
            {S.reportFrom}{" "}
            <bdi>{from.name}</bdi>
          </button>
        ) : (
          <span className="cl-conv-event__title">
            {S.reportFrom}{" "}
            <bdi>{from.name}</bdi>
          </span>
        )}
        <span className="cl-conv-event__facts">{facts.join(" · ")}</span>
      </header>
      <div className="cl-conv-md cl-conv-event__body">
        <MarkdownText text={item.text} onOpenLink={ctx.actions.onOpenLink} onCopy={ctx.actions.onCopy} />
      </div>
    </section>
  );
}
