// The capability catalog (spec §5.4 "Capabilities", §5.6). Each capability gates a fixed set of plugin-API calls and
// live events (`api-calls.ts`); without it, those calls don't exist for that plugin. Capabilities gate the plugin API
// only: they are not containment (§5.6 "The guards"). Versioned with `engines.clover`.
import { isPluginId } from "@waifucave/clover-protocol";

export interface CapabilityInfo {
  /** The name as a manifest lists it; `call:` and `network:` take an argument. */
  readonly name: string;
  /** What it lets the plugin do (§5.4's table). */
  readonly lets: string;
  /** What the OK says about it (§5.6), in English; trusted packs translate it under `clover.capability.<name>`. */
  readonly ok: string;
  /** The OK words it specially (§5.4: "controls the screen…", "restyles approval cards", "hears what you say to your bots…"):
   *  a risky capability, whose `ok` line says the risk in plain words. Any plugin may ask for any capability (the owner,
   *  2026-11-15: "Yes, all with a warning"); the OK card is the gate. */
  readonly warns: boolean;
}

export const CAPABILITIES: readonly CapabilityInfo[] = [
  { name: "conversation.read", lets: "Read every bot's conversations and follow them live (there is no per-bot grant yet); sealed card fields never reach it", ok: "reads your conversations with all your bots", warns: false },
  { name: "conversation.post", lets: "Add a note to any bot's conversation, or send any bot a message (there is no per-bot grant yet); a turn it starts is the plugin's, never the user's", ok: "adds notes and sends messages to any of your bots", warns: false },
  { name: "memory.read", lets: "Read bots' memories", ok: "reads your bots' memories", warns: false },
  { name: "bots.read", lets: "Read the list of every bot and their settings (there is no per-bot grant yet)", ok: "sees all your bots and their settings", warns: false },
  { name: "routines.read", lets: "Read the list of routines and their runs", ok: "sees your routines and their runs", warns: false },
  { name: "computers.read", lets: "Read the computer registry: each computer's folders, level and state", ok: "sees your computers, their folders and levels", warns: false },
  { name: "computers.control", lets: "Take and release holds and the user-working mark, learn where Clover's windows are, and say when an action is running", ok: "controls the screen and input of your computers", warns: true },
  /** Not in §5.4's table: added at M0 for the island's Devices tab (review S16). */
  { name: "devices.read", lets: "Read the user's devices: their names, kinds, links, which one is the main, and which are online", ok: "sees your devices", warns: false },
  { name: "approvals", lets: "Hear which cards are pending, never their text, and place their sealed frames", ok: "restyles approval cards", warns: true },
  /** Lane G's F4 (the owner's ruling of 2026-11-15: nothing that only one plugin uses). What the island does for every card, any
   *  plugin may do behind its OK card: with `approvals`, hear every pending card's meta (not only its own bot's, and the cards that
   *  have no bot: a plugin's OK, a change from Settings) and place their sealed frames, with the `card.*` look of its own. The
   *  sealed rules (the checks on a press, the page's own visibility and open-delay) do not move, and the card's words never reach it. */
  { name: "approvals.all", lets: "Needs `approvals` too: hear the meta of every pending card, not only its own bots' (a plugin's OK card, a change from Settings), place their sealed frames in a surface of its own, and give each the look of its own `card.*` tokens; the card's words never reach it and the press stays the sealed frame's own", ok: "shows all your approval cards, whichever bot or plugin asks, and takes your yes or no on them", warns: true },
  /** The user's own words as the user: what the Dispatch pill does, behind a call any plugin's part may make. */
  { name: "user.send", lets: "Send text the part chooses to any bot, any session (coding sessions too) or any `pill.target` entry, as the user, on any real click or key press inside its own frames (`useUserSend`); one send for one press", ok: "sends messages to your bots and sessions as you, with text it chooses, whenever you click or press a key in its window", warns: true },
  /** A window that floats: the island's and the pill's level. */
  { name: "overlay", lets: "Open surfaces (`app.surface` entries) that float above every other window on every desktop, over the menu bar and full-screen apps, as large as the screen (`alwaysOnTop`); without it a surface is an ordinary window level, at most 800 by 600", ok: "shows windows on top of everything else on your screen", warns: true },
  /** A line in the menu-bar (tray) menu. */
  { name: "tray", lets: "Add items to Clover's menu-bar (tray) menu (`app.tray` entries): one that hides and shows a surface of its own, or runs a command of its own", ok: "adds items to Clover's menu in your menu bar", warns: false },
  { name: "files", lets: "Read and write files through the folder tree, inside the fence", ok: "reads and writes files on your computers", warns: false },
  /** The controller's ruling after #345: the plugin-process fence leaves a session's project folders read-only to a
   *  plugin's hooks and stdio MCP servers; this lets them write there (never `.git/hooks`, `.git/config` or a
   *  credential file). Bundled plugins hold it the same way. */
  { name: "project.write", lets: "Let its hooks and stdio MCP servers change files in the session's project folders (never `.git/hooks`, `.git/config` or a credential file); without it, those folders are read-only to them", ok: "changes files in your project folders", warns: true },
  /** Any plugin may ask (the owner, 2026-11-15); the card says what it can see and do there. */
  { name: "browser", lets: "Drive the Clover Browser through its API", ok: "drives the Clover Browser: it can open pages, read them and act on them in its tabs, signed in wherever you signed in there", warns: true },
  /** Not in §5.4's table: lane F's request for the terminal panel. Any plugin may ask (the owner, 2026-11-15); the daemon
   *  can't check that what a component sends came from the user's keys (review T1), so the card says it plainly. */
  { name: "terminal", lets: "Show the user's terminals on their computers, fed only with what the runtime derives from the user's own key presses and pastes; never on a computer at read-only", ok: "runs commands in a terminal on your computers, as you, outside Clover's sandbox", warns: true },
  /** The window itself (`shell.*`): a plugin that draws its own bar, sidebar or controls in a bot's tab. Reads answer where the window is; acts are the user's own press and change only the window's place. */
  { name: "shell.read", lets: "Read where the window is: the tab showing, the sidebar's and panels' state, the sidebar's app buttons and how far the native window controls reach", ok: "sees which tab and panels are showing", warns: false },
  { name: "shell.control", lets: "Move the window's own parts when the user presses its controls: show a tab, a panel or the settings, fold the sidebar, open the bot's editor, drag the window; never a conversation, a card or a file", ok: "lets its own buttons move around Clover's window", warns: false },
  { name: "plugins.install", lets: "Install plugins from the indexes and npm for the user to OK: each lands found, with its sealed OK card, and nothing it installs runs before that OK", ok: "downloads other plugins from the indexes and npm onto your computer, each waiting for your OK on its own card", warns: true },
  /** Events only (the controller's ruling for the Plugins page): `plugin_changed`, `plugin_removed`, `plugin_found` and
   *  `plugin_card_note` on a layer, ids and states and Clover's own words, never a folder; no method or API call names
   *  it, so it opens nothing callable. */
  { name: "plugins.watch", lets: "Hear which plugins appear, change state or go (their ids and states only), and why a yes on a plugin's change card couldn't be done; it can call nothing", ok: "sees every plugin you have, whether it's on, and when you add or remove one", warns: true },
  { name: "usage.read", lets: "Read usage rows and plan readings", ok: "sees your usage and plan readings", warns: false },
  { name: "logs.read", lets: "Read Clover's logs and every plugin's", ok: "reads Clover's logs and every plugin's logs", warns: false },
  { name: "avatar.read", lets: "Read the figure of its own bot: the names its model answers to (expressions, motions, outfit parts), where the figure is on the stage, and hear them change", ok: "sees your bot's figure", warns: false },
  { name: "avatar.control", lets: "Make the figure of its own bot play an expression or a motion, switch an outfit part, calm or liven it, look at a point, or move its mouth with speech levels; the renderer says plainly what it doesn't do", ok: "moves your bot's figure", warns: false },
  /** Any bot's figure, not only the plugin's own: a voice that speaks for every bot sends each its mouth. It holds
   *  `avatar.control` by holding this (`IMPLIED_CAPABILITIES`). Not display-only (`CONTAINED_TOOL_CAPABILITIES` lacks it). */
  { name: "avatar.control.all", lets: "Do what avatar.control does for any bot's figure, not only its own: play cues and send the mouth's levels (speech) to any bot's stage; the renderer says plainly what it doesn't do", ok: "moves any of your bots' figures", warns: false },
  /** The stage's: it tells the core which renderer drew a bot's figure, its names and its box. */
  { name: "avatar.report", lets: "Report which renderer draws a bot's figure, what its model has and where it stands (the stage's own)", ok: "tells Clover how your bots' figures look and where they stand, which other plugins and your bots then see", warns: true },
  { name: "notify", lets: "Send the user a notification through the notifiers", ok: "sends you notifications", warns: false },
  { name: "audio", lets: "Hear the user's push-to-talk audio to their bots, and play sound through the app (at any time, with no press from the user, even from a part kept in the background; the app's one mute covers it), including as the bots' voices", ok: "hears what you say to your bots with push-to-talk, and can play sound at any time, including as your bots' voices", warns: true },
  /** The user's microphone for a plugin's own frames: `getUserMedia({ audio: true })` works in a frame of a plugin that holds it,
   *  and in no other plugin's. The system's own question still applies (the first time, on a Mac). Push-to-talk to the bots is
   *  `audio`'s, not this. */
  { name: "microphone", lets: "Open the user's microphone from its own frames (`getUserMedia({ audio: true })`), whenever its parts run, including a part kept in the background; the system's own permission still applies, and no other plugin's frame gets it", ok: "hears your microphone, also while no window of it shows", warns: true },
  /** The voice providers' endpoints (`voices.*`, §6.6): their audio or text back as the plugin's own data (a narration
   *  track, a transcript). A voice mode has it by being one. Nothing sounds through it: the player is the active
   *  voice mode's alone. */
  { name: "voices.use", lets: "Ask the voice providers (`voices` entries) to speak text or transcribe audio, getting the audio or text back", ok: "can ask your voice providers to speak or transcribe, which may use your accounts with them", warns: true },
  { name: "call:<plugin-id>", lets: "Run that plugin's commands", ok: "runs commands of {plugin}", warns: false },
  /** Lane A's web plugin (WebFetch): any public host, through the core's fetch with the web floors (public addresses
   *  only, the dangerous-domain list, a private address refused with no card, the audit log). Its components get no host from
   *  it. */
  { name: "network:public", lets: "Reach any public host through the core's fetch, with its web floors: public addresses only (a private address is refused, with no card to allow it), the dangerous-domain list, size and time caps, no key, and the audit log; its components reach no host from it", ok: "connects to any public website, through Clover's web safeguards, so what you or your bots give it can leave your computer", warns: true },
  { name: "network:<host>", lets: "Reach that host through the core's fetch, which adds the plugin's own keys and tokens, and from the plugin's components, which reach no other host", ok: "connects to {host}", warns: false },
];

