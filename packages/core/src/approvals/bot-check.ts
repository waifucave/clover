// A bot's tool calls through the approval broker (C-M3; replaces INT's `refuseUntilApprovals`): the turn loop's
// `canUseTool(ctx, origin)` (`BotDriverDeps.canUseTool`). Each call becomes one `tool` request at the session's
// computer and level: the broker answers at once where the level, a saved rule or the reviewer allows, and otherwise
// raises a sealed card and the call waits for the person.
//
// What the card says (§5.5, #267's review item 5): its `text` fields hold only Clover's own table strings (a title, a
// built-in tool's name); everything a model or a plugin chose (a non-built-in tool's name, the command, the input,
// the paths, the device's name) goes in `code` fields, with the characters that hide or reorder text taken out
// (`strings.ts`).
//
// Paths (#267's review items 1 and 2): each path the call names is resolved against the session's working folder
// (its scratch folder, where the turn loop starts the runtime), with `~` expanded and links followed (`realpath`, or
// the nearest folder that exists for a file not made yet), before the request is built, so the fence's rule 3 judges
// the real place, and an edit rule is keyed on that real path: an "always" for `Write(notes.md)` in one folder never
// allows another. Resolving happens on the computer the session runs on: a session on another computer
// (`localComputer` names this one) has its paths sent as given and marked unresolved, and the broker then asks every
// time and never matches or saves a rule for them (the controller's ruling on #267).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { Level, SealedValue, TurnOrigin } from "@waifucave/clover-protocol";
import type { ActionEffect, ApprovalBroker } from "../contracts/approval-broker";
import { WRITE_EFFECTS } from "../contracts/approval-broker";
import { fenceContextFor, type Fence } from "../contracts/fence";
import type { CloverApprovalRequest } from "./broker";
import type { BotSessionContext } from "../bots/service";
import { looksCredentialBearing, plainOf, shownCode } from "./strings";

/** The longest command or input a card holds before it says the rest is elsewhere; the protocol caps code at 64,000. */
const CODE_MAX = 60_000;
/** The most paths one card lists. */
const PATHS_MAX = 200;

/** What each built-in tool of the agent SDK does, for the level table (§9.1). Keyed by the built-in's identity: a
 *  call is a built-in's only when its name is one of these and the session's host serves no tool of that name itself
 *  (`hostTools`); an MCP tool (`mcp__…`), a plugin's or a host's tool is `other`, whatever it calls itself. */
const BUILTIN_EFFECTS: ReadonlyMap<string, ActionEffect> = new Map<string, ActionEffect>([
  ["Read", "read"], ["NotebookRead", "read"], ["LS", "read"], ["BashOutput", "read"], ["TaskOutput", "read"], ["TaskGet", "read"],
  ["TaskList", "read"], ["ListMcpResourcesTool", "read"], ["ReadMcpResourceTool", "read"],
  ["Glob", "search"], ["Grep", "search"], ["WebSearch", "search"],
  ["Write", "edit"], ["Edit", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"],
  ["Bash", "execute"], ["PowerShell", "execute"], ["Monitor", "execute"], ["KillShell", "execute"], ["KillBash", "execute"],
  ["WebFetch", "fetch"],
  ["TodoWrite", "think"], ["ExitPlanMode", "think"], ["AskUserQuestion", "think"], ["TaskCreate", "think"], ["TaskUpdate", "think"],
]);

/** The built-ins whose command is the call (`command`), keyed on the exact command in a rule. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell", "Monitor"]);

/** The card's title for each effect, from Clover's own table. */
const TITLES: Record<ActionEffect, string> = {
  read: "Read files", search: "Search", think: "Plan", fetch: "Fetch a web page", edit: "Change files", move: "Move files",
  delete: "Delete files", execute: "Run a command", screen: "Use the screen", purchase: "Make a purchase", other: "Use a tool",
};

/** Whether `tool` is the agent SDK's built-in of that name in a session whose host serves `hostTools` itself. */
export function isBuiltinTool(tool: string, hostTools: ReadonlySet<string> = new Set()): boolean {
  return BUILTIN_EFFECTS.has(tool) && !hostTools.has(tool);
}

export function effectOf(tool: string, hostTools?: ReadonlySet<string>): ActionEffect {
  return isBuiltinTool(tool, hostTools) ? BUILTIN_EFFECTS.get(tool)! : "other";
}

/** The paths a call names, as its input gives them. */
export function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof input[k] === "string" && input[k] !== "") out.push(input[k] as string);
  return out;
}

