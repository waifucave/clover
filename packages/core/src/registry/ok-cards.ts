// The OK as a card through the approval broker (spec §5.1, §5.6; C's ApprovalBroker): a `plugin-ok` card with the OK's
// text from the built-in tables, a checkbox per child, and approve or deny. It never expires (rule 6): only the user's
// deny refuses the plugin. The card's id comes from the broker's `requested` event, which names the plugin.
import type { SealedValue } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { OkCardRaiser } from "./core";
import { ContractError } from "../contracts/common";

export interface OkText {
  /** The plugin's name. */
  title: string;
  /** The OK's lines (`describeOk`): what it is, what it adds, what it reaches. */
  lines: readonly string[];
  /** Who wrote it, from the core's record (§5.6). */
  source: string;
}

/** The broker the OK cards ask on: its `request` (with `onCard`, which names this request's card) and `get`. The daemon
 *  passes one bound late (`lateApprovalBroker`): its broker starts with the computer node, after the registry. */
export type OkCardBroker = Pick<ApprovalBroker, "request" | "get">;

export function brokerOkCards(broker: OkCardBroker, describe: (id: string) => OkText): OkCardRaiser {
  return {
    raise(req, answered) {
      const text = describe(req.id);
      const fields: Partial<Record<"title" | "what" | "source", SealedValue>> = {
        title: { type: "text", text: text.title },
        what: { type: "list", items: [...text.lines] },
        source: { type: "text", text: text.source },
      };
      return new Promise<string>((resolve, reject) => {
        let cardId: string | undefined;
        // This request's own card, by `onCard` (never matched by kind or plugin: two at once would share them).
        const shown = (id: string) => {
          if (cardId !== undefined) return;
          cardId = id;
          resolve(id);
        };
        broker.request({
          kind: "plugin-ok", origin: "user", computers: [], effect: "other", pluginId: req.id, fields,
          ...(req.children.length > 0 ? { children: req.children } : {}),
        }, { onCard: shown }).then((d) => {
          if (d.by !== "card") {
            // Withdrawn or cancelled: the plugin stays found. A request that never showed a card says so, rather
            // than leaving its caller waiting.
            if (cardId === undefined) reject(new ContractError("refused", `${req.id}'s OK card wasn't shown`));
            return;
          }
          if (cardId === undefined && d.cardId !== undefined) shown(d.cardId);
          const children = d.cardId === undefined ? undefined : broker.get(d.cardId)?.children;
          answered({ approved: d.allowed, ...(children === undefined ? {} : { children }) });
        }, (err: unknown) => {
          // No broker here (its cards aren't up): the caller hears why.
          if (cardId === undefined) reject(err);
        });
      });
    },
  };
}
