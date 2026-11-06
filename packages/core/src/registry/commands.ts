// `command.run` (spec §5.4; F-M3's review N4): a plugin's command, run at once with no model turn. Before any handler
// runs, the core checks the call's `args` against the JSON Schema the command declares (`validateArgs`, the same check
// the palette runs first), for every caller: the app, the CLI, a phone, a layer and another plugin alike. A call that
// doesn't fit answers `invalid_args` with the failing JSON Pointer and keyword, never the value, and the handler
// never sees it.
import { validateArgs } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS, type Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { handler, type MethodHandler } from "../rpc/handler";

/** A command as the registry knows it: `<namespace>.<name>`, its plugin, its handler and its declared `args` schema. */
export interface RunnableCommand {
  name: string;
  pluginId: string;
  handler: string;
  args?: Record<string, unknown>;
}

export interface CommandRunnerOptions {
  /** The installed, running command of that full name, or undefined. */
  find(name: string): RunnableCommand | undefined;
  host: Pick<PluginHost, "invoke">;
}

/** Runs `command.run` for `caller`: `not_installed` for an unknown command, `invalid_args` for args that don't fit
 *  its schema (detail: `path`, `keyword`), else the handler's result. */
export async function runCommand(o: CommandRunnerOptions, params: { name: string; args?: unknown }, caller: Caller): Promise<{ result: unknown }> {
  const command = o.find(params.name);
  if (command === undefined) throw new ContractError("not_installed", `no command ${params.name}`);
  const check = validateArgs(command.args, params.args);
  if (!check.ok) {
    const at = check.path === "" ? "the args" : `args at ${check.path}`;
    throw new ContractError("invalid_args", `${params.name}: ${at} fail "${check.keyword}"`, { path: check.path, keyword: check.keyword });
  }
  const result = await o.host.invoke({ pluginId: command.pluginId, handler: command.handler, args: params.args ?? {}, caller });
  return { result };
}

/** The active command of that full name in the registry (`<namespace>.<name>`, the registry's `entryId`). */
export function registryCommand(registry: Pick<PluginRegistry, "entries">, name: string): RunnableCommand | undefined {
  const c = registry.entries("commands").find((e) => e.state === "active" && e.entryId === name);
  if (c === undefined) return undefined;
  const v = c.value as { handler: string; args?: Record<string, unknown> };
  return { name, pluginId: c.pluginId, handler: v.handler, ...(v.args === undefined ? {} : { args: v.args }) };
}

/** `command.run` on Clover's connections: every caller's call goes through `runCommand`, the args check first. */
export function commandMethods(deps: { registry: Pick<PluginRegistry, "entries">; host: Pick<PluginHost, "invoke"> }): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  const o: CommandRunnerOptions = { find: (name) => registryCommand(deps.registry, name), host: deps.host };
  return {
    [M.commandRun.name]: handler(M.commandRun, (p, ctx) => runCommand(o, { name: p.name, ...(p.args === undefined ? {} : { args: p.args }) }, ctx.caller)),
  };
}