/** What holding a capability also gives: `avatar.control.all` is `avatar.control` for every bot, so a plugin that
 *  declares only the first still has `avatar.cue`. The router reads a plugin's grants through `withImplied`. */
export const IMPLIED_CAPABILITIES: Readonly<Record<string, readonly string[]>> = { "avatar.control.all": ["avatar.control"] };

/** `granted` and the capabilities they imply. */
export function withImplied(granted: readonly string[]): readonly string[] {
  const extra = granted.flatMap((c) => IMPLIED_CAPABILITIES[c] ?? []).filter((c) => !granted.includes(c));
  return extra.length === 0 ? granted : [...granted, ...extra];
}

/** Whether a plugin may reach any public host (`network:public`) through the core's fetch, which applies the web floors;
 *  `networkAllows` stays the allowlist for every other host. */
export function reachesPublicNetwork(capabilities: readonly string[]): boolean {
  return capabilities.includes("network:public");
}

/** The capabilities that take no argument. */
export const FIXED_CAPABILITIES: readonly string[] = CAPABILITIES.map((c) => c.name).filter((n) => !n.includes("<"));

export type ParsedCapability =
  | { kind: "fixed"; name: string }
  | { kind: "call"; plugin: string }
  /** `settings`: the setting keys the host names (`${setting:<key>}`, whole labels); the host then comes from them. */
  | { kind: "network"; host: string; port?: number; wildcard: boolean; settings?: readonly string[] };

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