/** `path` as the session meets it: `~` expanded, made absolute against `cwd`, and with every link followed; for a
 *  name that doesn't exist yet, its nearest existing folder's real path with the rest joined on. */
export function resolveSessionPath(path: string, cwd: string, home: string = homedir()): string {
  const expanded = path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? join(home, path.slice(2)) : path;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      const real = realpathSync.native(at);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return abs;
      rest.push(basename(at));
      at = up;
    }
  }
}

/** Each rule key starts with its kind (#267's check 2): a built-in's never shares a key with another tool's, even one
 *  literally named `Bash(git push)`. */
export const BUILTIN_KEY = "builtin:";
export const OTHER_TOOL_KEY = "tool:";

/** The key an "always" saves, or none where no "always" is offered.
 *  * A command tool: the exact command, with no folder in it. That is the contract's design: a command rule allows
 *    that command wherever the session runs it, as the person read it on the card. A command that looks like it
 *    carries a credential gets no key, so no "always" (#267's ruling 4).
 *  * An edit: the tool and the real path (`resolveSessionPath`), so the rule holds for that one file.
 *  * Another built-in: its name.
 *  * Any other tool: its name as the host, the SDK or a plugin gives it, under `tool:`. */
export function ruleKeyOf(tool: string, input: Record<string, unknown>, realPaths: readonly string[], hostTools?: ReadonlySet<string>): string | undefined {
  const builtin = isBuiltinTool(tool, hostTools);
  if (!builtin) return `${OTHER_TOOL_KEY}${tool}`;
  if (COMMAND_TOOLS.has(tool)) {
    if (typeof input.command !== "string" || looksCredentialBearing(input.command)) return undefined;
    return `${BUILTIN_KEY}${tool}(${input.command})`;
  }
  if (BUILTIN_EFFECTS.get(tool) === "edit") return realPaths.length > 0 ? `${BUILTIN_KEY}${tool}(${realPaths[0]})` : undefined;
  return `${BUILTIN_KEY}${tool}`;
}

const clip = (s: string) => (s.length > CODE_MAX ? `${s.slice(0, CODE_MAX)}\n… (${s.length - CODE_MAX} more characters not shown here)` : s);

export interface BotToolRequestOptions {
  /** The tools the session's host serves itself (its core tools): a built-in's name among them is not the built-in. */
  hostTools?: ReadonlySet<string>;
  /** The home `~` stands for; the daemon's own by default. */
  home?: string;
  /** This computer's name: a session on another computer has its paths left unresolved. Unset: every session is
   *  taken as this computer's. */
  localComputer?: string;
}

/** The request for one call, its paths resolved against the session's working folder (`ctx.paths.scratch`). */
export function botToolRequest(
  ctx: Pick<BotSessionContext, "botId" | "sessionId" | "computer" | "level" | "paths">, origin: TurnOrigin, tool: string,
  input: Record<string, unknown>, opts: BotToolRequestOptions = {},
): CloverApprovalRequest {
  const builtin = isBuiltinTool(tool, opts.hostTools);
  const effect = effectOf(tool, opts.hostTools);
  const here = opts.localComputer === undefined || opts.localComputer === ctx.computer;
  const given = pathsOf(input);
  const paths = here ? given.map((p) => resolveSessionPath(p, ctx.paths.scratch, opts.home)) : given;
  const unresolved = !here && paths.length > 0;
  const fields: CloverApprovalRequest["fields"] = {
    title: { type: "text", text: TITLES[effect] },
    what: builtin ? { type: "text", text: tool } : { type: "code", code: plainOf(tool) },
  };
  if (builtin && COMMAND_TOOLS.has(tool) && typeof input.command === "string") {
    fields.command = { type: "code", code: clip(shownCode(input.command)), language: tool === "PowerShell" ? "powershell" : "sh" } satisfies SealedValue;
  } else {
    fields.detail = { type: "code", code: clip(shownCode(JSON.stringify(input, null, 2) ?? "")), language: "json" };
  }
  if (paths.length > 0) fields.paths = { type: "code", code: paths.slice(0, PATHS_MAX).map(plainOf).join("\n") };
  fields.computer = { type: "code", code: plainOf(ctx.computer) };
  const ruleKey = unresolved && builtin && BUILTIN_EFFECTS.get(tool) === "edit" ? undefined : ruleKeyOf(tool, input, paths, opts.hostTools);
  return {
    kind: "tool", session: ctx.sessionId, bot: ctx.botId, origin, computers: [ctx.computer],
    ...(ctx.level !== undefined ? { level: ctx.level } : {}),
    effect, ...(paths.length > 0 ? { paths } : {}), ...(unresolved ? { pathsUnresolved: true } : {}),
    ...(ruleKey === undefined ? {} : { ruleKey }), fields,
  };
}

