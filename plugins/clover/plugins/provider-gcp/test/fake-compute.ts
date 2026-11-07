// A fake of the parts of Compute Engine's API the provider uses, in memory: instances with numeric ids and labels,
// the aggregated list filtered by label, a zone's list filtered by id, metadata with its fingerprint, zonal operations
// (running once, then done), and the rule that a machine type changes only while the instance is stopped. No network.
export interface FakeInstance {
  id: string;
  name: string;
  zone: string;
  machineType: string;
  status: string;
  labels: Record<string, string>;
  labelFingerprint: string;
  metadata: { fingerprint: string; items: { key: string; value?: string }[] };
  body: Record<string, unknown>;
}

export class FakeCompute {
  readonly instances = new Map<string, FakeInstance>();
  readonly requests: string[] = [];
  #op = 1;
  #id = 7_000_000_000_000_000_000n;
  #fp = 1;
  readonly #ops = new Map<string, { error?: string }>();

  constructor(readonly key: string, readonly project: string) {}

  #operation(error?: string) {
    const name = `operation-${this.#op++}`;
    this.#ops.set(name, error ? { error } : {});
    return { name, status: "RUNNING" };
  }

  #view(i: FakeInstance) {
    const base = `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${i.zone}`;
    return {
      id: i.id, name: i.name, status: i.status, zone: base, machineType: `${base}/machineTypes/${i.machineType.split("/").pop()}`,
      labels: i.labels, labelFingerprint: i.labelFingerprint, metadata: i.metadata, networkInterfaces: [{ accessConfigs: [{ natIP: "192.0.2.10" }] }],
    };
  }

  /** Adds an instance as if made elsewhere (by hand, or by another main). */
  add(o: { name: string; zone: string; machineType?: string; labels?: Record<string, string> }): FakeInstance {
    const i: FakeInstance = {
      id: String(++this.#id), name: o.name, zone: o.zone, machineType: `zones/${o.zone}/machineTypes/${o.machineType ?? "e2-small"}`, status: "RUNNING",
      labels: o.labels ?? {}, labelFingerprint: `lf-${this.#fp++}`, metadata: { fingerprint: `fp-${this.#fp++}`, items: [] }, body: {},
    };
    this.instances.set(i.name, i);
    return i;
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${u.pathname.replace(/^\/compute\/v1/, "")}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fail = (status: number, s: string, message: string) => reply(status, { error: { code: status, status: s, message } });
    if (u.host !== "compute.googleapis.com") return fail(400, "INVALID_ARGUMENT", "wrong host");
    if (new Headers(init.headers).get("authorization") !== `Bearer ${this.key}`) return fail(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    const agg = /^\/compute\/v1\/projects\/([^/]+)\/aggregated\/instances$/.exec(u.pathname);
    if (agg) {
      if (agg[1] !== this.project) return fail(404, "NOT_FOUND", "no project");
      const f = /^labels\.([a-z0-9_-]+):\*$/.exec(u.searchParams.get("filter") ?? "");
      const items: Record<string, { instances: unknown[] }> = {};
      for (const i of this.instances.values()) {
        if (f && !(f[1]! in i.labels)) continue;
        (items[`zones/${i.zone}`] ??= { instances: [] }).instances.push(this.#view(i));
      }
      return reply(200, { items });
    }
    const m = /^\/compute\/v1\/projects\/([^/]+)\/zones\/([^/]+)\/(instances|operations)(?:\/([^/]+))?(?:\/(\w+))?$/.exec(u.pathname);
    if (!m || m[1] !== this.project) return fail(404, "NOT_FOUND", `${u.pathname} not found`);
    const [, , zone, kind, name, verb] = m;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (kind === "operations") {
      const op = this.#ops.get(name!);
      if (!op) return fail(404, "NOT_FOUND", "no operation");
      return reply(200, { name, status: "DONE", ...(op.error ? { error: { errors: [{ code: op.error, message: op.error }] } } : {}) });
    }
    if (!name && method === "GET") {
      const id = /^id = (\d+)$/.exec(u.searchParams.get("filter") ?? "")?.[1];
      const items = [...this.instances.values()].filter((i) => i.zone === zone && (id === undefined || i.id === id)).map((i) => this.#view(i));
      return reply(200, items.length ? { items } : {});
    }
    if (!name && method === "POST") {
      const n = String(body.name);
      if (this.instances.has(n)) return fail(409, "ALREADY_EXISTS", `${n} exists`);
      const i = this.add({ name: n, zone: zone!, labels: (body.labels ?? {}) as Record<string, string> });
      i.machineType = String(body.machineType);
      i.metadata.items = ((body.metadata as { items?: { key: string; value: string }[] })?.items ?? []).map((x) => ({ ...x }));
      i.body = body;
      return reply(200, this.#operation());
    }
    const i = this.instances.get(name ?? "");
    if (!i || i.zone !== zone) return fail(404, "NOT_FOUND", `The resource '${name}' was not found`);
    if (!verb && method === "GET") return reply(200, this.#view(i));
    if (!verb && method === "DELETE") { this.instances.delete(i.name); return reply(200, this.#operation()); }
    if (verb === "stop") { i.status = "TERMINATED"; return reply(200, this.#operation()); }
    if (verb === "start") { i.status = "RUNNING"; return reply(200, this.#operation()); }
    if (verb === "setMachineType") {
      if (i.status !== "TERMINATED") return fail(400, "FAILED_PRECONDITION", "The instance must be stopped");
      i.machineType = String(body.machineType);
      return reply(200, this.#operation());
    }
    if (verb === "setLabels") {
      if (body.labelFingerprint !== i.labelFingerprint) return fail(412, "CONDITION_NOT_MET", "Labels fingerprint either invalid or resource labels have changed");
      i.labels = (body.labels ?? {}) as Record<string, string>;
      i.labelFingerprint = `lf-${this.#fp++}`;
      return reply(200, this.#operation());
    }
    if (verb === "setMetadata") {
      if (body.fingerprint !== i.metadata.fingerprint) return fail(412, "CONDITION_NOT_MET", "Supplied fingerprint does not match current metadata fingerprint.");
      i.metadata = { fingerprint: `fp-${this.#fp++}`, items: (body.items ?? []) as { key: string; value?: string }[] };
      return reply(200, this.#operation());
    }
    return fail(404, "NOT_FOUND", `${method} ${u.pathname}`);
  };
}
