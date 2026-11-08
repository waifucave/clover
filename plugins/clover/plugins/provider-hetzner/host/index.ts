// The Hetzner provider's host half (clover/provider-hetzner): the handler of its `computerProviders` entry
// (clover.json), which the core calls on the main computer after the user approves each card (spec §9.2). The shape
// is lane J's proposal for the point (`CloudProviderHandler` in the core's `computers/cloud.ts`).
//
// The plugin never holds the user's token: every request goes through the core's keyed fetch with the entry's `auth`,
// `hetzner-api-token`. A VM is made with the cloud-init the core hands over (Clover's official image) and gets no
// cloud credentials: Hetzner has no service accounts, and the image blocks the metadata address.
import { HetznerClient, HetznerError, LABEL, type Server } from "../src/client";

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

type State = "creating" | "running" | "off" | "gone";
const stateOf = (s: Server): State => (s.status === "running" ? "running" : s.status === "off" ? "off" : s.status === "deleting" ? "gone" : "creating");
const ipOf = (s: Server) => s.public_net?.ipv4?.ip;

/** The server with that id, when it carries that label; null when it is gone. One with another label (or none) is
 *  refused: the core never acts on a server by a bare id or name (#254). */
async function labelled(c: HetznerClient, serverId: string, label: string): Promise<Server | null> {
  if (!/^\d{1,20}$/.test(serverId)) throw new Error(`Hetzner: ${serverId} isn't a server id`);
  const s = await c.getServer(serverId);
  if (!s) return null;
  if (s.labels?.[LABEL] !== label) throw new Error(`Hetzner: server ${serverId} isn't the Clover computer ${label}; nothing was done`);
  return s;
}

export const provider = {
  async create(a: { name: string; size: string; region: string; image?: string; userData: string; label: string }, ctx: ProviderContext): Promise<{ serverId: string; address?: string }> {
    try {
      const s = await client(ctx).createServer({ name: hostname(a.name), serverType: a.size, location: a.region, ...(a.image ? { image: a.image } : {}), userData: a.userData, label: a.label });
      return { serverId: s.id, ...(s.ipv4 ? { address: s.ipv4 } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
  async list(a: { label?: string }, ctx: ProviderContext): Promise<{ serverId: string; label: string; region: string; size?: string; state: State; address?: string }[]> {
    try {
      return (await client(ctx).listServers(a.label)).filter((s) => typeof s.labels?.[LABEL] === "string").map((s) => {
        const ip = ipOf(s);
        return {
          serverId: String(s.id), label: s.labels![LABEL]!, region: s.datacenter?.location?.name ?? "",
          ...(s.server_type?.name ? { size: s.server_type.name } : {}), state: stateOf(s), ...(ip ? { address: ip } : {}),
        };
      });
    } catch (e) {
      throw plain(e);
    }
  },
  async resize(a: { serverId: string; label: string; region: string; size: string }, ctx: ProviderContext): Promise<void> {
    try {
      const c = client(ctx);
      if (!(await labelled(c, a.serverId, a.label))) throw new Error(`Hetzner: server ${a.serverId} is gone`);
      await c.changeType(a.serverId, a.size);
    } catch (e) {
      throw plain(e);
    }
  },
  async delete(a: { serverId: string; label: string; region: string }, ctx: ProviderContext): Promise<void> {
    try {
      const c = client(ctx);
      if (!(await labelled(c, a.serverId, a.label))) return; // gone already
      await c.deleteServer(a.serverId);
    } catch (e) {
      throw plain(e);
    }
  },
  async status(a: { serverId: string; label: string; region: string }, ctx: ProviderContext): Promise<{ state: State; address?: string }> {
    try {
      const s = await labelled(client(ctx), a.serverId, a.label);
      if (!s) return { state: "gone" };
      const ip = ipOf(s);
      return { state: stateOf(s), ...(ip ? { address: ip } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
  // No `paired`: Hetzner keeps a server's user-data and can't clear it. The token in it worked once and is spent.
};