/** Shared-hosting suffixes, from the Public Suffix List's private section (#187's review): anyone can get a name under
 *  them, so a host whose setting label sits under one would reach every tenant's site. A `${setting:}` host is refused
 *  there. */
export const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  "github.io", "gitlab.io", "codeberg.page", "workers.dev", "pages.dev", "r2.dev", "trycloudflare.com", "vercel.app",
  "now.sh", "netlify.app", "netlify.com", "herokuapp.com", "herokudns.com", "appspot.com", "web.app", "firebaseapp.com",
  "cloudfront.net", "azurewebsites.net", "azurestaticapps.net", "cloudapp.net", "trafficmanager.net", "blogspot.com",
  "wordpress.com", "glitch.me", "onrender.com", "fly.dev", "deno.dev", "railway.app", "up.railway.app", "repl.co",
  "replit.app", "surge.sh", "ngrok.io", "ngrok-free.app", "ngrok.app", "loca.lt", "s3.amazonaws.com",
  "elasticbeanstalk.com", "amplifyapp.com", "translate.goog", "run.app", "web.val.run", "neocities.org",
];

/** Whether `domain` is a shared-hosting suffix or a name under one. */
export function underSharedHosting(domain: string): boolean {
  const d = domain.toLowerCase();
  return SHARED_HOSTING_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`));
}

/** A label that names one of the plugin's settings (lane A's ask): `bedrock-runtime.${setting:region}.amazonaws.com`. */
const SETTING_LABEL_RE = /^\$\{setting:([A-Za-z][A-Za-z0-9_.-]{0,63})\}$/;
/** What a setting's value must be where a host names it: one DNS label, so a setting can't move the host elsewhere. */
export const SETTING_HOST_LABEL_RE = new RegExp(`^${LABEL}$`);

/** Parses `network:<host>`'s argument: a name (lowercase), an IPv4 address or a bracketed IPv6 address, with `:port`
 *  if needed, or `*.` and a domain of at least two labels for its subdomains (§5.4), never one that ends in a number
 *  (an address) or is a registry suffix such as `co.uk`. A name's labels may name the plugin's settings,
 *  `${setting:<key>}`, never its secrets (lane A's ask): the host then comes from its settings, at least the last two
 *  labels are fixed, and each setting's value must be one label at run time (`resolveNetworkHost`). */
export function parseNetworkHost(arg: string): { host: string; port?: number; wildcard: boolean; settings?: readonly string[] } | null {
  if (arg.includes("${")) return parseSettingHost(arg);
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

export function parseSettingHost(arg: string): { host: string; port?: number; wildcard: boolean; settings: readonly string[] } | null {
  let rest = arg;
  let port: number | undefined;
  const portMatch = /^(.*):(\d{1,5})$/.exec(rest);
  if (portMatch) {
    port = Number(portMatch[2]);
    if (port < 1 || port > 65535) return null;
    rest = portMatch[1]!;
  }
  const labels = rest.split(".");
  const settings: string[] = [];
  for (const label of labels) {
    const m = SETTING_LABEL_RE.exec(label);
    if (m) settings.push(m[1]!);
    else if (!new RegExp(`^${LABEL}$`).test(label)) return null;
  }
  // The domain stays the plugin's: its last two labels are fixed names, and not a registry suffix.
  if (settings.length === 0 || labels.length < 3) return null;
  const fixed = labels.slice(-2);
  if (fixed.some((l) => SETTING_LABEL_RE.test(l)) || wildcardTooWide(fixed.join("."))) return null;
  // Nor under a shared-hosting suffix: the labels after the last setting are the plugin's own domain.
  const lastSetting = labels.map((l) => SETTING_LABEL_RE.test(l)).lastIndexOf(true);
  if (underSharedHosting(labels.slice(lastSetting + 1).join("."))) return null;
  return { host: rest, wildcard: false, settings, ...(port !== undefined ? { port } : {}) };
}

/** A `network:` host with its settings filled in; undefined when a setting is unset or isn't one DNS label. */
export function resolveNetworkHost(host: string, setting: (key: string) => string | undefined): string | undefined {
  let bad = false;
  const out = host.split(".").map((label) => {
    const m = SETTING_LABEL_RE.exec(label);
    if (!m) return label;
    const v = setting(m[1]!)?.toLowerCase();
    if (v === undefined || !SETTING_HOST_LABEL_RE.test(v)) bad = true;
    return v ?? "";
  }).join(".");
  return bad ? undefined : out;
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
 *  itself; a host given without a port matches the URL scheme's default port only. A host that names settings counts
 *  with `setting`'s values filled in, and never without them. */
export function networkAllows(capabilities: readonly string[], host: string, port?: number, setting?: (key: string) => string | undefined): boolean {
  const h = host.toLowerCase();
  for (const cap of capabilities) {
    const p = parseCapability(cap);
    if (!p || p.kind !== "network") continue;
    if (p.port !== undefined ? p.port !== port : port !== undefined) continue;
    const declared = p.settings ? (setting ? resolveNetworkHost(p.host, setting) : undefined) : p.host;
    if (declared === undefined) continue;
    if (p.wildcard ? h.endsWith(`.${declared}`) : h === declared) return true;
  }
  return false;
}

/** The OK's phrase for a capability, in English. */
export function capabilityOkText(text: string): string | null {
  const p = parseCapability(text);
  if (!p) return null;
  if (p.kind === "call") return `runs commands of ${p.plugin}`;
  if (p.kind === "network") {
    const host = p.host.replace(/\$\{setting:([^}]+)\}/g, "<$1>");
    return `connects to ${p.wildcard ? "*." : ""}${host}${p.port !== undefined ? `:${p.port}` : ""}${p.settings ? " (from its settings)" : ""}`;
  }
  return CAPABILITIES.find((c) => c.name === p.name)!.ok;
}
