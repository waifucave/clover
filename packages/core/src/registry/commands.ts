// `command.run` (spec §5.4; F-M3's review N4): a plugin's command, run at once with no model turn. Before any handler
// runs, the core checks the call's `args` against the JSON Schema the command declares (`validateArgs`, the same check
// the palette runs first), for every caller: the app, the CLI, a phone, a layer and another plugin alike. A call that
// doesn't fit answers `invalid_args` with the failing JSON Pointer and keyword, never the value, and the handler
// never sees it.
//
// Who may run what (§5.4): the user and a session run any command; a plugin, on whatever route (its layer's
// connection, or its host half's or a component's plugin API), runs only its own tree's commands, and another plugin's
// only with `call:<that plugin's top-level id>` on its OK (`mayRunCommand`). A command inside a bot (`own-bot`, its own
// scope or its plugin's, §5.5) runs for the user and for that bot's own sessions (its conversation, side threads and
// the agents it starts), never another bot's or a coding session's. The checks are before the args check, so a refused
// caller learns nothing of the command's schema.
import { validateArgs, type HoldPhase } from "@waifucave/moss-plugin-sdk";
import { PLUGINS_METHODS, type Caller } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import { grantsInForce, type PluginRegistry } from "../contracts/plugin-registry";
import { handler, type MethodHandler } from "../rpc/handler";
import { scopeOf, servesScope, type PluginScope } from "../runtime-sdk/turn-loop/only-backends";

/** A command as the registry knows it: `<namespace>.<name>`, its plugin, its handler and its declared `args` schema. */
export interface RunnableCommand {
  name: string;
  pluginId: string;
  handler: string;
  args?: Record<string, unknown>;
  /** Its scope: its own, else its plugin's (`own-bot`: inside the plugin's bot). */
  scope?: PluginScope;
  /** A held key binding's command (`hold`): it runs only from its key. */
  hold?: boolean;
}

/** Who a held key's run may come from: the app's own connection, whose main process sends it from the key it saw. */
const fromTheKey = (caller: Caller): boolean => caller.kind === "user" && (caller as { client?: unknown }).client === "app";

export interface CommandRunnerOptions {
  /** The installed, running command of that full name, or undefined. */
  find(name: string): RunnableCommand | undefined;
  host: Pick<PluginHost, "invoke">;
  /** The capabilities a plugin's OK granted (the registry's record); undefined, or no function, grants nothing. */
  grantedOf?(pluginId: string): readonly string[] | undefined;
}

const topOf = (pluginId: string): string => pluginId.split("/")[0]!;

/** Whether `caller` may run a command of `owner`'s: anyone but a plugin may; a plugin runs its own tree's commands, and
 *  another top-level plugin's (and its children's) only with `call:<that top-level id>` granted. */
export function mayRunCommand(caller: Caller, owner: string, granted: readonly string[] | undefined): boolean {
  if (caller.kind !== "plugin") return true;
  if (topOf(caller.pluginId) === topOf(owner)) return true;
  return (granted ?? []).includes(`call:${topOf(owner)}`);
}

/** Runs `command.run` for `caller`: `not_installed` for an unknown command, `invalid_args` for args that don't fit
 *  its schema (detail: `path`, `keyword`), else the handler's result. */
export async function runCommand(o: CommandRunnerOptions, params: { name: string; args?: unknown; held?: HoldPhase }, caller: Caller): Promise<{ result: unknown }> {
  const command = o.find(params.name);
  if (command === undefined) throw new ContractError("not_installed", `no command ${params.name}`);
  // A held key binding's command (§5.4 `hold`) runs only from its key: the down, release or cancel the app's main process saw
  // and sends (`held`), never from the CLI, the palette, a session or another plugin, whatever args they give. Its handler
  // gets `{ key: <held> }` and nothing else.
  if (command.hold === true || params.held !== undefined) {
    if (command.hold !== true) throw new ContractError("refused", `${params.name} is not a held key's command`);
    if (params.held === undefined || !fromTheKey(caller)) throw new ContractError("refused", `${params.name}: a held command runs only from its key`);
    const result = await o.host.invoke({ pluginId: command.pluginId, handler: command.handler, args: { key: params.held }, caller });
    return { result };
  }
  if (caller.kind === "plugin" && !mayRunCommand(caller, command.pluginId, o.grantedOf?.(caller.pluginId))) {
    throw new ContractError("refused", `${params.name} is ${topOf(command.pluginId)}'s: running it needs the capability call:${topOf(command.pluginId)}, which ${caller.pluginId}'s OK doesn't list`);
  }
  if (caller.kind === "session" && command.scope === "own-bot") {
    const s = caller as { sessionKind?: string; bot?: string };
    if (!servesScope("own-bot", { kind: s.sessionKind ?? "", ...(s.bot === undefined ? {} : { bot: s.bot }) }, command.pluginId)) {
      throw new ContractError("refused", `${params.name} is ${topOf(command.pluginId)}'s own: only you and ${topOf(command.pluginId)} run it`);
    }
  }
  const check = validateArgs(command.args, params.args);
  if (!check.ok) {
    const at = check.path === "" ? "the args" : `args at ${check.path}`;
    throw new ContractError("invalid_args", `${params.name}: ${at} fail "${check.keyword}"`, { path: check.path, keyword: check.keyword });
  }
  const result = await o.host.invoke({ pluginId: command.pluginId, handler: command.handler, args: params.args ?? {}, caller });
  return { result };
}

/** The active command of that full name in the registry (`<namespace>.<name>`, the registry's `entryId`). */
export function registryCommand(registry: Pick<PluginRegistry, "entries"> & Partial<Pick<PluginRegistry, "get">>, name: string): RunnableCommand | undefined {
  const c = registry.entries("commands").find((e) => e.state === "active" && e.entryId === name);
  if (c === undefined) return undefined;
  const v = c.value as { handler: string; args?: Record<string, unknown>; scope?: unknown; hold?: unknown };
  const hold = v.hold === true;
  // Its scope as the registry reads it (its own, else its plugin's or tree's); without the records, only its own.
  const scope = registry.get !== undefined ? scopeOf(registry as Pick<PluginRegistry, "get">, c.pluginId, v.scope) : v.scope === "own-bot" ? "own-bot" : undefined;
  return { name, pluginId: c.pluginId, handler: v.handler, ...(v.args === undefined ? {} : { args: v.args }), ...(scope === undefined ? {} : { scope }), ...(hold ? { hold } : {}) };
}

/** `command.run` on MOSS's connections: every caller's call goes through `runCommand`, the args check first. */
export function commandMethods(deps: { registry: Pick<PluginRegistry, "entries"> & Partial<Pick<PluginRegistry, "get">>; host: Pick<PluginHost, "invoke"> }): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  const o: CommandRunnerOptions = { find: (name) => registryCommand(deps.registry, name), host: deps.host, grantedOf: (id) => grantsInForce(deps.registry.get?.(id)) };
  return {
    [M.commandRun.name]: handler(M.commandRun, (p, ctx) => runCommand(o, { name: p.name, ...(p.args === undefined ? {} : { args: p.args }), ...(p.held === undefined ? {} : { held: p.held }) }, ctx.caller)),
  };
}
