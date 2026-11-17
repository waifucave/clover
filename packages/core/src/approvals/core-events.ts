// The broker's cards as `core.event`s (C-M3 item 2; protocol approvals.ts): `card_requested` with the sealed card for
// the app and remote clients, `card_pending` (the card without its text) for plugins with `approvals`, and
// `card_resolved` for all three. The sender (`MossServer.coreEvent`) then routes each by role, area and capability.
import type { ApprovalBroker } from "../contracts/approval-broker";
import { cardMetaOf } from "../contracts/approval-broker";
import type { Unsubscribe } from "../contracts/common";
import { topPluginIdOf } from "@waifucave/moss-protocol";
import type { CoreEventInput, CoreEventOptions } from "../ipc/core-events";

/** Who hears a card (the owner's ruling for plain `approvals`, 2026-11-17): a plugin holding `approvals.all` (what the island,
 *  the pill and the window's own parts hold: every card), and with `approvals` alone, a plugin the card's `ownedBy` names, by
 *  top-level id: the plugin whose tool's call raised it, in any session or bot's turn, and the plugin its bot was moved from.
 *  A card the core's own tools raised, a session's card of no plugin's tool, a plugin's OK or a change from Settings reaches
 *  `approvals.all` alone. No plugin's id decides it: `capabilities` is what the plugin was granted and may use now. */
export const cardAudience = (card: { ownedBy?: readonly string[] }) => (pluginId: string, capabilities: readonly string[]): boolean =>
  capabilities.includes("approvals") && (capabilities.includes("approvals.all") || (card.ownedBy ?? []).includes(topPluginIdOf(pluginId)));

/** Forwards `broker`'s events to `send` (the server's `coreEvent`), stamped with the shared clock's `now`. */
export function approvalCoreEvents(broker: Pick<ApprovalBroker, "watch">, send: (event: CoreEventInput, opts?: CoreEventOptions) => unknown, now: () => number): Unsubscribe {
  // A resolved card is told to the plugins that heard it raised, and to no others.
  const owners = new Map<string, { ownedBy?: readonly string[] }>();
  return broker.watch((e) => {
    const ts = now();
    if (e.type === "requested") {
      owners.set(e.card.id, { ...(e.card.ownedBy === undefined ? {} : { ownedBy: e.card.ownedBy }) });
      send({ type: "card_requested", ts, card: e.card });
      send({ type: "card_pending", ts, card: cardMetaOf(e.card) }, { forPlugin: cardAudience(e.card) });
      return;
    }
    const owner = owners.get(e.cardId) ?? {};
    owners.delete(e.cardId);
    send({
      type: "card_resolved", ts, id: e.cardId, outcome: e.outcome,
      ...(e.optionId === undefined ? {} : { option: e.optionId }), ...(e.device === undefined ? {} : { device: e.device }),
    }, { forPlugin: cardAudience(owner) });
  });
}
