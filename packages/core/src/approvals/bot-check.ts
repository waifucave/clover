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
import { LEVELS, canonicalJson, type Level, type Os, type SealedValue, type TurnOrigin } from "@waifucave/clover-protocol";
import type { ActionEffect, ApprovalBroker } from "../contracts/approval-broker";
import { WRITE_EFFECTS } from "../contracts/approval-broker";
import { fenceContextFor, type Fence } from "../contracts/fence";
import type { CloverApprovalRequest } from "./broker";
import type { BotSessionContext } from "../bots/service";
import { FETCHES_PER_DOMAIN, FETCHES_PER_TURN, normalUrl, type FetchBudget } from "./seen-urls";
import { looksCredentialBearing, plainOf, shownCode } from "./strings";
import { secretPlaceOf, secretReadRefusal } from "../fence/secret-reads";

const hostOsOf = (): Os => (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");

/** The longest command or input a card holds before it says the rest is elsewhere; the protocol caps code at 64,000. */
export const CODE_MAX = 60_000;
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

/** The agent SDK's built-in tools' names (the Glossary reserves them, so no plugin's skill or agent stands in for one). */
export const BUILTIN_TOOL_NAMES: readonly string[] = [...BUILTIN_EFFECTS.keys()];

/** The built-ins whose command is the call (`command`), keyed on the exact command in a rule. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell", "Monitor"]);

/** The card's title for each effect, from Clover's own table. */
const TITLES: Record<ActionEffect, string> = {
  read: "Read files", search: "Search", think: "Plan", fetch: "Fetch a web page", edit: "Change files", move: "Move files",
  delete: "Delete files", execute: "Run a command", screen: "Use the screen", purchase: "Make a purchase", other: "Use a tool",
};

/** The core's own tools a bot's host serves, beside the built-ins (§6.7), by what each does: listing is a read;
 *  stopping a task the bot started (`AgentManager.stop` refuses any session another bot or the user started) and
 *  starting an agent stay inside Clover (an agent Clover hasn't admitted still asks with its own card,
 *  `AgentManager`), so at ask for risky actions they run without asking (the owner's ruling). A message runs without
 *  asking only to the bot's own sessions or to a session at a level no wider than the bot's (`messageTarget`; the
 *  controller's ruling on the confused deputy); to any other, a card that names it. Any other core tool is judged as
 *  a tool. */
export const CORE_TOOL_RULES: ReadonlyMap<string, "read" | "contained"> = new Map([
  ["ListAgents", "read"], ["SendMessage", "contained"], ["TaskStop", "contained"], ["Agent", "contained"],
  // Asking itself costs nothing: the tool raises its own card for what it asks (`request-access.ts`).
  ["RequestAccess", "read"],
]);

/** What a bundled, checked plugin's tool is (the daemon's word, `botApprovalCheck`'s `bundledTool`): the web plugin's
 *  search and fetch. */
export type BundledToolKind = "web-search" | "web-fetch";

/** The bundled web plugin (`plugins/clover/plugins/web`): its `WebSearch` and `WebFetch`. */
export const WEB_PLUGIN_ID = "clover/web";

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

/** What a saved rule's key stands for, as `ruleKeyOf` made it: the kind of thing it allows and the thing itself (the exact
 *  command, the one real file, the tool). The inverse of `ruleKeyOf`, kept beside it so the two change together. */
export type RuleKind = "command" | "file" | "tool" | "plugin-tool" | "other";
export function ruleShapeOf(ruleKey: string): { kind: RuleKind; target: string } {
  if (ruleKey.startsWith(BUILTIN_KEY)) {
    const rest = ruleKey.slice(BUILTIN_KEY.length);
    const m = /^([^(]+)\(([\s\S]*)\)$/.exec(rest);
    if (m === null) return { kind: "tool", target: rest };
    return { kind: COMMAND_TOOLS.has(m[1]!) ? "command" : "file", target: m[2]! };
  }
  if (ruleKey.startsWith(OTHER_TOOL_KEY)) return { kind: "plugin-tool", target: ruleKey.slice(OTHER_TOOL_KEY.length) };
  return { kind: "other", target: ruleKey };
}

/** The shell tools whose input may ask to run outside the sandbox (`dangerouslyDisableSandbox`): the runtime's own
 *  escape classification names `Bash`, and `PowerShell` takes the same flag through the same generic executor, so a
 *  flagged call of either is judged the same way. Anything else (an MCP tool, a plugin's tool) has no such flag. */
export const OUTSIDE_SANDBOX_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

/** How a shell call's run-outside-the-sandbox flag reads: `off` (absent or `false`), `escape` (exactly `true`, the
 *  only value the runtime treats as an override: `resolveExecutionPath` tests `input.dangerouslyDisableSandbox ===
 *  true`), or `odd` (anything else present: `"true"`, `1`, `"yes"`, `null`, …). An odd value is never passed through
 *  unflagged: the runtime's Bash validator refuses a non-boolean flag, so it is refused here too, with no card. */
export type OutsideSandboxFlag = "off" | "escape" | "odd";

/** How `tool`'s `input` reads for the outside-the-sandbox flag. The caller checks the tool is the built-in (a plugin's
 *  tool of the same name has no such flag); anything but a shell tool is `off`. */
export function outsideSandboxFlagOf(tool: string, input: unknown): OutsideSandboxFlag {
  if (!OUTSIDE_SANDBOX_TOOLS.has(tool) || typeof input !== "object" || input === null || Array.isArray(input)) return "off";
  const v = (input as Record<string, unknown>).dangerouslyDisableSandbox;
  if (v === undefined || v === false) return "off";
  return v === true ? "escape" : "odd";
}

/** Whether `input` carries the outside-sandbox flag on a tool that takes none: any tool but the shell tools, with the
 *  field present at any value but `undefined` (an `undefined` reads as absent, as `outsideSandboxFlagOf` says). A
 *  tool from a plugin or an MCP server (a name starting with `mcp__`) is left alone: the field means nothing there. */
export function misplacedSandboxFlag(tool: string, input: unknown): boolean {
  if (tool === "Bash" || tool === "PowerShell") return false;
  if (tool.startsWith("mcp__")) return false;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  return (input as Record<string, unknown>).dangerouslyDisableSandbox !== undefined;
}

/** What a bot carrying the flag on such a tool is told. */
export const MISPLACED_SANDBOX_FLAG_REFUSAL = "this tool can't run outside the sandbox; use the shell tool (Bash) instead";

/** The fields a flagged shell call may carry: the command (required), what the card shows beside it, and the flag
 *  itself. Anything else present is refused: the card shows every field that changes what runs. */
export const OUTSIDE_SANDBOX_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "command", "description", "timeout", "run_in_background", "dangerouslyDisableSandbox",
]);

