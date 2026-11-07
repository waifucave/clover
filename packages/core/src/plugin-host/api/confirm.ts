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

async function ask(broker: Pick<ApprovalBroker, "request">, ctx: ApiCallContext, text: unknown): Promise<{ allowed: boolean; card: string }> {
  if (typeof text !== "string" || text.trim() === "" || text.length > CONFIRM_TEXT_MAX || !text.isWellFormed()) {
    throw new ContractError("invalid", `confirm takes the question as text of 1 to ${CONFIRM_TEXT_MAX} characters`);
  }
  const name = typeof ctx.record.name === "string" ? ctx.record.name : ctx.pluginId;
  const source: SealedValue = {
    type: "rows",
    rows: [
      { label: "Plugin", value: name.slice(0, 4000) },
      { label: "Id", value: ctx.pluginId },
      { label: "Source", value: ctx.record.source },
    ],
  };
  const session = ctx.caller.kind === "session" ? ctx.caller.sessionId : undefined;
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
}

export function confirmApi(broker: Pick<ApprovalBroker, "request">): ApiHandlers {
  return {
    confirm: async (ctx, args) => (await ask(broker, ctx, args[0])).allowed,
    confirmCard: (ctx, args) => ask(broker, ctx, args[0]),
  };
}
