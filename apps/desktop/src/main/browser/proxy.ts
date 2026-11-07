// The browser's proxy setting (ruling R14; spec §12.1 "[P] The proxy"). Three choices:
//
// * off: every tab connects directly (the default);
// * the system's proxy: the OS's own configured servers, or its PAC file's URL, each read explicitly here (macOS
//   `scutil --proxy`, the Windows registry's Internet Settings, GNOME's or KDE's settings, else the `*_proxy`
//   environment). Never WPAD discovery: a system that only says "discover the proxy" gets no proxy, and never
//   Chromium's own `mode: "system"`, which would bring WPAD and the system's resolver in behind the filter's back;
// * an explicit http, https or socks proxy, with an optional list of hosts that go direct.
//
// Whatever the choice, the network filter (`network.ts`, R13) still checks every address first; this file only turns
// the setting into the routes the filter tries, for each connection. A PAC file is run by the host's own evaluator
// (in the app, Chromium's, in a session of its own that does nothing else; `pac`), never in this process.
//
// A proxy's password is a secret, and the setting never holds one: a URL with a user or password is refused. Plain
// Node, no Electron; the app's `apps/desktop/src/main/browser/proxy.ts` is a copy a test keeps identical.
import { isIP } from "node:net";
import type { Upstream, UpstreamRoutes, UrlKind } from "./network";

export type ProxyProtocol = "http" | "https" | "socks5" | "socks4";

/** The setting, as Settings stores it (`browser.proxy`). */
export type BrowserProxySetting =
  | { mode: "off" }
  | { mode: "system" }
  | { mode: "explicit"; /** `http://host:port`, `https://host:port`, `socks5://host:port` or `socks4://host:port`. */ url: string; /** Hosts that go direct (the bypass list's syntax below). */ bypass?: string[] };

export const DEFAULT_PROXY_SETTING: BrowserProxySetting = Object.freeze({ mode: "off" });

