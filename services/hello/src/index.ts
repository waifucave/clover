// The layout's example Worker: a greeting, a request echo, and one Durable Object counter, so the harness's
// emulator is proven on a fetch handler, a variable and Durable Object storage.
export interface Env {
  GREETING: string;
  COUNTER: DurableObjectNamespace;
}

export class Counter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const next = ((await this.state.storage.get<number>("count")) ?? 0) + 1;
    await this.state.storage.put("count", next);
    return Response.json({ count: next });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.json({ service: "hello", greeting: env.GREETING });
    if (url.pathname === "/echo" && request.method === "POST") {
      return new Response(await request.text(), { headers: { "content-type": request.headers.get("content-type") ?? "text/plain" } });
    }
    if (url.pathname.startsWith("/count/")) {
      const name = decodeURIComponent(url.pathname.slice("/count/".length));
      return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
