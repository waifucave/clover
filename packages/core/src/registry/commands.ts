// `command.run` (spec §5.4; F-M3's review N4): a plugin's command, run at once with no model turn. Before any handler
// runs, the core checks the call's `args` against the JSON Schema the command declares (`validateArgs`, the same check
// the palette runs first), for every caller: the app, the CLI, a phone, a layer and another plugin alike. A call that
// doesn't fit answers `invalid_args` with the failing JSON Pointer and keyword, never the value, and the handler
// never sees it.
import { validateArgs } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";

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
