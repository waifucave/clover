// clover.waifucave.com: serves the web companion's page with the headers that keep it closed: a strict content
// security policy (its own scripts only, connections only to the handshake and WebRTC), no referrer, no framing.
// /config.json tells the page which handshake it uses.

interface Env {
  ASSETS: Fetcher;
  /** The handshake's origin, e.g. https://handshake.waifucave.com */
  HANDSHAKE_ORIGIN: string;
  /** Other handshake origins an invite may name, comma-separated: local emulators only, empty in production. */
  ALLOWED_HANDSHAKES?: string;
}

function security(env: Env): Record<string, string> {
  const handshake = new URL(env.HANDSHAKE_ORIGIN);
  const ws = `${handshake.protocol === "https:" ? "wss:" : "ws:"}//${handshake.host}`;
  const extra = (env.ALLOWED_HANDSHAKES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((o) => {
      const u = new URL(o);
      return [u.origin, `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`];
    });
  return {
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ${handshake.origin} ${ws} ${extra.join(" ")}`.trim(),
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    // Once seen over https, the browser never loads the page over plain http (a year; local http ignores it).
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = security(env);
    if (url.pathname === "/config.json") {
      const allowed = (env.ALLOWED_HANDSHAKES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return new Response(JSON.stringify({ handshake: env.HANDSHAKE_ORIGIN, ...(allowed.length ? { allowedHandshakes: allowed } : {}) }), {
        headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  },
} satisfies ExportedHandler<Env>;
