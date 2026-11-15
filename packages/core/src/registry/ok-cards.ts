// The OK as a card through the approval broker (spec §5.1, §5.6; C's ApprovalBroker): a `plugin-ok` card with the OK's
// text from the built-in tables, a checkbox per child, and approve or deny. It never expires (rule 6): only the user's
// deny refuses the plugin. The card's id comes from the broker's `requested` event, which names the plugin.
import type { SealedValue } from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { OkCardRaiser } from "./core";
import { ContractError } from "../contracts/common";

/** The longest line a card's list holds (the protocol's sealed list item) and the most lines. */
export const CARD_LINE_MAX = 4000;
export const CARD_LINES_MAX = 200;

/** The OK's lines as a card holds them: a line over `CARD_LINE_MAX` is split, never cut, each part saying which it is
 *  ("(2 of 3)"), so a long command shows whole. More lines than a card holds is refused, with why: never a card that
 *  fails to show, or one that hides the end. */
export function cardLines(lines: readonly string[], max = CARD_LINE_MAX, most = CARD_LINES_MAX): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= max) {
      out.push(line);
      continue;
    }
    // Room for the markers ("(12 of 12) " and " (continued below)").
    const room = max - 40;
    const parts: string[] = [];
    let rest = line;
    while (rest.length > room) {
      let cut = rest.lastIndexOf(" ", room);
      if (cut < room / 2) cut = room;
      // Never half a surrogate pair.
      if (/[\ud800-\udbff]/.test(rest[cut - 1] ?? "")) cut--;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    const n = parts.length;
    parts.forEach((part, i) => out.push(`${i > 0 ? `(${i + 1} of ${n}) ` : ""}${part}${i < n - 1 ? ` (${i === 0 ? `1 of ${n}, ` : ""}continued below)` : ""}`));
  }
  if (out.length > most) throw new ContractError("invalid", `its OK card would need ${out.length} lines, more than a card shows (${most}); nothing was installed`);
  return out;
}

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

/** `onApproved` runs on this computer when the user approves its OK card (on whichever of their clients answered it),
 *  after the registry has the answer: never for an OK record that arrives by sync. Lane J ticks the plugin's local MCP
 *  servers here with it (the controller's ruling: each computer keeps its own ticks; a synced copy isn't ticked). */
export function brokerOkCards(broker: OkCardBroker, describe: (id: string) => OkText, onApproved?: (pluginId: string) => void, log?: (line: string) => void): OkCardRaiser {
  return {
    raise(req, answered, opts) {
      const text = describe(req.id);
      let items: string[];
      try {
        items = cardLines(text.lines);
      } catch (err) {
        return Promise.reject(err);
      }
      const fields: Partial<Record<"title" | "what" | "source", SealedValue>> = {
        title: { type: "text", text: text.title },
        what: { type: "list", items },
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
        }, { onCard: shown, ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) }).then((d) => {
          if (d.by !== "card") {
            // Withdrawn or cancelled: the plugin stays found. A request that never showed a card says so, rather
            // than leaving its caller waiting.
            if (cardId === undefined) reject(new ContractError("refused", `${req.id}'s OK card wasn't shown`));
            return;
          }
          if (cardId === undefined && d.cardId !== undefined) shown(d.cardId);
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
        }, (err: unknown) => {
          // No broker here (its cards aren't up): the caller hears why.
          if (cardId === undefined) reject(err);
        });
      });
    },
  };
}
