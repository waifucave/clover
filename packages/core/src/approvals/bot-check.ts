// A bot's tool calls through the approval broker (C-M3; replaces INT's `refuseUntilApprovals`): the turn loop's
// `canUseTool(ctx, origin)` (`BotDriverDeps.canUseTool`). Each call becomes one `tool` request at the session's
// computer and level: the broker answers at once where the level, a saved rule or the reviewer allows, and otherwise
// raises a sealed card and the call waits for the person. Its texts come from the built-in table below, never from
// the model or a plugin (§5.5): the card shows what runs (the command, the paths), labelled by Clover.
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { SealedValue, TurnOrigin } from "@waifucave/clover-protocol";
import type { ActionEffect, ApprovalBroker, ApprovalRequest } from "../contracts/approval-broker";
import type { BotSessionContext } from "../bots/service";

/** The longest command or input a card holds before it says the rest is elsewhere; the protocol caps code at 64,000. */
const CODE_MAX = 60_000;

/** What each tool does, for the level table (§9.1). An MCP tool, or one this table doesn't know, is `other`. */
const EFFECTS: Record<string, ActionEffect> = {
  Read: "read", NotebookRead: "read", LS: "read", BashOutput: "read",
  Glob: "search", Grep: "search", WebSearch: "search",
  Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "execute", KillShell: "execute", KillBash: "execute",
  WebFetch: "fetch",
  TodoWrite: "think", ExitPlanMode: "think",
};

/** The card's title for each effect, from Clover's own table. */
const TITLES: Record<ActionEffect, string> = {
  read: "Read files", search: "Search", think: "Plan", fetch: "Fetch a web page", edit: "Change files", move: "Move files",
  delete: "Delete files", execute: "Run a command", screen: "Use the screen", purchase: "Make a purchase", other: "Use a tool",
};

export function effectOf(tool: string): ActionEffect {
  return EFFECTS[tool] ?? "other";
}

/** The paths a call names, as its input gives them. */
export function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string" && input[k] !== "") out.push(input[k] as string);
  return out;
}

/** The key an "always" saves: the exact command for Bash, the tool and path for an edit, else the tool. */
export function ruleKeyOf(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") return `Bash(${input.command})`;
  const paths = pathsOf(input);
  if (effectOf(tool) === "edit" && paths.length > 0) return `${tool}(${paths[0]})`;
  return tool;
}

const clip = (s: string) => (s.length > CODE_MAX ? `${s.slice(0, CODE_MAX)}\n… (${s.length - CODE_MAX} more characters not shown here)` : s);

/** The request for one call. */
export function botToolRequest(ctx: Pick<BotSessionContext, "botId" | "sessionId" | "computer" | "level">, origin: TurnOrigin, tool: string, input: Record<string, unknown>): ApprovalRequest {
  const effect = effectOf(tool);
  const paths = pathsOf(input);
  const fields: ApprovalRequest["fields"] = { title: { type: "text", text: TITLES[effect] }, what: { type: "text", text: tool } };
  if (tool === "Bash" && typeof input.command === "string") fields.command = { type: "code", code: clip(input.command), language: "sh" } satisfies SealedValue;
  else fields.detail = { type: "code", code: clip(JSON.stringify(input, null, 2)), language: "json" };
  if (paths.length > 0) fields.paths = { type: "list", items: paths.slice(0, 200) };
  fields.computer = { type: "text", text: ctx.computer };
  return {
    kind: "tool", session: ctx.sessionId, bot: ctx.botId, origin, computers: [ctx.computer],
    ...(ctx.level !== undefined ? { level: ctx.level } : {}),
    effect, ...(paths.length > 0 ? { paths } : {}), ruleKey: ruleKeyOf(tool, input), fields,
  };
}

/** The turn loop's approval check over `broker`. A turn whose origin isn't known is not the user's, so its card is
 *  denied after 10 minutes unanswered (rule 6). */
export function botApprovalCheck(broker: Pick<ApprovalBroker, "request">): (ctx: BotSessionContext, origin: () => TurnOrigin | undefined) => CanUseTool {
  return (ctx, origin) => async (tool, input, opts) => {
    const decision = await broker.request(botToolRequest(ctx, origin() ?? "bot", tool, input), { signal: opts.signal });
    if (decision.allowed) return { behavior: "allow", updatedInput: input };
    const why = decision.by === "level" ? "this computer's level doesn't allow it"
      : decision.by === "expired" ? "no one answered its card in time"
      : decision.by === "withdrawn" || decision.by === "cancelled" ? "the turn was stopped"
      : "the person declined it";
    return { behavior: "deny", message: `${tool} was refused: ${why}.` };
  };
}
