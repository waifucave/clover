// The user's own endpoint for a bundled model plugin's provider (the coordinator's ruling in plugin-host/
// pinned-fetch.ts): when the USER's settings set `providers.<id>.baseUrl`, that provider's plugin reaches exactly that
// origin (scheme, host and port), a loopback or private address included, instead of its declared hosts. Owner: lane
// A.
//
// * Only a bundled model plugin (`clover/model-<provider>`) and only its own provider's setting: nothing in the
//   plugin's request, its manifest or a tool result names the endpoint. A third party's plugin has none.
// * Read from the settings at each call, so a change needs no restart.
// * B's gate lets the plugin's `net.fetch` reach that origin (`userEndpoint` on the router), and the model plugins'
//   handler sends it there with the plugin's own key (`plugin-api.ts`), every hop held to that origin.
import type { PluginRecord } from "../../contracts/plugin-registry";
import { providerBaseUrlFor, type Settings } from "../../settings";
import { bundledModelProviderOf } from "./keychain-tokens";

/** A URL's origin (`https://host[:port]`, lowercase, the scheme's default port left out), or undefined. */
export function originOf(raw: unknown): string | undefined {
  try {
    const u = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : "");
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The origin the user set for a plugin's provider, or undefined (no setting, not a bundled model plugin, or a
 *  setting that isn't an http(s) URL). */
export function userEndpointOf(record: Pick<PluginRecord, "id" | "source" | "manifest"> | undefined, settings: Settings | null | undefined): string | undefined {
  const provider = bundledModelProviderOf(record);
  if (provider === undefined) return undefined;
  const base = providerBaseUrlFor(settings, provider);
  return base === undefined ? undefined : originOf(base);
}
