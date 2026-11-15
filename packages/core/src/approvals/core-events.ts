// The broker's cards as `core.event`s (C-M3 item 2; protocol approvals.ts): `card_requested` with the sealed card for
// the app and remote clients, `card_pending` (the card without its text) for plugins with `approvals`, and
// `card_resolved` for all three. The sender (`CloverServer.coreEvent`) then routes each by role, area and capability.
import type { ApprovalBroker } from "../contracts/approval-broker";
import { cardMetaOf } from "../contracts/approval-broker";
import type { Unsubscribe } from "../contracts/common";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import type { CoreEventInput, CoreEventOptions } from "../ipc/core-events";

/** Who hears a card: the bundled `clover` tree (the app's own surfaces, the island and the pill), and the plugin whose bot
 *  the card is for, by top-level id on both sides (a plugin's bot is `<plugin>` or `<plugin>/<name>`). A card with no bot
 *  (a plugin's OK, a change from Settings) reaches `clover` alone. */
export const cardAudience = (bot: string | undefined) => (pluginId: string): boolean => {
  const top = topPluginIdOf(pluginId);
  return top === "clover" || (bot !== undefined && top === topPluginIdOf(bot));
};

/** Forwards `broker`'s events to `send` (the server's `coreEvent`), stamped with the shared clock's `now`. */
export function approvalCoreEvents(broker: Pick<ApprovalBroker, "watch">, send: (event: CoreEventInput, opts?: CoreEventOptions) => unknown, now: () => number): Unsubscribe {
  // A resolved card is told to the plugins that heard it raised, and to no others.
  const bots = new Map<string, string | undefined>();
  return broker.watch((e) => {
    const ts = now();
    if (e.type === "requested") {
      bots.set(e.card.id, e.card.bot);
      send({ type: "card_requested", ts, card: e.card });
      send({ type: "card_pending", ts, card: cardMetaOf(e.card) }, { forPlugin: cardAudience(e.card.bot) });
      return;
    }
    const bot = bots.get(e.cardId);
    bots.delete(e.cardId);
    send({
      type: "card_resolved", ts, id: e.cardId, outcome: e.outcome,
      ...(e.optionId === undefined ? {} : { option: e.optionId }), ...(e.device === undefined ? {} : { device: e.device }),
    }, { forPlugin: cardAudience(bot) });
  });
}
