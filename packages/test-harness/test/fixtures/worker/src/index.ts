interface Env {
  WHO: string;
  STORE: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/who") return new Response(env.WHO);
    if (url.pathname.startsWith("/kv/")) {
      const key = url.pathname.slice(4);
      if (request.method === "PUT") {
        await env.STORE.put(key, await request.text());
        return new Response(null, { status: 204 });
      }
      const value = await env.STORE.get(key);
      return value === null ? new Response("missing", { status: 404 }) : new Response(value);
    }
    return new Response("not found", { status: 404 });
  },
};
