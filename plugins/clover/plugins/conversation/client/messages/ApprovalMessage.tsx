// An approval card. Its words are core data this plugin shows but cannot read (spec §5.5): the view
// places the core's sealed frames — every field a card may have and one button per option — and adds
// only its own words around them (the outcome). Nothing here may sit over a sealed frame or fade,
// filter or shrink it, or the core stops counting clicks on it; the stylesheet test holds that line.
// Each sealed part sits in an element of the view's own, which carries the layout; the parts get no
// classes. A field the card doesn't have draws nothing, and its holder collapses.
import type { ReactElement } from "react";
import type { MessageContext } from "../context";
import { IconCheck, IconClock, IconCross, IconDash, IconShield } from "../icons";
import { Card, type SealedField } from "../sdk";
import { S } from "../strings";
import type { ApprovalItem, ApprovalOption } from "../types";

function outcome(item: ApprovalItem): { text: string; icon: ReactElement } {
  const on = item.answeredOn ? ` ${S.answeredOn(item.answeredOn)}` : "";
  switch (item.state) {
    case "approved":
      return { text: `${S.approvalApproved}${on}`, icon: <IconCheck /> };
    case "denied":
      return { text: `${S.approvalDenied}${on}`, icon: <IconCross /> };
    case "expired":
      return { text: S.approvalExpired, icon: <IconClock /> };
    case "cancelled":
      return { text: S.approvalCancelled, icon: <IconDash /> };
    case "withdrawn":
      return { text: item.withdrawnBy === "interrupt" ? S.approvalWithdrawnInterrupt : S.approvalWithdrawn, icon: <IconDash /> };
    case "pending":
      return { text: S.approvalPending, icon: <IconShield /> };
  }
}

function Slot({ name, lines }: { name: SealedField; lines?: number }) {
  return (
    <div className="cl-conv-approval__field" data-slot={name}>
      <Card.Field name={name} lines={lines} />
    </div>
  );
}

/** One sealed button per option: the deny options first, then an "always" approve, then the plain
 *  approve, so the one-time OK sits last, where the eye ends. With no options known, the first of
 *  each kind. */
function Buttons({ options }: { options: readonly ApprovalOption[] | undefined }) {
  if (!options || options.length === 0) {
    return (
      <div className="cl-conv-approval__buttons">
        <span className="cl-conv-approval__button">
          <Card.Deny />
        </span>
        <span className="cl-conv-approval__button">
          <Card.Approve />
        </span>
      </div>
    );
  }
  const ordered = [
    ...options.filter((o) => o.kind === "deny"),
    ...options.filter((o) => o.kind === "approve" && o.remember === "always"),
    ...options.filter((o) => o.kind === "approve" && o.remember !== "always"),
  ];
  return (
    <div className="cl-conv-approval__buttons">
      {ordered.map((o) => (
        <span key={o.id} className="cl-conv-approval__button" data-kind={o.kind} data-always={o.remember === "always" || undefined}>
          {o.kind === "approve" ? <Card.Approve option={o.id} /> : <Card.Deny option={o.id} />}
        </span>
      ))}
    </div>
  );
}

export function ApprovalMessage({ item }: { item: ApprovalItem; ctx: MessageContext }) {
  if (item.state !== "pending") {
    const { text, icon } = outcome(item);
    return (
      <section className="cl-conv-approval" data-kind="approval" data-state={item.state}>
        <Card id={item.cardId}>
          <div className="cl-conv-approval__resolved">
            <span className="cl-conv-approval__outcome">
              {icon}
              {text}
            </span>
            <div className="cl-conv-approval__resolved-title">
              <Card.Field name="title" lines={1} />
            </div>
          </div>
        </Card>
      </section>
    );
  }
  return (
    <section
      className="cl-conv-approval"
      data-kind="approval"
      data-card={item.cardKind ?? "tool"}
      data-state="pending"
      aria-label={S.approvalPending}
    >
      <Card id={item.cardId}>
        <div className="cl-conv-approval__card">
          <div className="cl-conv-approval__head">
            <IconShield />
            <div className="cl-conv-approval__title">
              <Card.Field name="title" />
            </div>
          </div>
          <Slot name="source" />
          <Slot name="what" />
          <Slot name="host" />
          <Slot name="command" />
          <Slot name="paths" />
          <div className="cl-conv-approval__facts">
            <Slot name="computer" />
            <Slot name="risk" />
          </div>
          <Slot name="reason" />
          <Slot name="detail" />
          <Slot name="expires" />
          <Buttons options={item.options} />
        </div>
      </Card>
    </section>
  );
}
