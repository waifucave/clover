// The OK as a card through the approval broker (spec §5.1, §5.6; C's ApprovalBroker): a `plugin-ok` card with the OK's
// text from the built-in tables, a checkbox per child, and approve or deny. It never expires (rule 6): only the user's
// deny refuses the plugin. The card's id comes from the broker's `requested` event, which names the plugin.
import type { SealedValue } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { OkCardRaiser } from "./core";

export interface OkText {
  /** The plugin's name. */
  title: string;
  /** The OK's lines (`describeOk`): what it is, what it adds, what it reaches. */
  lines: readonly string[];
  /** Who wrote it, from the core's record (§5.6). */
  source: string;
}

export function brokerOkCards(broker: ApprovalBroker, describe: (id: string) => OkText): OkCardRaiser {
  return {
    raise(req, answered) {
      const text = describe(req.id);
      const fields: Partial<Record<"title" | "what" | "source", SealedValue>> = {
        title: { type: "text", text: text.title },
        what: { type: "list", items: [...text.lines] },
        source: { type: "text", text: text.source },
      };
      return new Promise<string>((resolve) => {
        let cardId: string | undefined;
        const stop = broker.watch((e) => {
          if (e.type === "requested" && e.card.kind === "plugin-ok" && e.card.pluginId === req.id && cardId === undefined) {
            cardId = e.card.id;
            resolve(cardId);
          }
        });
        void broker.request({
          kind: "plugin-ok", origin: "user", computers: [], effect: "other", pluginId: req.id, fields,
          ...(req.children.length > 0 ? { children: req.children } : {}),
        }).then((d) => {
          stop();
          if (d.by !== "card") return; // withdrawn or cancelled: the plugin stays found
          const children = d.cardId === undefined ? undefined : broker.get(d.cardId)?.children;
          answered({ approved: d.allowed, ...(children === undefined ? {} : { children }) });
          if (cardId === undefined && d.cardId !== undefined) resolve(d.cardId);
        });
      });
    },
  };
}
