// Hetzner Cloud's API (https://docs.hetzner.cloud), as the provider needs it: servers made from Ubuntu with Clover's
// cloud-init, resized (off, change type, on), deleted, and read back. Every request goes through the fetch it is
// given, which is the core's keyed fetch: the core adds the user's token and reaches only api.hetzner.cloud.

export const HETZNER_API = "https://api.hetzner.cloud/v1";
/** Ubuntu's current LTS, which the official image's cloud-init expects. */
export const DEFAULT_IMAGE = "ubuntu-24.04";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Action { id: number; status: "running" | "success" | "error"; error?: { code: string; message: string } }
export interface Server { id: number; name?: string; status: string; labels?: Record<string, string>; server_type?: { name?: string }; datacenter?: { location?: { name?: string } }; public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null } }

/** The label every Clover VM carries, with its folder's id (the core's `CLOUD_LABEL`). */
export const LABEL = "clover-computer";

export class HetznerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class HetznerClient {
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #actionWaitMs: number;

  constructor(o: { fetch: Fetch; sleep?: (ms: number) => Promise<void>; actionWaitMs?: number }) {
    this.#fetch = o.fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#actionWaitMs = o.actionWaitMs ?? 10 * 60 * 1000;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${HETZNER_API}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const e = (json.error ?? {}) as { code?: string; message?: string };
      throw new HetznerError(res.status, e.code ?? "unknown", e.message ?? `Hetzner answered ${res.status}`);
    }
    return json as T;
  }

  /** Waits for an action to finish; its error, if it failed. */
  async waitFor(action: Action | undefined): Promise<void> {
    if (!action) return;
    const until = Date.now() + this.#actionWaitMs;
    let a = action;
    for (let delay = 500; a.status === "running"; delay = Math.min(delay * 2, 5000)) {
      if (Date.now() > until) throw new HetznerError(504, "timeout", `Hetzner's action ${a.id} didn't finish`);
      await this.#sleep(delay);
      a = (await this.#call<{ action: Action }>("GET", `/actions/${a.id}`)).action;
    }
    if (a.status === "error") throw new HetznerError(500, a.error?.code ?? "action_failed", a.error?.message ?? `Hetzner's action ${a.id} failed`);
  }

  async createServer(o: { name: string; serverType: string; location: string; image?: string; userData: string; label: string }): Promise<{ id: string; ipv4?: string }> {
    const r = await this.#call<{ server: Server; action?: Action }>("POST", "/servers", {
      name: o.name, server_type: o.serverType, location: o.location, image: o.image ?? DEFAULT_IMAGE,
      user_data: o.userData, start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
      labels: { [LABEL]: o.label },
    });
    const ip = r.server.public_net?.ipv4?.ip;
    return { id: String(r.server.id), ...(ip ? { ipv4: ip } : {}) };
  }

  /** The servers with the label: with that value, or any. Every page. */
  async listServers(label?: string): Promise<Server[]> {
    const selector = encodeURIComponent(label === undefined ? LABEL : `${LABEL}==${label}`);
    const out: Server[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const r: { servers: Server[]; meta?: { pagination?: { next_page?: number | null } } } = await this.#call("GET", `/servers?label_selector=${selector}&per_page=50&page=${page}`);
      out.push(...r.servers);
      page = r.meta?.pagination?.next_page ?? null;
    }
    return out;
  }

  async getServer(id: string): Promise<Server | null> {
    try {
      return (await this.#call<{ server: Server }>("GET", `/servers/${encodeURIComponent(id)}`)).server;
    } catch (e) {
      if (e instanceof HetznerError && e.status === 404) return null;
      throw e;
    }
  }

  /** A new server type: Hetzner changes it only while the server is off, so it is turned off and on again. The disk
   *  keeps its size, so the server can be made smaller again later. */
  async changeType(id: string, serverType: string): Promise<void> {
    const sid = encodeURIComponent(id);
    await this.waitFor((await this.#call<{ action: Action }>("POST", `/servers/${sid}/actions/poweroff`)).action);
    await this.waitFor((await this.#call<{ action: Action }>("POST", `/servers/${sid}/actions/change_type`, { server_type: serverType, upgrade_disk: false })).action);
    await this.waitFor((await this.#call<{ action: Action }>("POST", `/servers/${sid}/actions/poweron`)).action);
  }

  async deleteServer(id: string): Promise<void> {
    try {
      await this.waitFor((await this.#call<{ action?: Action }>("DELETE", `/servers/${encodeURIComponent(id)}`)).action);
    } catch (e) {
      if (e instanceof HetznerError && e.status === 404) return; // gone already
      throw e;
    }
  }
}
