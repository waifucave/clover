// The Hetzner provider's host half (clover/provider-hetzner): the handler of its `computerProviders` entry
// (clover.json), which the core calls on the main computer after the user approves each card (spec §9.2). The shape
// is lane J's proposal for the point (`CloudProviderHandler` in the core's `computers/cloud.ts`).
//
// The plugin never holds the user's token: every request goes through the core's keyed fetch with the entry's `auth`,
// `hetzner-api-token`. A VM is made with the cloud-init the core hands over (Clover's official image) and gets no
// cloud credentials: Hetzner has no service accounts, and the image blocks the metadata address.
import { HetznerClient, HetznerError } from "../src/client";

export const HETZNER_SECRET = "hetzner-api-token";

/** What this handler uses of the plugin API (`HandlerContext` in the plugin SDK). */
export interface ProviderContext {
  readonly signal?: AbortSignal;
  readonly api: {
    readonly net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string | false }): Promise<Response> };
  };
}

const client = (ctx: ProviderContext, sleep?: (ms: number) => Promise<void>) => new HetznerClient({
  fetch: (url, init) => ctx.api.net.fetch(url, { ...init, ...(ctx.signal ? { signal: ctx.signal } : {}) }, { auth: HETZNER_SECRET }),
  ...(sleep ? { sleep } : {}),
});

/** Hetzner's names are hostnames: the computer's name, lower case. */
const hostname = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "clover";

const plain = (e: unknown): Error => (e instanceof HetznerError ? new Error(`Hetzner: ${e.message} (${e.code})`) : (e as Error));

export const provider = {
  async create(a: { name: string; size: string; region: string; image?: string; userData: string }, ctx: ProviderContext): Promise<{ serverId: string; address?: string }> {
    try {
      const s = await client(ctx).createServer({ name: hostname(a.name), serverType: a.size, location: a.region, ...(a.image ? { image: a.image } : {}), userData: a.userData });
      return { serverId: s.id, ...(s.ipv4 ? { address: s.ipv4 } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
  async resize(a: { serverId: string; region: string; size: string }, ctx: ProviderContext): Promise<void> {
    try {
      await client(ctx).changeType(a.serverId, a.size);
    } catch (e) {
      throw plain(e);
    }
  },
  async delete(a: { serverId: string; region: string }, ctx: ProviderContext): Promise<void> {
    try {
      await client(ctx).deleteServer(a.serverId);
    } catch (e) {
      throw plain(e);
    }
  },
  async status(a: { serverId: string; region: string }, ctx: ProviderContext): Promise<{ state: "creating" | "running" | "off" | "gone"; address?: string }> {
    const s = await client(ctx).getServer(a.serverId).catch((e) => { throw plain(e); });
    if (!s) return { state: "gone" };
    const ip = s.public_net?.ipv4?.ip;
    const state = s.status === "running" ? "running" : s.status === "off" ? "off" : s.status === "deleting" ? "gone" : "creating";
    return { state, ...(ip ? { address: ip } : {}) };
  },
};
