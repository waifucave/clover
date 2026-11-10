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
// The coordinator's ruling for when the model plugins' code adapters ride `net.fetch` (`serveCodeAdapters`, off until
// then: the bundled code adapters run in process, which is how a user's local endpoint works today). Not built yet:
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

/** A plugin's request reaching an address it may not: never sent. */
export class PinnedFetchRefused extends Error {
  override readonly name = "PinnedFetchRefused";
}

/** A connect that failed before anything was exchanged (the next address may answer). */
function unreachable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["ConnectionRefused", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "FailedToOpenSocket"].includes(code);
}

export function pinnedFetch(seam: PinnedFetchSeam = {}): PlatformFetch {
  const resolve = seam.resolve ?? systemResolve;
  const platform: PlatformFetch = seam.fetch ?? ((url, init) => fetch(url, init));
  const allowed = (host: string, address: string): boolean => ipAddressClass(address) === null || seam.reach?.(host, address) === true;
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
