// A fake of the parts of Compute Engine's API the provider uses, in memory: instances, zonal operations (running once,
// then done), and the rule that a machine type changes only while the instance is stopped. No network.
export class FakeCompute {
  readonly instances = new Map<string, { name: string; zone: string; machineType: string; status: string; body: Record<string, unknown> }>();
  readonly requests: string[] = [];
  #op = 1;
  readonly #ops = new Map<string, { error?: string }>();

  constructor(readonly key: string, readonly project: string) {}

  #operation(error?: string) {
    const name = `operation-${this.#op++}`;
    this.#ops.set(name, error ? { error } : {});
    return { name, status: "RUNNING" };
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${u.pathname.replace(/^\/compute\/v1/, "")}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fail = (status: number, s: string, message: string) => reply(status, { error: { code: status, status: s, message } });
    if (u.host !== "compute.googleapis.com") return fail(400, "INVALID_ARGUMENT", "wrong host");
    if (new Headers(init.headers).get("authorization") !== `Bearer ${this.key}`) return fail(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    const m = /^\/compute\/v1\/projects\/([^/]+)\/zones\/([^/]+)\/(instances|operations)(?:\/([^/]+))?(?:\/(\w+))?$/.exec(u.pathname);
    if (!m || m[1] !== this.project) return fail(404, "NOT_FOUND", `${u.pathname} not found`);
    const [, , zone, kind, name, verb] = m;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (kind === "operations") {
      const op = this.#ops.get(name!);
      if (!op) return fail(404, "NOT_FOUND", "no operation");
      return reply(200, { name, status: "DONE", ...(op.error ? { error: { errors: [{ code: op.error, message: op.error }] } } : {}) });
    }
    if (!name && method === "POST") {
      const n = String(body.name);
      if (this.instances.has(n)) return fail(409, "ALREADY_EXISTS", `${n} exists`);
      this.instances.set(n, { name: n, zone: zone!, machineType: String(body.machineType), status: "RUNNING", body });
      return reply(200, this.#operation());
    }
    const i = this.instances.get(name ?? "");
    if (!i) return fail(404, "NOT_FOUND", `The resource '${name}' was not found`);
    if (!verb && method === "GET") return reply(200, { name: i.name, status: i.status, networkInterfaces: [{ accessConfigs: [{ natIP: "192.0.2.10" }] }] });
    if (!verb && method === "DELETE") { this.instances.delete(i.name); return reply(200, this.#operation()); }
    if (verb === "stop") { i.status = "TERMINATED"; return reply(200, this.#operation()); }
    if (verb === "start") { i.status = "RUNNING"; return reply(200, this.#operation()); }
    if (verb === "setMachineType") {
      if (i.status !== "TERMINATED") return fail(400, "FAILED_PRECONDITION", "The instance must be stopped");
      i.machineType = String(body.machineType);
      return reply(200, this.#operation());
    }
    return fail(404, "NOT_FOUND", `${method} ${u.pathname}`);
  };
}
