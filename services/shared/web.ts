// What the services need to face a browser and the open internet: CORS for the web companion's origin alone, and a
// client's address as a rate-limit key.

/** The origins a service lets read its answers from a browser, from a comma-separated variable. */
export function originsFrom(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      out.add(new URL(trimmed).origin);
    } catch {
      // Not an origin: ignored.
    }
  }
  return out;
}

/** The CORS headers for an answer to `request`: none unless its Origin is allowed. */
export function corsHeaders(request: Request, origins: Set<string>): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !origins.has(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "origin" };
}

/** The answer to a CORS preflight: allowed origins get the methods and headers; others get a bare 204, which fails. */
export function preflight(request: Request, origins: Set<string>, methods: string): Response {
  const headers = corsHeaders(request, origins);
  if (!headers["access-control-allow-origin"]) return new Response(null, { status: 204, headers: { vary: "origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "access-control-allow-methods": methods,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    },
  });
}

/** Adds CORS headers to a response, when the request's origin is allowed. A 101 (WebSocket) answer is left alone. */
export function withCors(response: Response, request: Request, origins: Set<string>): Response {
  const headers = corsHeaders(request, origins);
  if (response.status === 101 || !headers["access-control-allow-origin"]) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

/**
 * A client's address as a rate-limit key: IPv4 as it is, IPv6 grouped by its /64, since one home or phone holds a
 * whole /64 and could otherwise use a fresh address per request.
 */
export function addressKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (!ip.includes(":")) return ip || "unknown";
  return `${ipv6Prefix64(ip)}::/64`;
}

/** The first four groups of an IPv6 address, expanded, lowercased. */
export function ipv6Prefix64(ip: string): string {
  const bare = ip.split("%")[0]!.toLowerCase();
  const [head = "", tail] = bare.split("::");
  const left = head ? head.split(":") : [];
  let groups: string[];
  if (tail === undefined) groups = left;
  else {
    const right = tail ? tail.split(":") : [];
    // An embedded IPv4 tail counts as two groups; only the first four groups matter here, so it is left as is.
    groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  }
  return groups
    .slice(0, 4)
    .map((g) => (g.replace(/^0+(?=.)/, "") || "0"))
    .join(":");
}

/** Whether a service may call this URL: https, or plain http to this machine for the local emulators. */
export function fetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}
