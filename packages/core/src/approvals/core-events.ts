// The broker's cards as `core.event`s (C-M3 item 2; protocol approvals.ts): `card_requested` with the sealed card for
// the app and remote clients, `card_pending` (the card without its text) for plugins with `approvals`, and
// `card_resolved` for all three. The sender (`CloverServer.coreEvent`) then routes each by role, area and capability.
import type { ApprovalBroker } from "../contracts/approval-broker";
import { cardMetaOf } from "../contracts/approval-broker";
import type { Unsubscribe } from "../contracts/common";
import type { CoreEventInput } from "../ipc/core-events";

/** Forwards `broker`'s events to `send` (the server's `coreEvent`), stamped with the shared clock's `now`. */
export function approvalCoreEvents(broker: Pick<ApprovalBroker, "watch">, send: (event: CoreEventInput) => unknown, now: () => number): Unsubscribe {
  return broker.watch((e) => {
    const ts = now();
    if (e.type === "requested") {
      send({ type: "card_requested", ts, card: e.card });
      send({ type: "card_pending", ts, card: cardMetaOf(e.card) });
      return;
    }
    send({
      type: "card_resolved", ts, id: e.cardId, outcome: e.outcome,
      ...(e.optionId === undefined ? {} : { option: e.optionId }), ...(e.device === undefined ? {} : { device: e.device }),
    });
  });
}
