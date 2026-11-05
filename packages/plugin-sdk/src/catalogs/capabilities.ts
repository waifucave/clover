// The capability catalog (spec §5.4 "Capabilities", §5.6). Each capability gates a fixed set of plugin-API calls and
// live events (`api-calls.ts`); without it, those calls don't exist for that plugin. Capabilities gate the plugin API
// only: they are not containment (§5.6 "The guards"). Versioned with `engines.clover`.
import { BUNDLED_ROOT_PLUGIN, isPluginId } from "@waifucave/clover-protocol";

export interface CapabilityInfo {
  /** The name as a manifest lists it; `call:` and `network:` take an argument. */
  readonly name: string;
  /** What it lets the plugin do (§5.4's table). */
  readonly lets: string;
  /** What the OK says about it (§5.6), in English; trusted packs translate it under `clover.capability.<name>`. */
  readonly ok: string;
  /** The OK words it specially (§5.4: "controls the screen…", "restyles approval cards", "can hear your microphone"). */
  readonly warns: boolean;
  /** Only the bundled `clover` tree may hold it, as only its process may use `keys.*`: the validator refuses it for any
   *  other plugin, and the core never grants it to one (`mayHoldCapability`). */
  readonly bundledOnly?: true;
}

export const CAPABILITIES: readonly CapabilityInfo[] = [
  { name: "conversation.read", lets: "Read bots' conversations and follow them live; sealed card fields never reach it", ok: "reads your conversations with bots", warns: false },
  { name: "conversation.post", lets: "Add a note to a conversation, or send a bot a message; a turn it starts is the plugin's, never the user's", ok: "adds notes and sends messages to bots", warns: false },
  { name: "memory.read", lets: "Read bots' memories", ok: "reads your bots' memories", warns: false },
  { name: "bots.read", lets: "Read the list of bots and their settings", ok: "sees your bots and their settings", warns: false },
  { name: "routines.read", lets: "Read the list of routines and their runs", ok: "sees your routines and their runs", warns: false },
  { name: "computers.read", lets: "Read the computer registry: each computer's folders, level and state", ok: "sees your computers, their folders and levels", warns: false },
  { name: "computers.control", lets: "Take and release holds and the user-working mark, learn where Clover's windows are, and say when an action is running", ok: "controls the screen and input of your computers", warns: true },
  /** Not in §5.4's table: added at M0 for the island's Devices tab (review S16). */
  { name: "devices.read", lets: "Read the user's devices: their names, kinds, links, which one is the main, and which are online", ok: "sees your devices", warns: false },
  { name: "approvals", lets: "Hear which cards are pending, never their text, and place their sealed frames", ok: "restyles approval cards", warns: true },
  { name: "files", lets: "Read and write files through the folder tree, inside the fence", ok: "reads and writes files on your computers", warns: false },
  { name: "browser", lets: "Drive the Clover Browser through its API", ok: "drives the Clover Browser", warns: false },
  /** Not in §5.4's table: lane F's request for the terminal panel. The bundled `clover` tree only (the controller's
   *  ruling, review T1), since the daemon can't check that what a component sends came from the user's keys. */
  { name: "terminal", lets: "Show the user's terminals on their computers, fed only with what the runtime derives from the user's own key presses and pastes; never on a computer at read-only", ok: "runs commands on your computers", warns: true, bundledOnly: true },
  { name: "usage.read", lets: "Read usage rows and plan readings", ok: "sees your usage and plan readings", warns: false },
  { name: "logs.read", lets: "Read Clover's logs and every plugin's", ok: "reads Clover's logs", warns: false },
  { name: "notify", lets: "Send the user a notification through the notifiers", ok: "sends you notifications", warns: false },
  { name: "audio", lets: "Record and play audio through the app; it records only while push-to-talk is held, unless the user turns listening on", ok: "can hear your microphone", warns: true },
  { name: "call:<plugin-id>", lets: "Run that plugin's commands", ok: "runs commands of {plugin}", warns: false },
  { name: "network:<host>", lets: "Reach that host through the core's fetch, which adds the plugin's own keys and tokens, and from the plugin's components, which reach no other host", ok: "connects to {host}", warns: false },
];

/** Whether a plugin may hold a capability at all: a `bundledOnly` one only in the bundled `clover` tree, which the core
 *  decides from the install record (`source: "bundled"`, top-level id `clover`), never from the manifest. */
export function mayHoldCapability(capability: string, plugin: { id: string; source: string }): boolean {
  if (!CAPABILITIES.find((c) => c.name === capability)?.bundledOnly) return true;
  const top = plugin.id.includes("/") ? plugin.id.slice(0, plugin.id.indexOf("/")) : plugin.id;
  return plugin.source === "bundled" && top === BUNDLED_ROOT_PLUGIN;
}

