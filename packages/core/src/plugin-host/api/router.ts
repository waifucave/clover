// The plugin API's router in the core (spec §5.4 "The plugin API" and "Capabilities"; the PluginHost contract's
// `ApiRouter`). Every call a plugin's host half makes comes here, after `guardApiRouter` has checked that the plugin
// runs in the process the call came from and that a `clover`-only call came from the `clover` process (S4).
//
// The router is the one capability gate (fails closed):
// * a path that isn't in the plugin SDK's `API_CALLS` doesn't exist (`refused`), whatever the plugin declared;
// * a call needs the capability the catalog names, read from the plugin's own record (the capabilities its OK granted,
//   never from the call: `call:<top-level id>` for `commands.run` (the command's plugin, found by its namespace) and
//   `network:<host>` for `net.fetch` (the URL's host);
// * a call where it doesn't exist (`secrets.get` outside a process of the plugin's own, `ui.send` from a component …)
//   is refused the same way;
// * a plugin that isn't on and running has no API: `plugin_stopped` with its state;
// * a call the catalog has but no handler serves yet answers `refused` ("not served on this computer"), never a guess.
//
// The handlers get the caller the core bound (R7): the session whose tool call the plugin is serving, or the plugin
// itself, and never anything the plugin wrote.
import { apiCallAllowed, API_CALLS, type ApiCallInfo, type ApiCallPath } from "@waifucave/clover-plugin-sdk";
import type { Caller, HostProcess } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { ApiRouter } from "../../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";

/** What a handler gets: the plugin (its record as the core holds it), where the call came from, and whom it acts for. */
export interface ApiCallContext {
  pluginId: string;
  process: HostProcess | "ui";
  caller: Caller;
  record: PluginRecord;
  path: ApiCallPath;
  /** A component's call: the session it shows. */
  session?: string;
}

export type ApiHandler = (ctx: ApiCallContext, args: readonly unknown[]) => unknown;
export type ApiHandlers = Partial<Record<ApiCallPath, ApiHandler>>;

export interface ApiRouterOptions {
  registry: Pick<PluginRegistry, "get">;
  /** The handlers each area serves (`pointsApi`, `storageApi`, `settingsApi` …); a later one wins. Read on every call,
   *  so a list the owner changes later (`DaemonPluginHost.addApiHandlers`) takes effect at once. */
  handlers: readonly ApiHandlers[];
  /** The top-level plugin whose namespace a command name starts with (`commands.run`'s target), or undefined. */
  commandOwner?: (name: string) => string | undefined;
  /** Whether `network:` capabilities reach a host (`net.fetch`'s target). Absent: no host is reached. */
  allowNetwork?: (capabilities: readonly string[], host: string, port?: number) => boolean;
}

/** The states in which a plugin's host half may use the API. */
const LIVE = new Set(["running", "waiting"]);

/** The handler a list serves for a path: the last one that has it. */
export function handlerOf(list: readonly ApiHandlers[], path: ApiCallPath): ApiHandler | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i]!;
    if (Object.hasOwn(h, path) && h[path] !== undefined) return h[path];
  }
  return undefined;
}

export function createApiRouter(o: ApiRouterOptions): ApiRouter {
  return async (call) => {
    const path = call.path as ApiCallPath;
    if (!Object.hasOwn(API_CALLS, path)) throw new ContractError("refused", `${call.path} isn't a call of the plugin API`);
    const record = o.registry.get(call.pluginId);
    if (record === undefined) throw new ContractError("not_installed", `${call.pluginId} isn't installed`);
    if (!record.enabled || !LIVE.has(record.state)) {
      throw new ContractError("plugin_stopped", `${call.pluginId} is ${record.enabled ? record.state : "off"}${record.reason ? `: ${record.reason}` : ""}`);
    }
    const target = targetOf(path, call.args, o.commandOwner);
    if (!apiCallAllowed(path, call.process, record.granted, target, o.allowNetwork)) {
      throw new ContractError("refused", refusal(path, call.process, target), { call: path });
    }
    const fn = handlerOf(o.handlers, path);
    if (fn === undefined) throw new ContractError("refused", `${path} is not served on this computer`, { call: path });
    return await fn({ pluginId: call.pluginId, process: call.process, caller: call.caller, record, path, ...(call.session !== undefined ? { session: call.session } : {}) }, call.args);
  };
}

/** The target a capability is checked against: a command's plugin, a URL's host. */
function targetOf(path: ApiCallPath, args: readonly unknown[], commandOwner?: (name: string) => string | undefined): { plugin?: string; host?: string; port?: number } | undefined {
  if (path === "commands.run") {
    const name = args[0];
    if (typeof name !== "string") return undefined;
    const owner = commandOwner?.(name);
    if (owner === undefined) throw new ContractError("not_installed", `no command ${name} is installed`);
    return { plugin: owner };
  }
  if (path === "net.fetch") {
    const raw = args[0];
    let url: URL;
    try {
      url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : "");
    } catch {
      throw new ContractError("invalid", "net.fetch takes an absolute URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ContractError("invalid", "net.fetch takes an http or https URL");
    // The port the request goes to: the URL's, or its scheme's (a `network:` entry without a port means 443 or 80).
    return { host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port) };
  }
  return undefined;
}

function refusal(path: ApiCallPath, process: HostProcess | "ui", target?: { plugin?: string; host?: string }): string {
  const info: ApiCallInfo = API_CALLS[path];
  if (info.where === "ui") return `${path} exists only in components`;
  if (process === "ui" && info.where !== "both") return `${path} exists only in a plugin's host code`;
  if (info.where === "own" && process !== "own") return `${path} exists only in a process of the plugin's own`;
  if (info.where === "clover" && process !== "clover") return `${path} exists only in the clover plugin host`;
  const capability = info.capability === "call:*" ? `call:${target?.plugin ?? "<plugin>"}` : info.capability === "network:*" ? `network:${target?.host ?? "<host>"}` : info.capability;
  return `${path} needs the capability ${capability}, which this plugin's OK doesn't list`;
}

/** The argument at `i` as a string, or `invalid`. */
export function stringArg(args: readonly unknown[], i: number, what: string, max = 256): string {
  const v = args[i];
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new ContractError("invalid", `${what} is a string of 1 to ${max} characters`);
  return v;
}

/** The argument at `i` as a listener function (a watch's), or `invalid`. */
export function listenerArg<T>(args: readonly unknown[], i: number): (value: T) => void {
  const v = args[i];
  if (typeof v !== "function") throw new ContractError("invalid", "a watch takes a listener");
  return v as (value: T) => void;
}
