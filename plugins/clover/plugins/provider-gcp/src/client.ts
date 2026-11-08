// Compute Engine's API (https://cloud.google.com/compute/docs/reference/rest/v1), as the provider needs it: instances
// made from Ubuntu with Clover's cloud-init and no service account, resized (stop, set the machine type, start),
// deleted, and read back. Zonal operations are waited on. Every request goes through the fetch it is given, the core's
// keyed fetch, which adds the user's token and reaches only compute.googleapis.com.

export const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
/** Ubuntu's current LTS, which the official image's cloud-init expects. */
export const DEFAULT_IMAGE = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Operation { name: string; status: "PENDING" | "RUNNING" | "DONE"; error?: { errors?: { code?: string; message?: string }[] } }
export interface Instance {
  id?: string;
  name: string;
  status: string;
  zone?: string;
  machineType?: string;
  labels?: Record<string, string>;
  metadata?: { fingerprint?: string; items?: { key: string; value?: string }[] };
  networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[];
}

/** The label every Clover VM carries, with its folder's id (the core's `CLOUD_LABEL`). */
export const LABEL = "clover-computer";

export class GcpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const seg = (s: string) => encodeURIComponent(s);

export class ComputeClient {
  readonly #fetch: Fetch;
  readonly #project: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #waitMs: number;

  constructor(o: { fetch: Fetch; project: string; sleep?: (ms: number) => Promise<void>; waitMs?: number }) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(o.project)) throw new GcpError(400, "invalid_project", `${o.project} isn't a Google Cloud project ID`);
    this.#fetch = o.fetch;
    this.#project = o.project;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#waitMs = o.waitMs ?? 10 * 60 * 1000;
  }

  #zone(zone: string): string {
    if (!/^[a-z]+-[a-z]+\d+-[a-z]$/.test(zone)) throw new GcpError(400, "invalid_zone", `${zone} isn't a Compute Engine zone`);
    return `${COMPUTE_API}/projects/${seg(this.#project)}/zones/${seg(zone)}`;
  }

  async #call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const e = (json.error ?? {}) as { status?: string; message?: string };
      throw new GcpError(res.status, e.status ?? "unknown", e.message ?? `Google Cloud answered ${res.status}`);
    }
    return json as T;
  }

  async #wait(zone: string, op: Operation): Promise<void> {
    const until = Date.now() + this.#waitMs;
    let o = op;
    for (let delay = 500; o.status !== "DONE"; delay = Math.min(delay * 2, 5000)) {
      if (Date.now() > until) throw new GcpError(504, "timeout", `the operation ${o.name} didn't finish`);
      await this.#sleep(delay);
      o = await this.#call<Operation>("GET", `${this.#zone(zone)}/operations/${seg(o.name)}`);
    }
    const err = o.error?.errors?.[0];
    if (err) throw new GcpError(500, err.code ?? "operation_failed", err.message ?? `the operation ${o.name} failed`);
  }

  async insert(o: { name: string; zone: string; machineType: string; image?: string; userData: string; label: string }): Promise<void> {
    const op = await this.#call<Operation>("POST", `${this.#zone(o.zone)}/instances`, {
      name: o.name,
      machineType: `zones/${o.zone}/machineTypes/${o.machineType}`,
      disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: o.image ?? DEFAULT_IMAGE, diskSizeGb: "20" } }],
      networkInterfaces: [{ network: "global/networks/default", accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
      metadata: { items: [{ key: "user-data", value: o.userData }] },
      // No service account: nothing on the VM can act on the user's cloud (spec §9.2 "Safety").
      serviceAccounts: [],
      labels: { [LABEL]: o.label },
    });
    await this.#wait(o.zone, op);
  }

  async get(zone: string, name: string): Promise<Instance | null> {
    try {
      return await this.#call<Instance>("GET", `${this.#zone(zone)}/instances/${seg(name)}`);
    } catch (e) {
      if (e instanceof GcpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Every instance with the label, in every zone, every page. */
  async listLabelled(): Promise<Instance[]> {
    const out: Instance[] = [];
    const filter = encodeURIComponent(`labels.${LABEL}:*`);
    let token: string | undefined;
    do {
      const r: { items?: Record<string, { instances?: Instance[] }>; nextPageToken?: string } = await this.#call(
        "GET", `${COMPUTE_API}/projects/${seg(this.#project)}/aggregated/instances?filter=${filter}&maxResults=500${token ? `&pageToken=${seg(token)}` : ""}`,
      );
      for (const scope of Object.values(r.items ?? {})) out.push(...(scope.instances ?? []));
      token = r.nextPageToken;
    } while (token);
    return out;
  }

  /** The instance in `zone` with that numeric id; null when there is none. */
  async byId(zone: string, id: string): Promise<Instance | null> {
    if (!/^\d{1,20}$/.test(id)) throw new GcpError(400, "invalid_id", `${id} isn't an instance id`);
    const r = await this.#call<{ items?: Instance[] }>("GET", `${this.#zone(zone)}/instances?filter=${encodeURIComponent(`id = ${id}`)}`);
    return (r.items ?? []).find((i) => i.id === id) ?? null;
  }

  /** Removes a metadata key (the VM's `user-data`, once it has paired). */
  async removeMetadata(zone: string, name: string, key: string): Promise<void> {
    const i = await this.get(zone, name);
    if (!i) return;
    const items = (i.metadata?.items ?? []).filter((x) => x.key !== key);
    if (items.length === (i.metadata?.items ?? []).length) return;
    await this.#wait(zone, await this.#call<Operation>("POST", `${this.#zone(zone)}/instances/${seg(name)}/setMetadata`, { fingerprint: i.metadata?.fingerprint, items }));
  }

  /** A new machine type: Compute Engine changes it only while the instance is stopped. */
  async setMachineType(zone: string, name: string, machineType: string): Promise<void> {
    const base = `${this.#zone(zone)}/instances/${seg(name)}`;
    await this.#wait(zone, await this.#call<Operation>("POST", `${base}/stop`));
    await this.#wait(zone, await this.#call<Operation>("POST", `${base}/setMachineType`, { machineType: `zones/${zone}/machineTypes/${machineType}` }));
    await this.#wait(zone, await this.#call<Operation>("POST", `${base}/start`));
  }

  async delete(zone: string, name: string): Promise<void> {
    try {
      await this.#wait(zone, await this.#call<Operation>("DELETE", `${this.#zone(zone)}/instances/${seg(name)}`));
    } catch (e) {
      if (e instanceof GcpError && e.status === 404) return;
      throw e;
    }
  }
}