/** The turn loop's approval check over `broker`. A turn whose origin isn't known is not the user's, so its card is
 *  denied after 10 minutes unanswered (rule 6). `hostTools(ctx)` names the tools the session's host serves itself. */
export function botApprovalCheck(
  broker: Pick<ApprovalBroker, "request">,
  opts: {
    hostTools?: (ctx: BotSessionContext) => Iterable<string>; home?: string; localComputer?: string;
    /** This computer's fence and its Clover home: a path the fence refuses the bot (secrets, run/, writes to the
     *  permission, trust, settings and plugin files) is refused with no card, and a read or write inside the home the
     *  fence lets the bot make (the owner's ruling: reads anywhere in the home, writes to any bot's scratch, as lane C's
     *  `homeAllows` says) runs with no card either. */
    fence?: Pick<Fence, "check">; cloverHome?: string;
    /** Each computer's level now, for the writes the fence lets through inside the home: read-only stays absolute
     *  (#353's blocker), so they run with no card only at a level above it. Without it, those writes go to the broker. */
    levelOf?: (computer: string) => Level | undefined;
    /** A bot's commands always ask on a card (no level, rule or reviewer answers them) while its Bash sandbox isn't
     *  drawn from this computer's fence (#353's S3; lane C's `sandboxSettingsOf`, #356, wires it). */
    commandsAlwaysCard?: boolean;
  } = {},
): (ctx: BotSessionContext, origin: () => TurnOrigin | undefined) => CanUseTool {
  return (ctx, origin) => async (tool, input, call) => {
    const hostTools = new Set(opts.hostTools?.(ctx) ?? []);
    const req = botToolRequest(ctx, origin() ?? "bot", tool, input, {
      hostTools, ...(opts.home === undefined ? {} : { home: opts.home }), ...(opts.localComputer === undefined ? {} : { localComputer: opts.localComputer }),
    });
    // This computer's fence first (INT, the broker swap; #347's review and the owner's ruling): a path it refuses the
    // bot is refused outright and never becomes a card; a file read or write it allows inside the Clover home runs
    // outright. Only a path outside the home can still ask.
    if (opts.fence && req.paths?.length && !req.pathsUnresolved) {
      const ctxFence = fenceContextFor(ctx.caller);
      const writes = WRITE_EFFECTS.includes(req.effect);
      for (const path of req.paths) {
        const v = opts.fence.check({ op: writes ? "write" : "read", path }, ctxFence);
        if (!v.allowed) return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: that place is fenced on this computer (Clover's own folder, or a file no bot ${writes ? "writes" : "reads"}).` };
      }
      const home = opts.cloverHome === undefined ? undefined : realFolder(opts.cloverHome);
      const inHome = home !== undefined && req.paths.every((p) => insideFolder(p, home));
      if (inHome && (req.effect === "read" || req.effect === "search")) return { behavior: "allow", updatedInput: input };
      if (inHome && writes && opts.levelOf) {
        // Read-only stays absolute, the bot's own folders included: a routine's level, or its computer's now.
        const readOnly = ctx.level === "read-only" || (opts.levelOf(ctx.computer) ?? "read-only") === "read-only";
        if (readOnly) return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: this computer's level doesn't allow it.` };
        return { behavior: "allow", updatedInput: input };
      }
    }
    if (opts.commandsAlwaysCard && isBuiltinTool(tool, hostTools) && COMMAND_TOOLS.has(tool)) req.cardAlways = true;
    const decision = await broker.request(req, { signal: call.signal });
    if (decision.allowed) return { behavior: "allow", updatedInput: input };
    const why = decision.by === "level" ? "this computer's level doesn't allow it"
      : decision.by === "expired" ? "no one answered its card in time"
      : decision.by === "withdrawn" || decision.by === "cancelled" ? "the turn was stopped"
      : decision.by === "fence" ? "a file written there runs or applies later outside any sandbox (shell start files, login items, coding agents' settings), so no bot writes there"
      : "the person declined it";
    return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: ${why}.` };
  };
}

/** Whether `path` is `folder` or inside it (both absolute, as `botToolRequest` resolves them). */
function insideFolder(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A folder's real path (as `resolveSessionPath` gives the paths it is compared with), or the path as given. */
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}