/** The capabilities that take no argument. */
export const FIXED_CAPABILITIES: readonly string[] = CAPABILITIES.map((c) => c.name).filter((n) => !n.includes("<"));

export type ParsedCapability =
  | { kind: "fixed"; name: string }
  | { kind: "call"; plugin: string }
  | { kind: "network"; host: string; port?: number; wildcard: boolean };

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(\\.${LABEL})*$`);
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;

/** The generic second-level labels registries sell names under (`co.uk`, `com.au`, `ne.jp`): `*.` over one of these
 *  and a two-letter country code would reach every site in that country's registry (review minor). */
const REGISTRY_LABELS = new Set(["ac", "co", "com", "edu", "go", "gob", "gouv", "gov", "int", "ltd", "me", "mil", "ne", "net", "nhs", "nom", "or", "org", "plc", "sch"]);

/** Whether a wildcard's domain is too wide to declare: a run of numbers (`*.0.0.1` would match an IPv4 address), or a
 *  registry suffix (`*.co.uk`). A single label never gets here. */
function wildcardTooWide(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.every((l) => /^\d+$/.test(l))) return true;
  if (/^\d+$/.test(labels.at(-1)!)) return true;
  return labels.length === 2 && REGISTRY_LABELS.has(labels[0]!) && /^[a-z]{2}$/.test(labels[1]!);
}

/** Parses `network:<host>`'s argument: a name (lowercase), an IPv4 address or a bracketed IPv6 address, with `:port`
 *  if needed, or `*.` and a domain of at least two labels for its subdomains (§5.4), never one that ends in a number
 *  (an address) or is a registry suffix such as `co.uk`. */
export function parseNetworkHost(arg: string): { host: string; port?: number; wildcard: boolean } | null {
  let rest = arg;
  let port: number | undefined;
  const portMatch = /^(.*):(\d{1,5})$/.exec(rest);
  if (portMatch && !(rest.startsWith("[") && !rest.includes("]:"))) {
    port = Number(portMatch[2]);
    if (port < 1 || port > 65535) return null;
    rest = portMatch[1]!;
  }
  let wildcard = false;
  if (rest.startsWith("*.")) {
    wildcard = true;
    rest = rest.slice(2);
    if (!HOSTNAME_RE.test(rest) || !rest.includes(".") || wildcardTooWide(rest)) return null;
    return { host: rest, wildcard, ...(port !== undefined ? { port } : {}) };
  }
  if (HOSTNAME_RE.test(rest) || IPV4_RE.test(rest) || IPV6_RE.test(rest)) return { host: rest, wildcard, ...(port !== undefined ? { port } : {}) };
  return null;
}

/** Parses a capability as a manifest lists it; null when it isn't one. */
export function parseCapability(text: string): ParsedCapability | null {
  if (FIXED_CAPABILITIES.includes(text)) return { kind: "fixed", name: text };
  if (text.startsWith("call:")) {
    const plugin = text.slice(5);
    // `call:<plugin-id>` names a top-level plugin and covers its children (§5.4).
    return isPluginId(plugin) ? { kind: "call", plugin } : null;
  }
  if (text.startsWith("network:")) {
    const parsed = parseNetworkHost(text.slice(8));
    return parsed ? { kind: "network", ...parsed } : null;
  }
  return null;
}

export function isCapability(text: string): boolean {
  return parseCapability(text) !== null;
}

/** Whether `host` (and `port`) is one of a plugin's `network:` hosts. A wildcard covers subdomains, not the domain
 *  itself; a host given without a port matches the URL scheme's default port only. */
export function networkAllows(capabilities: readonly string[], host: string, port?: number): boolean {
  const h = host.toLowerCase();
  for (const cap of capabilities) {
    const p = parseCapability(cap);
    if (!p || p.kind !== "network") continue;
    if (p.port !== undefined ? p.port !== port : port !== undefined) continue;
    if (p.wildcard ? h.endsWith(`.${p.host}`) : h === p.host) return true;
  }
  return false;
}

/** The OK's phrase for a capability, in English. */
export function capabilityOkText(text: string): string | null {
  const p = parseCapability(text);
  if (!p) return null;
  if (p.kind === "call") return `runs commands of ${p.plugin}`;
  if (p.kind === "network") return `connects to ${p.wildcard ? "*." : ""}${p.host}${p.port !== undefined ? `:${p.port}` : ""}`;
  return CAPABILITIES.find((c) => c.name === p.name)!.ok;
}
