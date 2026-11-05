// An approval card. Its words are core data this plugin shows but cannot read (spec §5.5): the view
// places the core's sealed frames — what is asked, the command, the computer, the risk, the
// reviewer's reason, and the approve and deny buttons — and adds only its own words around them
// (the outcome, the deadline). Nothing here may sit over a sealed frame or fade, filter or shrink it,
// or the core stops counting clicks on it; the stylesheet test holds that line.
import type { ReactElement } from "react";
import type { MessageContext } from "../context";
import { minutesUntil } from "../format";
import { IconCheck, IconClock, IconCross, IconDash, IconShield } from "../icons";
import { Card } from "../sdk";
import { S } from "../strings";
import type { ApprovalItem } from "../types";

function outcome(item: ApprovalItem): { text: string; icon: ReactElement } {
  const on = item.answeredOn ? ` ${S.answeredOn(item.answeredOn)}` : "";
  switch (item.state) {
    case "approved":
      return { text: `${S.approvalApproved}${on}`, icon: <IconCheck /> };
    case "denied":
      return { text: `${S.approvalDenied}${on}`, icon: <IconCross /> };
    case "expired":
      return { text: S.approvalExpired, icon: <IconClock /> };
    case "withdrawn":
      return { text: S.approvalWithdrawn, icon: <IconDash /> };
    case "pending":
      return { text: S.approvalPending, icon: <IconShield /> };
  }
}

export function ApprovalMessage({ item, ctx }: { item: ApprovalItem; ctx: MessageContext }) {
  if (item.state !== "pending") {
    const { text, icon } = outcome(item);
    return (
      <section className="cl-conv-approval" data-kind="approval" data-state={item.state}>
        <Card id={item.cardId} className="cl-conv-approval__resolved">
          <span className="cl-conv-approval__outcome">
            {icon}
            {text}
          </span>
          <Card.Field name="title" className="cl-conv-approval__resolved-title" />
        </Card>
      </section>
    );
  }
  const minutes = item.expiresAt === undefined ? undefined : minutesUntil(item.expiresAt, ctx.now);
  return (
    <section className="cl-conv-approval" data-kind="approval" data-state="pending" aria-label={S.approvalPending}>
      <Card id={item.cardId} className="cl-conv-approval__card">
        <div className="cl-conv-approval__head">
          <IconShield />
          <Card.Field name="title" className="cl-conv-approval__title" />
        </div>
        <Card.Field name="command" className="cl-conv-approval__command" />
        <div className="cl-conv-approval__facts">
          <Card.Field name="computer" className="cl-conv-approval__fact" />
          <Card.Field name="risk" className="cl-conv-approval__fact" />
        </div>
        <Card.Field name="reason" className="cl-conv-approval__reason" />
        <div className="cl-conv-approval__buttons">
          <Card.Deny className="cl-conv-approval__button" />
          <Card.Approve className="cl-conv-approval__button" />
        </div>
      </Card>
      {minutes !== undefined && (
        <div className="cl-conv-approval__deadline">
          <IconClock />
          {S.approvalExpiresIn(minutes)}
        </div>
      )}
    </section>
  );
}