export interface ProxyServer {
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

/** What the OS says, read explicitly: its PAC file's URL, or its servers per kind of URL, and the hosts that bypass
 *  them. `discoveryOnly` marks a system that asks for WPAD discovery, which Clover never does. */
export interface SystemProxy {
  pacUrl?: string;
  servers: Partial<Record<"http" | "https" | "socks", ProxyServer>>;
  bypass: string[];
  /** Plain names (no dot) go direct: macOS's `ExcludeSimpleHostnames`, Windows' `<local>`. */
  bypassSimple?: boolean;
  discoveryOnly?: boolean;
}

const DEFAULT_PORTS: Record<ProxyProtocol, number> = { http: 80, https: 443, socks5: 1080, socks4: 1080 };

/** A proxy URL as the setting holds it: `http`, `https`, `socks5` (or `socks`/`socks5h`) or `socks4`, a host and an
 *  optional port, and nothing else (no user, no password, no path). Throws a sentence that says what's wrong. */
export function parseProxyUrl(url: string): ProxyServer {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url.slice(0, 200)}" isn't a proxy address: write it as http://host:port, https://host:port or socks5://host:port`);
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const protocol: ProxyProtocol | undefined = scheme === "http" ? "http" : scheme === "https" ? "https"
    : scheme === "socks5" || scheme === "socks" || scheme === "socks5h" ? "socks5" : scheme === "socks4" || scheme === "socks4a" ? "socks4" : undefined;
  if (protocol === undefined) throw new Error(`a proxy is http, https, socks5 or socks4, not ${scheme}`);
  if (u.username !== "" || u.password !== "") throw new Error("a proxy address in the browser's setting carries no user or password");
  if ((u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") throw new Error("a proxy address is a host and a port, with no path");
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (host === "") throw new Error("a proxy address needs a host");
  const port = u.port === "" ? DEFAULT_PORTS[protocol] : Number(u.port);
  return { protocol, host, port };
}

/** Checks a setting as it comes from Settings; throws a sentence that says what's wrong. */
export function checkProxySetting(raw: unknown): BrowserProxySetting {
  const s = raw as Partial<{ mode: string; url: unknown; bypass: unknown }> | null;
  if (s === null || typeof s !== "object") throw new Error("the browser's proxy setting is off, system or explicit");
  if (s.mode === "off") return { mode: "off" };
  if (s.mode === "system") return { mode: "system" };
  if (s.mode !== "explicit") throw new Error("the browser's proxy setting is off, system or explicit");
  if (typeof s.url !== "string" || s.url.length > 2048) throw new Error("an explicit proxy needs its address");
  parseProxyUrl(s.url);
  const bypass = s.bypass === undefined ? undefined : s.bypass;
  if (bypass !== undefined && (!Array.isArray(bypass) || bypass.length > 256 || bypass.some((b) => typeof b !== "string" || b.length === 0 || b.length > 256))) {
    throw new Error("a proxy's bypass list is up to 256 hosts or address ranges");
  }
  return { mode: "explicit", url: s.url, ...(bypass !== undefined ? { bypass: bypass as string[] } : {}) };
}

// -----------------------------------------------------------------------------------------------
// Bypass rules
// -----------------------------------------------------------------------------------------------

/** Whether `host` (a name or an address, as the page asked for it) matches a bypass entry. The entries take the
 *  forms the three OSes write: `example.com` (that host), `.example.com` and `*.example.com` (its subdomains, and
 *  itself for the leading dot), `*` (everything), `*foo*` wildcards, an address, an address range (`10.0.0.0/8`, or
 *  macOS's `169.254/16`), `<local>` (plain names with no dot) and an optional `:port`. */
export function bypassMatches(entries: readonly string[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  for (const raw of entries) {
    let e = raw.trim().toLowerCase();
    if (e === "") continue;
    if (e === "<local>") {
      if (!h.includes(".") && !h.includes(":")) return true;
      continue;
    }
    if (e === "<-loopback>") continue;
    // A trailing :port on a name or an IPv4 entry (an IPv6 one in brackets).
    const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(e);
    if (portMatch !== null) {
      if (Number(portMatch[2]) !== port) continue;
      e = portMatch[1]!;
    }
    e = e.replace(/^\[|\]$/g, "");
    if (e.includes("/")) {
      if (inRange(h, e)) return true;
      continue;
    }
    if (e === "*") return true;
    if (e.startsWith(".")) {
      if (h === e.slice(1) || h.endsWith(e)) return true;
      continue;
    }
    if (e.includes("*")) {
      const re = new RegExp(`^${e.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      if (re.test(h)) return true;
      continue;
    }
    if (h === e) return true;
  }
  return false;
}

function v4Number(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined;
  while (parts.length < 4) parts.push("0");
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** `ip` inside `range` (`a.b.c.d/n`, a short IPv4 like `169.254/16`, or an IPv6 `prefix/n`). */
function inRange(ip: string, range: string): boolean {
  const [base, bitsText] = range.split("/") as [string, string];
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0) return false;
  if (isIP(ip) === 4) {
    const a = v4Number(ip);
    const b = v4Number(base);
    if (a === undefined || b === undefined || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  if (isIP(ip) === 6 && isIP(base) === 6) {
    const a = v6Bits(ip);
    const b = v6Bits(base);
    if (a === undefined || b === undefined || bits > 128) return false;
    return a.slice(0, bits) === b.slice(0, bits);
  }
  return false;
}

function v6Bits(ip: string): string | undefined {
  const s = ip.split("%")[0]!;
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const part = (p: string) => (p === "" ? [] : p.split(":"));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16).toString(2).padStart(16, "0")).join("");
}

// -----------------------------------------------------------------------------------------------
// PAC answers
// -----------------------------------------------------------------------------------------------

/** A PAC answer (`PROXY host:port; SOCKS5 host:port; DIRECT`, as `FindProxyForURL` and Chromium's `resolveProxy`
 *  give it) as routes. Entries Clover can't follow (QUIC) are skipped; an answer with none left refuses. */
export function parsePacResult(result: string): Upstream[] {
  const routes: Upstream[] = [];
  for (const entry of result.split(";")) {
    const [word, where] = entry.trim().split(/\s+/, 2) as [string, string | undefined];
    const kind = word.toUpperCase();
    if (kind === "DIRECT") {
      routes.push({ kind: "direct" });
      continue;
    }
    const protocol: ProxyProtocol | undefined = kind === "PROXY" || kind === "HTTP" ? "http" : kind === "HTTPS" ? "https"
      : kind === "SOCKS" || kind === "SOCKS5" ? "socks5" : kind === "SOCKS4" ? "socks4" : undefined;
    if (protocol === undefined || where === undefined) continue;
    const server = hostAndPort(where, DEFAULT_PORTS[protocol]);
    if (server !== undefined) routes.push({ kind: protocol, ...server });
  }
  return routes;
}

function hostAndPort(text: string, defaultPort: number): { host: string; port: number } | undefined {
  const t = text.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6 !== null) return { host: v6[1]!, port: v6[2] !== undefined ? Number(v6[2]) : defaultPort };
  const m = /^([^:\s]+)(?::(\d+))?$/.exec(t);
  if (m === null) return undefined;
  const port = m[2] !== undefined ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: m[1]!, port } : undefined;
}

// -----------------------------------------------------------------------------------------------
// Reading the system's proxy
// -----------------------------------------------------------------------------------------------

/** Runs a command and gives its standard output, or throws (a missing tool, a failure). The app passes Node's
 *  `execFile`; the daemon spawns through Bun's own spawn (S7's Linux rule). */
export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

export interface SystemProxyReaderOptions {
  platform: NodeJS.Platform;
  run: RunCommand;
  env: Record<string, string | undefined>;
}

const NONE: SystemProxy = Object.freeze({ servers: {}, bypass: [] }) as SystemProxy;

/** The system's proxy, read explicitly from where each OS keeps it. Anything that can't be read is no proxy. */
export async function readSystemProxy(o: SystemProxyReaderOptions): Promise<SystemProxy> {
  try {
    if (o.platform === "darwin") return parseScutil(await o.run("/usr/sbin/scutil", ["--proxy"]));
    if (o.platform === "win32") {
      const out = await o.run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
      return parseWindowsInternetSettings(out);
    }
    const desktop = (o.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
    if (/gnome|unity|cinnamon|budgie|pantheon|mate|xfce/.test(desktop)) {
      const gnome = await readGnome(o.run).catch(() => undefined);
      if (gnome !== undefined) return gnome;
    } else if (desktop.includes("kde")) {
      const kde = await readKde(o.run, o.env).catch(() => undefined);
      if (kde !== undefined) return kde;
    }
    return parseProxyEnv(o.env);
  } catch {
    return { ...NONE };
  }
}

/** macOS: `scutil --proxy`'s dictionary. */
export function parseScutil(out: string): SystemProxy {
  const value = (key: string): string | undefined => new RegExp(`^\\s*${key} : (.*)$`, "m").exec(out)?.[1]?.trim();
  const on = (key: string) => value(key) === "1";
  const server = (prefix: string, protocol: ProxyProtocol): ProxyServer | undefined => {
    if (!on(`${prefix}Enable`)) return undefined;
    const host = value(`${prefix}Proxy`);
    const port = Number(value(`${prefix}Port`) ?? DEFAULT_PORTS[protocol]);
    return host !== undefined && host !== "" && port > 0 && port < 65536 ? { protocol, host, port } : undefined;
  };
  const bypass: string[] = [];
  const list = /ExceptionsList : <array> \{([\s\S]*?)\}/.exec(out)?.[1] ?? "";
  for (const line of list.split("\n")) {
    const m = /^\s*\d+ : (.+)$/.exec(line);
    if (m !== null) bypass.push(m[1]!.trim());
  }
  const pac = on("ProxyAutoConfigEnable") ? value("ProxyAutoConfigURLString") : undefined;
  const servers: SystemProxy["servers"] = {};
  const http = server("HTTP", "http");
  const https = server("HTTPS", "http");
  const socks = server("SOCKS", "socks5");
  if (http !== undefined) servers.http = http;
  if (https !== undefined) servers.https = https;
  if (socks !== undefined) servers.socks = socks;
  return {
    ...(pac !== undefined && pac !== "" ? { pacUrl: pac } : {}),
    servers, bypass,
    ...(on("ExcludeSimpleHostnames") ? { bypassSimple: true } : {}),
    ...(on("ProxyAutoDiscoveryEnable") && pac === undefined && Object.keys(servers).length === 0 ? { discoveryOnly: true } : {}),
  };
}

/** Windows: `reg query` of the user's Internet Settings (`ProxyEnable`, `ProxyServer`, `ProxyOverride`,
 *  `AutoConfigURL`). The "detect settings automatically" flag is WPAD, which Clover never follows. */
export function parseWindowsInternetSettings(out: string): SystemProxy {
  const value = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi").exec(out)?.[1]?.trim();
  const pac = value("AutoConfigURL");
  const enabled = /^0x0*1$/i.test(value("ProxyEnable") ?? "");
  const servers: SystemProxy["servers"] = {};
  let bypass: string[] = [];
  let bypassSimple = false;
  if (enabled) {
    const spec = value("ProxyServer") ?? "";
    if (spec.includes("=")) {
      for (const part of spec.split(";")) {
        const [scheme, where] = part.split("=", 2) as [string, string | undefined];
        if (where === undefined) continue;
        const k = scheme.trim().toLowerCase();
        const protocol: ProxyProtocol = k === "socks" ? "socks4" : "http";
        const s = serverFrom(where, protocol);
        if (s === undefined) continue;
        if (k === "http") servers.http = s;
        else if (k === "https") servers.https = s;
        else if (k === "socks") servers.socks = s;
      }
    } else if (spec !== "") {
      const s = serverFrom(spec, "http");
      if (s !== undefined) {
        servers.http = s;
        servers.https = s;
      }
    }
    for (const entry of (value("ProxyOverride") ?? "").split(";")) {
      const e = entry.trim();
      if (e === "") continue;
      if (e.toLowerCase() === "<local>") bypassSimple = true;
      else bypass.push(e);
    }
  }
  bypass = bypass.filter((b) => b !== "");
  return { ...(pac !== undefined && pac !== "" ? { pacUrl: pac } : {}), servers, bypass, ...(bypassSimple ? { bypassSimple } : {}) };
}

/** `host:port` or a URL (`socks5://host:port`), as the OSes and the environment write a server. */
function serverFrom(text: string, fallback: ProxyProtocol): ProxyServer | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.username !== "" || u.password !== "") return undefined; // a password in the environment: never used
      const scheme = u.protocol.slice(0, -1).toLowerCase();
      const protocol: ProxyProtocol = scheme === "https" ? "https" : scheme.startsWith("socks4") ? "socks4" : scheme.startsWith("socks") ? "socks5" : "http";
      const host = u.hostname.replace(/^\[|\]$/g, "");
      return host === "" ? undefined : { protocol, host, port: u.port === "" ? DEFAULT_PORTS[protocol] : Number(u.port) };
    } catch {
      return undefined;
    }
  }
  const hp = hostAndPort(t, DEFAULT_PORTS[fallback]);
  return hp === undefined ? undefined : { protocol: fallback, ...hp };
}

/** The `http_proxy`, `https_proxy`, `all_proxy` and `no_proxy` environment (either case), as Chromium reads it on a
 *  Linux desktop it doesn't know. */
export function parseProxyEnv(env: Record<string, string | undefined>): SystemProxy {
  const get = (k: string) => env[k] ?? env[k.toUpperCase()];
  const servers: SystemProxy["servers"] = {};
  const all = get("all_proxy");
  const http = serverFrom(get("http_proxy") ?? "", "http");
  const https = serverFrom(get("https_proxy") ?? "", "http");
  const socks = all !== undefined ? serverFrom(all, "socks5") : undefined;
  if (http !== undefined) servers.http = http;
  if (https !== undefined) servers.https = https;
  if (socks !== undefined) servers.socks = socks;
  const bypass = (get("no_proxy") ?? "").split(/[,\s]+/).filter((b) => b !== "");
  return { servers, bypass };
}

async function readGnome(run: RunCommand): Promise<SystemProxy> {
  const g = async (schema: string, key: string) => (await run("gsettings", ["get", schema, key])).trim();
  const unquote = (v: string) => v.replace(/^'(.*)'$/, "$1");
  const mode = unquote(await g("org.gnome.system.proxy", "mode"));
  if (mode === "auto") {
    const pac = unquote(await g("org.gnome.system.proxy", "autoconfig-url"));
    // An empty URL in automatic mode means WPAD discovery: never.
    return pac === "" ? { servers: {}, bypass: [], discoveryOnly: true } : { pacUrl: pac, servers: {}, bypass: [] };
  }
  if (mode !== "manual") return { servers: {}, bypass: [] };
  const servers: SystemProxy["servers"] = {};
  for (const [kind, protocol] of [["http", "http"], ["https", "http"], ["socks", "socks5"]] as const) {
    const host = unquote(await g(`org.gnome.system.proxy.${kind}`, "host"));
    const port = Number(await g(`org.gnome.system.proxy.${kind}`, "port"));
    if (host !== "" && port > 0 && port < 65536) servers[kind] = { protocol, host, port };
  }
  const ignore = await g("org.gnome.system.proxy", "ignore-hosts");
  const bypass = [...ignore.matchAll(/'([^']*)'/g)].map((m) => m[1]!).filter((b) => b !== "");
  return { servers, bypass };
}

async function readKde(run: RunCommand, env: Record<string, string | undefined>): Promise<SystemProxy> {
  const tool = (env.KDE_SESSION_VERSION ?? "") === "5" ? "kreadconfig5" : "kreadconfig6";
  const k = async (key: string) => (await run(tool, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key])).trim();
  const type = Number(await k("ProxyType"));
  if (type === 2) {
    const pac = await k("Proxy Config Script");
    return pac === "" ? { servers: {}, bypass: [] } : { pacUrl: pac, servers: {}, bypass: [] };
  }
  if (type === 3) return { servers: {}, bypass: [], discoveryOnly: true };
  if (type === 4) return parseProxyEnv(env);
  if (type !== 1) return { servers: {}, bypass: [] };
  const servers: SystemProxy["servers"] = {};
  for (const [kind, key, protocol] of [["http", "httpProxy", "http"], ["https", "httpsProxy", "http"], ["socks", "socksProxy", "socks5"]] as const) {
    const v = (await k(key)).replace(/\s+(\d+)$/, ":$1");
    const s = serverFrom(v, protocol);
    if (s !== undefined) servers[kind] = s;
  }
  const bypass = (await k("NoProxyFor")).split(",").map((b) => b.trim()).filter((b) => b !== "");
  return { servers, bypass };
}

// -----------------------------------------------------------------------------------------------
// The routes
// -----------------------------------------------------------------------------------------------

export interface ProxyRoutesOptions {
  /** The system's proxy now (`readSystemProxy`); read again at most every `systemTtlMs` (10 s), and only while tabs
   *  connect, so an idle browser reads nothing. */
  readSystem?: () => Promise<SystemProxy>;
  systemTtlMs?: number;
  /** Runs the system's PAC file for a URL, giving its answer (`PROXY a:1; DIRECT`). Without one, a system that names
   *  a PAC file refuses every connection rather than go round the proxy the person set. */
  pac?: (pacUrl: string, url: string) => Promise<string>;
  now?: () => number;
  log?: (line: string) => void;
}

function asUpstream(s: ProxyServer): Upstream {
  return { kind: s.protocol, host: s.host, port: s.port };
}

/** The URL a connection stands for, as a PAC file is asked about it: Chromium sends a `https` URL's host and port
 *  only, and so does this. */
function pacUrlFor(scheme: UrlKind, host: string, port: number): string {
  const h = isIP(host) === 6 ? `[${host}]` : host;
  const s = scheme === "other" ? (port === 443 ? "https" : "http") : scheme;
  const defaultPort = s === "https" ? 443 : 80;
  return `${s}://${h}${port === defaultPort ? "" : `:${port}`}/`;
}

/** The filter's routes for a setting (`NetworkFilter.setUpstream`). Off gives undefined: direct. */
export function proxyRoutes(setting: BrowserProxySetting, o: ProxyRoutesOptions = {}): UpstreamRoutes | undefined {
  if (setting.mode === "off") return undefined;
  if (setting.mode === "explicit") {
    const server = asUpstream(parseProxyUrl(setting.url));
    const bypass = setting.bypass ?? [];
    return async ({ host, port }) => (bypassMatches(bypass, host, port) ? [{ kind: "direct" }] : [server]);
  }
  const now = o.now ?? Date.now;
  const ttl = o.systemTtlMs ?? 10_000;
  let cached: { at: number; value: Promise<SystemProxy> } | undefined;
  let warned = false;
  const system = (): Promise<SystemProxy> => {
    if (o.readSystem === undefined) return Promise.resolve({ ...NONE });
    if (cached === undefined || now() - cached.at > ttl) cached = { at: now(), value: o.readSystem().catch(() => ({ ...NONE })) };
    return cached.value;
  };
  return async ({ scheme, host, port }) => {
    const sys = await system();
    if (sys.discoveryOnly === true && !warned) {
      warned = true;
      o.log?.("browser proxy: the system asks for proxy discovery (WPAD), which Clover never does; tabs connect directly");
    }
    if ((sys.bypassSimple === true && !host.includes(".") && !host.includes(":")) || bypassMatches(sys.bypass, host, port)) return [{ kind: "direct" }];
    if (sys.pacUrl !== undefined) {
      if (o.pac === undefined) {
        o.log?.("browser proxy: the system names a PAC file, which this computer can't run; the connection is refused");
        return [];
      }
      return parsePacResult(await o.pac(sys.pacUrl, pacUrlFor(scheme, host, port)));
    }
    // As Chromium reads fixed servers: a URL's own scheme's server, else the SOCKS one; WebSockets the SOCKS one,
    // else the https server, else the http one.
    const chosen = scheme === "http" ? sys.servers.http ?? sys.servers.socks
      : scheme === "https" ? sys.servers.https ?? sys.servers.socks
      : sys.servers.socks ?? sys.servers.https ?? sys.servers.http;
    return chosen !== undefined ? [asUpstream(chosen)] : [{ kind: "direct" }];
  };
}