/** The card's time-limit line for a flagged call's `timeout` (milliseconds): Clover's own words, so a `text` field. */
export function outsideSandboxTimeoutLine(timeout: number): string {
  return Number.isInteger(timeout) && timeout % 1000 === 0 ? `Time limit: ${timeout / 1000} s` : `Time limit: ${timeout} ms`;
}

/** Why a flagged shell call's `input` may not ask (`command` aside): an unexpected field (named), a background run,
 *  a `run_in_background` or `description` of the wrong type (named), or a `timeout` that isn't a finite positive
 *  number — or undefined when the card may show it. The caller's command check runs first; a key holding `undefined`
 *  reads as absent. */
export function outsideSandboxInputError(tool: string, input: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(input)) {
    if (input[k] === undefined || OUTSIDE_SANDBOX_ALLOWED_FIELDS.has(k)) continue;
    return `${tool} was refused: its input carries a field the card doesn't show (${JSON.stringify(k)}). A command outside the sandbox may only carry command, description, timeout, run_in_background and the flag itself.`;
  }
  if (input.run_in_background === true) {
    return `${tool} was refused: a command outside the sandbox can't run in the background (it would outlive the turn it was approved in).`;
  }
  if (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean") {
    return `${tool} was refused: its run_in_background must be either left out or a boolean, so the card shows what runs.`;
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    return `${tool} was refused: its description must be either left out or a string, so the card shows what runs.`;
  }
  const timeout = input.timeout;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    return `${tool} was refused: its timeout must be a finite positive number of milliseconds, so the card can show it.`;
  }
  return undefined;
}

