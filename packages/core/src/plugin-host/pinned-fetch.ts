// The platform fetch the core's keyed `net.fetch` sends a plugin's requests with (spec §5.4 "The keyed fetch"), from
// lane B's parked #377 (`pinnedFetch` in its net-proxy.ts, #371's review item 6), stricter here: a plugin's request
// reaches only a public address.
//
// * A name is resolved once, here, and connected to by the address checked: no second lookup, so a name can't be
//   rebound to another address between the check and the connect. The name travels as the `Host` header and the TLS
//   server name, so certificates are still verified against it.
// * Every address it resolves to must be public: a loopback, private, link-local or otherwise reserved one
//   (`ipAddressClass`) refuses the request, whatever the name says (`localhost`, `*.local` included), and so does a
//   raw address in the URL. A plugin's own DNS record could otherwise point its declared host at this computer's or
//   the LAN's services.
// * Never through an environment proxy (`proxy: false`).
// * The keyed fetch follows redirects by hand, so every hop comes through here and is checked the same way.
// * The addresses are tried in the order resolved: when one can't be connected to (an IPv6 address on a network
//   without IPv6), the next, all of them checked. A streamed body can be sent only once, so it gets the first only.
//
// The coordinator's ruling for when the model plugins' code adapters ride `net.fetch` (`serveCodeAdapters`, now on),
// built in runtime-sdk/model-plugins/user-endpoint.ts (the origin), the model plugins' handler (plugin-api.ts: the
// keyed fetch to it, every hop held to it, through this fetch with `reach` naming its host) and B's gate (the router's
// `userEndpoint`):
// * A user pointing a provider at a local model server (loopback or their LAN) is a normal, supported use; this rule
//   must not break it.
// * The default stays strict: private, link-local and loopback addresses are refused, after a redirect and after DNS
//   resolution included.
// * The one exception: a destination the USER set for that provider in their own settings (the endpoint they typed,
//   as with `providers.<id>.baseUrl`). The daemon decides it from the user's settings, which it reads itself; nothing
//   in the plugin's request, its manifest or a tool result can turn it on. It applies to that provider's calls only,
//   pins the resolved address like any other, and is logged once per provider ("<provider>: the user's endpoint is on
//   this computer / the local network").
// * A plugin-declared `network:` host that resolves to a private address is still refused, and so is a redirect from
//   a public host to a private one, even for a provider whose user-set endpoint is local.
// * The bot editor's LAN switch (the person's own, off by default) is a separate thing, for bots' tools: not reused.
//
// `reach` is a test-only seam (`startDaemon`'s `pluginFetch`, which production never passes): it lets a test's backend
// on loopback be reached, and can stand in for the resolver and the platform fetch. Nothing else widens the rule.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipAddressClass } from "../agent/tools/web";

/** The addresses a name resolves to. */
export type ResolveHost = (host: string) => Promise<string[]>;
export type PlatformFetch = (url: string, init: RequestInit) => Promise<Response>;

const systemResolve: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The test-only seam (never passed in production). */
export interface PinnedFetchSeam {
  /** An address the rule refuses that this test may reach (its loopback backend). */
  reach?(host: string, address: string): boolean;
  resolve?: ResolveHost;
  fetch?: PlatformFetch;
}

/** A test build's names for the acceptance run's own outside world (called only from a test-marked branch): each
 *  `name=127.0.0.1:<port>` reaches the run's loopback server for that name (http, the name in the Host header), each
 *  `name=<address>` resolves the name to that address (a private one stays refused, as for any name). Entries are
 *  separated by `;`. Every other name resolves as it always does, and every rule of the pinned fetch holds for it:
 *  a private address (an IP literal or what a name resolves to) is refused. Undefined for no entry. */
