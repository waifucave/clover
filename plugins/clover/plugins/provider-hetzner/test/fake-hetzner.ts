// A fake of the parts of Hetzner Cloud's API the provider uses, in memory: servers, their actions (running once, then
// done), and the rule that a server type changes only while the server is off. No network.
export class FakeHetzner {
  readonly servers = new Map<number, { id: number; name: string; server_type: string; location: string; image: string; user_data: string; status: string; ip: string; labels: Record<string, string> }>();
  readonly requests: string[] = [];
  readonly #actions = new Map<number, { polls: number; error?: string }>();
  #id = 100;
  #action = 1;

  constructor(readonly key: string) {}

  #act(error?: string) {
    const id = this.#action++;
    this.#actions.set(id, { polls: 0, ...(error ? { error } : {}) });
    return { id, status: "running" };
  }

  #view(s: { id: number; name: string; server_type: string; location: string; status: string; ip: string; labels: Record<string, string> }) {
    return {
      id: s.id, name: s.name, status: s.status === "initializing" ? "running" : s.status, labels: s.labels,
      server_type: { name: s.server_type }, datacenter: { location: { name: s.location } }, public_net: { ipv4: { ip: s.ip } },
    };
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${u.pathname}`);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
    if (u.host !== "api.hetzner.cloud") return fail(400, "bad_host", "wrong host");
    if (new Headers(init.headers).get("authorization") !== `Bearer ${this.key}`) return fail(401, "unauthorized", "unable to authenticate");
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if (method === "POST" && u.pathname === "/v1/servers") {
      if (typeof body.user_data !== "string" || !String(body.user_data).startsWith("#cloud-config")) return fail(422, "invalid_input", "user_data");
      const id = ++this.#id;
      const s = { id, name: String(body.name), server_type: String(body.server_type), location: String(body.location), image: String(body.image), user_data: String(body.user_data), status: "initializing", ip: `198.51.100.${id - 100}`, labels: (body.labels ?? {}) as Record<string, string> };
      this.servers.set(id, s);
      return reply(201, { server: { id, status: s.status, public_net: { ipv4: { ip: s.ip } } }, action: this.#act() });
    }
    if (method === "GET" && u.pathname === "/v1/servers") {
      // label_selector: `key` (has the key) or `key==value`; one page of `per_page`.
      const sel = u.searchParams.get("label_selector") ?? "";
      const [key, value] = sel.split("==");
      const all = [...this.servers.values()].filter((s) => !key || (key in s.labels && (value === undefined || s.labels[key] === value)));
      const per = Number(u.searchParams.get("per_page") ?? 25);
      const page = Number(u.searchParams.get("page") ?? 1);
      const slice = all.slice((page - 1) * per, page * per);
      return reply(200, { servers: slice.map((s) => this.#view(s)), meta: { pagination: { next_page: page * per < all.length ? page + 1 : null } } });
    }
    if ((m = /^\/v1\/actions\/(\d+)$/.exec(u.pathname))) {
      const a = this.#actions.get(Number(m[1]));
      if (!a) return fail(404, "not_found", "no action");
      a.polls++;
      return reply(200, { action: { id: Number(m[1]), status: a.error ? "error" : "success", ...(a.error ? { error: { code: a.error, message: a.error } } : {}) } });
    }
    if ((m = /^\/v1\/servers\/(\d+)(\/actions\/(\w+))?$/.exec(u.pathname))) {
      const s = this.servers.get(Number(m[1]));
      if (!s) return fail(404, "not_found", "server not found");
      const action = m[3];
      if (!action && method === "GET") return reply(200, { server: this.#view(s) });
      if (!action && method === "DELETE") {
        this.servers.delete(s.id);
        return reply(200, { action: this.#act() });
      }
      if (action === "poweroff") { s.status = "off"; return reply(201, { action: this.#act() }); }
      if (action === "poweron") { s.status = "running"; return reply(201, { action: this.#act() }); }
      if (action === "change_type") {
        if (s.status !== "off") return fail(409, "server_not_stopped", "server must be stopped");
        s.server_type = String(body.server_type);
        return reply(201, { action: this.#act() });
      }
    }
    return fail(404, "not_found", `${method} ${u.pathname}`);
  };
}
