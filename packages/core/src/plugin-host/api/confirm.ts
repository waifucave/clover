// `confirm(text)` and `confirmCard(text)` (spec §5.4 "Asking the user"): a sealed card through C's approval broker
// that says it comes from a plugin, with the plugin's name, id and source and its text, and that returns only the
// user's answer. No plugin can read or answer it (the broker's sealed path), and it is denied after 10 minutes
// unanswered (the broker's rule 6 for `confirm`). The card's other strings are the core's; the plugin's own words go
// only in `what`, shown as the plugin's.
import type { SealedValue } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { ApprovalBroker } from "../../contracts/approval-broker";
import type { ApiCallContext, ApiHandlers } from "./router";

/** The longest text a plugin may put on its card. */
export const CONFIRM_TEXT_MAX = 2000;
/** Cards one plugin may have open at once, and how many it may raise per `CONFIRM_WINDOW_MS` (#332's review). */
export const CONFIRM_PENDING_MAX = 3;
export const CONFIRM_PER_WINDOW = 10;
export const CONFIRM_WINDOW_MS = 60_000;

/** The plugin's text as the card shows it: control characters (but newline and tab) and bidirectional controls are
 *  dropped, so its words can't reorder or hide parts of the card. */
export function cardText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
}

export function confirmApi(broker: Pick<ApprovalBroker, "request">, o: { now?: () => number } = {}): ApiHandlers {
  const now = o.now ?? (() => Date.now());
  const pending = new Map<string, number>();
  const recent = new Map<string, number[]>();
  const ask = async (ctx: ApiCallContext, raw: unknown): Promise<{ allowed: boolean; card: string }> => {
    if (typeof raw !== "string" || !raw.isWellFormed()) throw new ContractError("invalid", `confirm takes the question as text of 1 to ${CONFIRM_TEXT_MAX} characters`);
    const text = cardText(raw);
    if (text.trim() === "" || text.length > CONFIRM_TEXT_MAX) throw new ContractError("invalid", `confirm takes the question as text of 1 to ${CONFIRM_TEXT_MAX} characters`);
    const open = pending.get(ctx.pluginId) ?? 0;
    if (open >= CONFIRM_PENDING_MAX) throw new ContractError("refused", `${ctx.pluginId} already has ${CONFIRM_PENDING_MAX} questions waiting for the user`);
    const t = now();
    const times = (recent.get(ctx.pluginId) ?? []).filter((x) => t - x < CONFIRM_WINDOW_MS);
    if (times.length >= CONFIRM_PER_WINDOW) throw new ContractError("refused", `${ctx.pluginId} asked the user ${CONFIRM_PER_WINDOW} times in the last minute; try again later`);
    times.push(t);
    recent.set(ctx.pluginId, times);
    const name = typeof ctx.record.name === "string" ? cardText(ctx.record.name) : ctx.pluginId;
    const source: SealedValue = {
      type: "rows",
      rows: [
        { label: "Plugin", value: name.slice(0, 4000) },
        { label: "Id", value: ctx.pluginId },
        { label: "Source", value: ctx.record.source },
      ],
    };
    const session = ctx.caller.kind === "session" ? ctx.caller.sessionId : undefined;
    pending.set(ctx.pluginId, open + 1);
    try {
      const decision = await broker.request({
        kind: "confirm",
        origin: "plugin",
        computers: [],
        effect: "other",
        pluginId: ctx.pluginId,
        ...(session === undefined ? {} : { session }),
        fields: { title: { type: "text", text: "A plugin asks" }, what: { type: "text", text }, source },
      });
      return { allowed: decision.allowed, card: decision.cardId ?? "" };
    } finally {
      const left = (pending.get(ctx.pluginId) ?? 1) - 1;
      if (left <= 0) pending.delete(ctx.pluginId);
      else pending.set(ctx.pluginId, left);
    }
  };
  return {
    confirm: async (ctx, args) => (await ask(ctx, args[0])).allowed,
    confirmCard: (ctx, args) => ask(ctx, args[0]),
  };
}
