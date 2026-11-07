// The Google Cloud provider's host half (clover/provider-gcp): the handler of its `computerProviders` entry
// (clover.json), which the core calls on the main computer after the user approves each card (spec §9.2). The shape
// is lane J's proposal for the point (`CloudProviderHandler` in the core's `computers/cloud.ts`). A computer's
// `region` is a Compute Engine zone, and its server id is the instance's name.
//
// The plugin never holds the user's token: every request goes through the core's keyed fetch with the entry's
// `auth`, `gcp-oauth`, the user's own sign-in. Instances get no service account.
import { ComputeClient, GcpError } from "../src/client";

export const GCP_SECRET = "gcp-oauth";

export interface ProviderContext {
  readonly signal?: AbortSignal;
  readonly api: {
    readonly net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string | false }): Promise<Response> };
    readonly settings: { get<T = unknown>(key: string): Promise<T | undefined> };
  };
}

async function client(ctx: ProviderContext): Promise<ComputeClient> {
  const project = await ctx.api.settings.get<string>("project");
  if (typeof project !== "string" || project === "") throw new Error("Google Cloud: set the project ID in the plugin's settings first");
  return new ComputeClient({
    project,
    fetch: (url, init) => ctx.api.net.fetch(url, { ...init, ...(ctx.signal ? { signal: ctx.signal } : {}) }, { auth: GCP_SECRET }),
  });
}

/** Compute Engine's names: lower case, a letter first. */
const instanceName = (name: string) => {
  const n = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 63);
  return n || "clover";
};

const plain = (e: unknown): Error => (e instanceof GcpError ? new Error(`Google Cloud: ${e.message} (${e.code})`) : (e as Error));

export const provider = {
  async create(a: { name: string; size: string; region: string; image?: string; userData: string }, ctx: ProviderContext): Promise<{ serverId: string; address?: string }> {
    try {
      const c = await client(ctx);
      const name = instanceName(a.name);
      await c.insert({ name, zone: a.region, machineType: a.size, ...(a.image ? { image: a.image } : {}), userData: a.userData });
      const ip = (await c.get(a.region, name))?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
      return { serverId: name, ...(ip ? { address: ip } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
  async resize(a: { serverId: string; region: string; size: string }, ctx: ProviderContext): Promise<void> {
    try {
      await (await client(ctx)).setMachineType(a.region, a.serverId, a.size);
    } catch (e) {
      throw plain(e);
    }
  },
  async delete(a: { serverId: string; region: string }, ctx: ProviderContext): Promise<void> {
    try {
      await (await client(ctx)).delete(a.region, a.serverId);
    } catch (e) {
      throw plain(e);
    }
  },
  async status(a: { serverId: string; region: string }, ctx: ProviderContext): Promise<{ state: "creating" | "running" | "off" | "gone"; address?: string }> {
    try {
      const i = await (await client(ctx)).get(a.region, a.serverId);
      if (!i) return { state: "gone" };
      const ip = i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
      const state = i.status === "RUNNING" ? "running" : i.status === "TERMINATED" || i.status === "STOPPED" || i.status === "SUSPENDED" ? "off" : "creating";
      return { state, ...(ip ? { address: ip } : {}) };
    } catch (e) {
      throw plain(e);
    }
  },
};