export function mappedNamesSeam(spec: string | undefined): PinnedFetchSeam | undefined {
  if (spec === undefined || spec.trim() === "") return undefined;
  const loopback = new Map<string, number>();
  const addressOf = new Map<string, string>();
  for (const entry of spec.split(";")) {
    const m = /^\s*([a-z0-9.-]+)=([0-9a-f.:]+?)(?::(\d{1,5}))?\s*$/i.exec(entry);
    if (m === null) continue;
    const name = m[1]!.toLowerCase();
    if (m[2] === "127.0.0.1" && m[3] !== undefined) {
      const port = Number(m[3]);
      if (port > 0 && port < 65536) { loopback.set(name, port); addressOf.set(name, "127.0.0.1"); }
    } else if (isIP(m[2]!) !== 0 && m[3] === undefined && m[2] !== "127.0.0.1") addressOf.set(name, m[2]!);
  }
  if (addressOf.size === 0) return undefined;
  return {
    reach: (host, address) => address === "127.0.0.1" && loopback.has(host.toLowerCase()),
    resolve: async (host) => { const a = addressOf.get(host.toLowerCase()); return a !== undefined ? [a] : systemResolve(host); },
    fetch: (url, init) => {
      const u = new URL(url);
      const name = (new Headers(init.headers).get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
      const port = u.hostname === "127.0.0.1" ? loopback.get(name) : undefined;
      if (port === undefined) return fetch(url, init);
      u.protocol = "http:";
      u.port = String(port);
      const { tls: _tls, ...rest } = init as RequestInit & { tls?: unknown };
      return fetch(u.toString(), rest);
    },
  };
}

/** A plugin's request reaching an address it may not: never sent. */
export class PinnedFetchRefused extends Error {
  override readonly name = "PinnedFetchRefused";
}

/** A connect that failed before anything was exchanged (the next address may answer). */
function unreachable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["ConnectionRefused", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "FailedToOpenSocket"].includes(code);
}

/** Whether a host name says it is on this computer or its local network (spec §5.3): `localhost`, `*.localhost`,
 *  `*.local`. */
export function localHostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");
}

/** `localNames`: a name that says it is local (`localHostName`) may resolve to a loopback or private address, which it
 *  is then pinned to like any other (§5.3: "unless the name says it's local, whose grant the OK names"). Only a
 *  plugin's remote MCP server (`http-mcp.ts`), whose url the OK named, takes it; a raw private address stays refused. */
export function pinnedFetch(seam: PinnedFetchSeam = {}, opts: { localNames?: boolean } = {}): PlatformFetch {
  const resolve = seam.resolve ?? systemResolve;
  const platform: PlatformFetch = seam.fetch ?? ((url, init) => fetch(url, init));
  const allowed = (host: string, address: string): boolean =>
    ipAddressClass(address) === null || seam.reach?.(host, address) === true || (opts.localNames === true && isIP(host) === 0 && localHostName(host));
  return async (raw, init) => {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) {
      if (!allowed(host, host)) throw new PinnedFetchRefused(`${host} is a private address, which a plugin's fetch doesn't reach`);
      return platform(raw, { ...init, proxy: false } as RequestInit);
    }
    const addresses = await resolve(host);
    if (addresses.length === 0) throw new PinnedFetchRefused(`${host} resolves to no address`);
    const inside = addresses.find((a) => !allowed(host, a));
    if (inside !== undefined) throw new PinnedFetchRefused(`${host} resolves to ${inside}, a private address, which a plugin's fetch doesn't reach`);
    const headers = new Headers(init.headers);
    headers.set("Host", url.host);
    const once = init.body instanceof ReadableStream;
    let last: unknown;
    for (const address of once ? addresses.slice(0, 1) : addresses) {
      const pinned = new URL(url.toString());
      pinned.hostname = address.includes(":") ? `[${address}]` : address;
      try {
        return await platform(pinned.toString(), {
          ...init,
          headers,
          proxy: false,
          ...(url.protocol === "https:" ? { tls: { serverName: host } } : {}),
        } as RequestInit);
      } catch (err) {
        if (init.signal?.aborted === true || !unreachable(err)) throw err;
        last = err;
      }
    }
    throw last;
  };
}
