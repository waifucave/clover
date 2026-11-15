// What a host half's `api` has, at any depth (spec §5.4): the catalog's members (`API_CALLS`), a call's own function
// methods, a closed list of keys other code reads on any object (harmless), and nothing else. The plugin host's proxy
// (runtime.ts) and the contracts' fake host (contracts/fakes/plugin-host.ts) both answer by it, so a conformance test
// holds them to one rule.
// The catalog alone (its own module, types only besides): the host process loads no more of the SDK than this.
import { API_CALLS } from "@waifucave/clover-plugin-sdk/api-calls";

/** Every dotted prefix of a call the catalog lists (`storage`, `storage.synced`, `storage.synced.get`): what a host
 *  half's `api` has, at any depth. */
const API_PREFIXES: ReadonlySet<string> = new Set(Object.keys(API_CALLS).flatMap((call) => call.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."))));
/** Keys other code reads on any object it is handed, at any depth of `api`: each reads as undefined, never a member and
 *  never a throw. A closed list (the SDK's HostPluginApi TSDoc names it): no catalog area or call has one of these names. */
export const HARMLESS_KEYS: ReadonlySet<string> = new Set([
  // Promise handling (`await api` must not see a thenable) and serialising.
  "then", "catch", "finally", "toJSON", "toString", "valueOf",
  // Inspection: console.log, util.inspect, React's and the DOM's checks, a function's own names.
  "inspect", "constructor", "prototype", "__proto__", "$$typeof", "nodeType", "nodeName", "tagName", "length", "name", "displayName",
  // A function's legacy accessors, which throw on a strict function when read for real.
  "caller", "arguments",
  // ES-module interop in bundlers and transpilers (`__toESM`, `interopRequireDefault`, `import * as ns`).
  "__esModule", "default",
  // Test frameworks' deep equality and spies (jest's `equals`, `isMockFunction`, `spyOn`, Immutable.js checks and
  // pretty-format; bun:test reads none of these).
  "asymmetricMatch", "toAsymmetricMatcher", "_isMockFunction", "getMockName", "mock", "mockImplementation", "calls",
  "@@__IMMUTABLE_ITERABLE__@@", "@@__IMMUTABLE_KEYED__@@", "@@__IMMUTABLE_ORDERED__@@", "@@__IMMUTABLE_RECORD__@@", "@@__IMMUTABLE_SET__@@",
]);
/** `api.storage.dataFolder`: the one data member of an area (the SDK's `StorageApi`), a host half's own folder's path.
 *  Not a call, so not in the catalog; each host answers it from what it was started with (`api.plugin` likewise, at
 *  the top). */
export function isDataFolder(path: readonly string[], prop: string | symbol): boolean {
  return prop === "dataFolder" && path.length === 1 && path[0] === "storage";
}

/** A function's own methods, on a call (`api.settings.get.bind(…)`). */
const FUNCTION_KEYS: ReadonlySet<string> = new Set(["bind", "call", "apply"]);

/** What `api.<path>.<prop>` is in a host half: a member of the plugin API (a call or an area), a function's own method
 *  on a call, a harmless key (inspection, `then`), or a member that doesn't exist. */
export function apiMember(path: readonly string[], prop: string | symbol): "member" | "function" | "harmless" | "unknown" {
  if (typeof prop !== "string") return "harmless";
  const dotted = [...path, prop].join(".");
  if (API_PREFIXES.has(dotted)) return "member";
  if (path.length > 0 && Object.hasOwn(API_CALLS, path.join(".")) && FUNCTION_KEYS.has(prop)) return "function";
  if (HARMLESS_KEYS.has(prop)) return "harmless";
  return "unknown";
}

/** Whether `prop in api.<path>` in a host half: a call the catalog has for host code and serves (not `notYet`, not a
 *  component's alone), or an area with one such call under it. A feature test, so it never throws. */
export function apiHas(path: readonly string[], prop: string | symbol): boolean {
  if (typeof prop !== "string") return false;
  if (path.length === 0 && prop === "plugin") return true;
  const dotted = [...path, prop].join(".");
  const usable = ([call, info]: [string, { where: string; notYet?: string }]) => (call === dotted || call.startsWith(`${dotted}.`)) && info.where !== "ui" && info.notYet === undefined;
  return (Object.entries(API_CALLS) as [string, { where: string; notYet?: string }][]).some(usable);
}

/** What reading `api.<path>.<prop>` gives: the member's own proxy (`make`), a call's function method, undefined for a
 *  harmless key, or a TypeError naming a member the plugin API doesn't have. */
export function apiMemberValue(path: readonly string[], prop: string | symbol, make: (path: string[]) => unknown): unknown {
  const kind = apiMember(path, prop);
  if (kind === "member") return make([...path, prop as string]);
  if (kind === "function") return (Function.prototype as unknown as Record<string, unknown>)[prop as string];
  if (kind === "harmless") return undefined;
  throw new TypeError(`api.${[...path, String(prop)].join(".")} doesn't exist in the plugin API (see API_CALLS in @waifucave/clover-plugin-sdk)`);
}