/** The card's sentence for a command that leaves the sandbox: Clover's own words, so a `text` field. */
export const OUTSIDE_SANDBOX_SENTENCE = "It runs as you, with the network and everything your account can reach.";

/** The card's headline for a command that leaves the sandbox: who asks, as code, like the request-access card's. */
export function outsideSandboxHeadline(bot: string): string {
  return `${plainOf(bot)} wants to run a command outside the sandbox`;
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
  /** What the call does when Clover knows better than its name (a core tool, a bundled web tool), and whether it stays
   *  inside what the fence and sandbox confine (`ApprovalRequest.contained`). */
  effect?: ActionEffect;
  contained?: boolean;
}

/** The request for one call, its paths resolved against the session's working folder (`ctx.paths.scratch`). */
export function botToolRequest(
  ctx: Pick<BotSessionContext, "botId" | "sessionId" | "computer" | "level" | "paths">, origin: TurnOrigin, tool: string,
  input: Record<string, unknown>, opts: BotToolRequestOptions = {},
): CloverApprovalRequest {
  const builtin = isBuiltinTool(tool, opts.hostTools);
  const effect = opts.effect ?? effectOf(tool, opts.hostTools);
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
    effect, ...(opts.contained === true ? { contained: true } : {}), ...(paths.length > 0 ? { paths } : {}), ...(unresolved ? { pathsUnresolved: true } : {}),
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
    /** A bot's commands run in a sandbox drawn from this computer's fence (#356, #362: no network, writes only to the
     *  level's roots, never outside it): each is contained, so at ask for risky actions it runs without asking. */
    commandsSandboxed?: boolean;
    /** A bundled plugin's tool Clover checked (its staged, digest-checked manifest) and knows: the web search and fetch.
     *  Anything else a plugin serves is judged as a tool, whatever it says of itself. */
    bundledTool?: (ctx: BotSessionContext, tool: string) => BundledToolKind | undefined;
    /** Whether the conversation already saw a web address (`SeenUrls`): a fetch of one is contained, while the turn's
     *  budget (`fetchBudget`) holds. */
    seenUrl?: (ctx: BotSessionContext, url: string) => boolean;
    /** A place in the turn's fetch budget (`SeenUrls.take`): without one, no fetch is contained. */
    fetchBudget?: (ctx: BotSessionContext, url: string) => FetchBudget | undefined;
    /** Where a `SendMessage` with this `to` goes (`sendMessageTarget`): undefined when it goes nowhere (no such bot or
     *  session, or one the tool refuses), so the tool's own answer stands. */
    messageTarget?: (ctx: BotSessionContext, to: string) => MessageTarget | undefined;
    /** The link race's interim (the controller's ruling, stage 2): whether the conversation has a background command
     *  or monitor running now, and the folders its shell commands may write. While one runs, a file tool's write
     *  inside those folders is never contained (the reviewer, then a card), the bot's own folders included: the command
     *  could swap the checked file for a link before the write follows it. */
    liveShell?: (ctx: BotSessionContext) => boolean;
    shellRoots?: (ctx: BotSessionContext) => readonly string[];
  } = {},
): (ctx: BotSessionContext, origin: () => TurnOrigin | undefined) => CanUseTool {
  return (ctx, origin) => async (tool, input, call) => {
    const hostTools = new Set(opts.hostTools?.(ctx) ?? []);
    const known = knownEffect(ctx, tool, input, hostTools, opts);
    // The turn's origin, read once: it is fixed when the turn starts (the driver sets it from the input that starts
    // the turn), so text folded in mid-turn from a plugin or another bot never changes it — and that is accepted,
    // because the card still goes to the user who started the turn. Unknown is not the user's.
    const turnOrigin = origin();
    const req = botToolRequest(ctx, turnOrigin ?? "bot", tool, input, {
      hostTools, ...(opts.home === undefined ? {} : { home: opts.home }), ...(opts.localComputer === undefined ? {} : { localComputer: opts.localComputer }),
      ...(known.effect === undefined ? {} : { effect: known.effect }), ...(known.contained === true ? { contained: true } : {}),
    });
    if (known.ruleKey !== undefined) req.ruleKey = known.ruleKey;
    if (known.what !== undefined) req.fields.what = { type: "code", code: plainOf(known.what) };
    if (known.host !== undefined) req.fields.host = { type: "code", code: plainOf(known.host) };
    if (known.cardAlways === true) req.cardAlways = true;
    // The user's secret places (`SECRET_READ_PLACES`: keys, cloud and tool credentials, the Keychain, browser profiles,
    // password managers, sign-ins, shell history), by the place each path really reaches: a read or a search of one is
    // refused with no card at every level, as `BOT_READ_DENIED` is (the runtime's sandbox denies them to Read, Grep, Glob
    // and the shell alike, so no card could open one). The driver's file fence says so first; this holds for every tool.
    // A write into one (an Edit's result or error could quote the file) is refused the same way.
    if (opts.home !== undefined && !req.pathsUnresolved && (req.effect === "read" || req.effect === "search" || WRITE_EFFECTS.includes(req.effect))) {
      const secrets = { userHome: opts.home, os: hostOsOf(), cwd: ctx.paths.scratch };
      // Each path as the input gives it (trimmed and resolved as the runtime opens it, and `~` expanded) and as resolved.
      for (const [i, path] of [...pathsOf(input), ...(req.paths ?? [])].entries()) {
        const cls = secretPlaceOf(path, secrets);
        if (cls !== undefined) return { behavior: "deny", message: secretReadRefusal(isBuiltinTool(tool, hostTools) ? tool : "The tool", pathsOf(input)[i] ?? path, cls) };
      }
    }
    // This computer's fence first (INT, the broker swap; #347's review and the owner's ruling): a path it refuses the
    // bot is refused outright and never becomes a card; a file read or write it allows inside the Clover home runs
    // outright. Only a path outside the home can still ask.
    const racing = WRITE_EFFECTS.includes(req.effect) && req.paths !== undefined && req.paths.length > 0 && !req.pathsUnresolved && opts.liveShell?.(ctx) === true
      && req.paths.some((p) => (opts.shellRoots?.(ctx) ?? []).some((root) => insideFolder(p, realFolder(root))));
    if (racing) req.notContained = true;
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
      if (inHome && writes && opts.levelOf && !racing) {
        // Read-only stays absolute, the bot's own folders included: a routine's level, or its computer's now.
        const readOnly = ctx.level === "read-only" || (opts.levelOf(ctx.computer) ?? "read-only") === "read-only";
        if (readOnly) return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: this computer's level doesn't allow it.` };
        return { behavior: "allow", updatedInput: input };
      }
    }
    const builtin = isBuiltinTool(tool, hostTools);
    // The flag on any tool but the shell tools: refused outright, with no card — whatever value it carries, and in
    // every kind of run. A plugin's or MCP server's tool (`mcp__…`) is left alone.
    if (misplacedSandboxFlag(tool, input)) {
      return { behavior: "deny", message: `${tool} was refused: ${MISPLACED_SANDBOX_FLAG_REFUSAL}.` };
    }
    // A shell call asking to leave the sandbox (`dangerouslyDisableSandbox`) is never contained and never answered
    // without its own card (below): only a call with the flag absent or `false` may run in it.
    const escape: OutsideSandboxFlag = builtin ? outsideSandboxFlagOf(tool, input) : "off";
    if (escape === "odd") {
      // A value the runtime would never honor (`resolveExecutionPath` tests `=== true`, and its Bash validator
      // refuses a non-boolean flag): refused outright, never passed through unflagged, with no card.
      return { behavior: "deny", message: `${builtin ? tool : "The tool"} was refused: \`dangerouslyDisableSandbox\` must be either left out (to stay in the sandbox) or exactly true (to ask to leave it on a card).` };
    }
    if (escape === "escape") {
      // No user can answer in a run with no user present: refused at once, with no card.
      if (ctx.kind !== "bot") {
        return { behavior: "deny", message: `${tool} was refused: a command can't run outside the sandbox in this kind of run (a side thread has no user to approve it). Run the command in the sandbox instead.` };
      }
      // Nobody to answer: only a turn the user started may ask. A turn a plugin's message, another bot, a hook or a
      // routine started has no user in the conversation, so its card would only wait to expire. Unknown is not the user.
      if (turnOrigin !== "user") {
        return { behavior: "deny", message: `${tool} was refused: a command outside the sandbox needs the user to be in the conversation (this turn was started by ${turnOrigin ?? "an unknown origin"}). Run the command in the sandbox instead.` };
      }
      const command = (input as Record<string, unknown>).command;
      if (typeof command !== "string" || command === "") {
        return { behavior: "deny", message: `${tool} was refused: a command that asks to run outside the sandbox must name its command, so the card can show it.` };
      }
      // The card shows every field that changes what runs: anything else present is refused, with no card.
      const judged = outsideSandboxInputError(tool, input);
      if (judged !== undefined) return { behavior: "deny", message: judged };
      // The card shows the command in full or there is no card: a cut command must never stand for the run.
      if (shownCode(command).length > CODE_MAX) {
        return { behavior: "deny", message: `${tool} was refused: the command is longer than a card can show in full, so it can't be approved as shown. Split it into smaller commands or run it in the sandbox.` };
      }
      // A sealed command card at every level: no "always" on it, no saved rule (new or old) matches it, the reviewer
      // is never consulted, and at read-only it is refused like any command (the broker's card-always path).
      req.cardAlways = true;
      delete req.ruleKey;
      req.fields.what = { type: "code", code: outsideSandboxHeadline(ctx.botId) };
      req.fields.command = { type: "code", code: shownCode(command), language: tool === "PowerShell" ? "powershell" : "sh" };
      req.fields.reason = { type: "text", text: OUTSIDE_SANDBOX_SENTENCE };
      // The call's own time limit, when it carries one (validated above): one plain line Clover builds, sealed like
      // the other card fields. When absent, no line. The bot's `description` is never shown as a fact: the bot wrote it.
      if (typeof input.timeout === "number") req.fields.detail = { type: "text", text: outsideSandboxTimeoutLine(input.timeout) };
    } else if (opts.commandsAlwaysCard && builtin && COMMAND_TOOLS.has(tool)) req.cardAlways = true;
    // A command that stays in the sandbox (`dangerouslyDisableSandbox` absent or `false`) is contained, as before.
    else if (opts.commandsSandboxed === true && builtin && BUILTIN_EFFECTS.get(tool) === "execute" && input.dangerouslyDisableSandbox !== true) req.contained = true;
    // What runs is what was shown: the allow carries the canonical judged input the card showed (stable key order),
    // and an input that changed meanwhile is refused instead.
    const shown = escape === "escape" ? canonicalJson(input) : undefined;
    let decision: Awaited<ReturnType<typeof broker.request>> | undefined;
    try {
      decision = await broker.request(req, { signal: call.signal });
    } finally {
      // A fetch the person answered, or that was refused, gives its place in the turn's budget back: the budget counts
      // the fetches that ran without a card (by the level, the reviewer or a saved rule).
      if (known.budget !== undefined && (decision === undefined || !decision.allowed || decision.by === "card")) known.budget.release();
    }
    if (decision.allowed) {
      if (shown !== undefined && canonicalJson(input) !== shown) {
        return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: its input changed after its card was shown, so it needs a new card.` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    const why = decision.by === "level" ? "this computer's level doesn't allow it"
      : decision.by === "expired" ? "no one answered its card in time"
      : decision.by === "withdrawn" || decision.by === "cancelled" ? "the turn was stopped"
      : decision.by === "fence" ? "a file written there runs or applies later outside any sandbox (shell start files, login items, coding agents' settings), so no bot writes there"
      : "the person declined it";
    return { behavior: "deny", message: `${isBuiltinTool(tool, hostTools) ? tool : "The tool"} was refused: ${why}.` };
  };
}

/** Where a bot's `SendMessage` goes, for the approvals (`sendMessageTarget`). */
export interface MessageTarget {
  /** The session it reaches. */
  session: string;
  /** Whether that session is the bot's own (its conversation, its side threads, the agents it started). */
  own: boolean;
  /** The computer it runs on (its level is that computer's), and how the card names it. */
  computer: string;
  label: string;
}

/** What Clover knows of a call beyond its name. */
interface Known {
  effect?: ActionEffect;
  contained?: boolean;
  /** The key an "always" saves, in place of the tool's name. */
  ruleKey?: string;
  /** The card's `what` and `host` lines, as code. */
  what?: string;
  host?: string;
  /** A card every time, with no "always" (`CloverApprovalRequest.cardAlways`). */
  cardAlways?: boolean;
  /** The fetch's place in its turn's budget. */
  budget?: FetchBudget;
}

/** What Clover knows of a call beyond its name: a core tool's rule (`CORE_TOOL_RULES`, and where a message goes), or
 *  a bundled web tool's (a search is a search; a fetch is contained when its address was already seen and the turn's
 *  budget holds, and its "always" holds for its site only). */
function knownEffect(
  ctx: BotSessionContext, tool: string, input: Record<string, unknown>, hostTools: ReadonlySet<string>,
  opts: {
    bundledTool?: (ctx: BotSessionContext, tool: string) => BundledToolKind | undefined; seenUrl?: (ctx: BotSessionContext, url: string) => boolean;
    fetchBudget?: (ctx: BotSessionContext, url: string) => FetchBudget | undefined;
    messageTarget?: (ctx: BotSessionContext, to: string) => MessageTarget | undefined;
    levelOf?: (computer: string) => Level | undefined;
  },
): Known {
  if (hostTools.has(tool)) {
    if (tool === "SendMessage") return messageKnown(ctx, input, opts);
    const rule = CORE_TOOL_RULES.get(tool);
    return rule === "read" ? { effect: "read" } : rule === "contained" ? { contained: true } : {};
  }
  const bundled = opts.bundledTool?.(ctx, tool);
  if (bundled === "web-search") return { effect: "search" };
  if (bundled === "web-fetch") {
    const url = typeof input.url === "string" ? input.url : undefined;
    const site = url === undefined ? undefined : normalUrl(url);
    const budget = url === undefined ? undefined : opts.fetchBudget?.(ctx, url);
    const seen = url !== undefined && opts.seenUrl?.(ctx, url) === true;
    return {
      effect: "fetch",
      ...(seen && budget?.within === true ? { contained: true } : {}),
      ...(site === null || site === undefined ? {} : { ruleKey: `${OTHER_TOOL_KEY}${tool}(${new URL(site.full).origin})` }),
      ...(budget === undefined ? {} : {
        budget,
        host: `${budget.domain}: fetch ${budget.toDomain} to this domain this turn (${budget.inAll} in all; without a card, at most ${FETCHES_PER_DOMAIN} to a domain and ${FETCHES_PER_TURN} in all)`,
      }),
    };
  }
  return {};
}

/** A `SendMessage`: contained to the bot's own sessions and to a session at a level no wider than the bot's; to any
 *  other, a card every time that names where it goes (no "always": one would let every later message through). */
function messageKnown(
  ctx: BotSessionContext, input: Record<string, unknown>,
  opts: { messageTarget?: (ctx: BotSessionContext, to: string) => MessageTarget | undefined; levelOf?: (computer: string) => Level | undefined },
): Known {
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (opts.messageTarget === undefined) return {};
  const target = to === "" ? undefined : opts.messageTarget(ctx, to);
  if (target === undefined || target.own) return { contained: true };
  const mine = ctx.level ?? opts.levelOf?.(ctx.computer);
  const theirs = opts.levelOf?.(target.computer);
  if (mine !== undefined && theirs !== undefined && LEVELS.indexOf(theirs) <= LEVELS.indexOf(mine)) return { contained: true };
  return { what: `SendMessage to ${target.label} (${target.session}, at ${theirs ?? "an unknown level"} on ${target.computer})`, cardAlways: true };
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
