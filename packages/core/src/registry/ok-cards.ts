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

/** `onApproved` runs on this computer when the user approves its OK card (on whichever of their clients answered it),
 *  after the registry has the answer: never for an OK record that arrives by sync. Lane J ticks the plugin's local MCP
 *  servers here with it (the controller's ruling: each computer keeps its own ticks; a synced copy isn't ticked). */
export function brokerOkCards(broker: ApprovalBroker, describe: (id: string) => OkText, onApproved?: (pluginId: string) => void, log?: (line: string) => void): OkCardRaiser {
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
          if (d.allowed) {
            try {
              onApproved?.(req.id);
            } catch (err) {
              // Another lane's hook: its failure never undoes the OK, and it's logged (#376's review).
              log?.(`plugins: after ${req.id}'s OK, its approve hook failed: ${(err as Error)?.message ?? String(err)}`);
            }
          }
          if (cardId === undefined && d.cardId !== undefined) resolve(d.cardId);
        });
      });
    },
  };
}
