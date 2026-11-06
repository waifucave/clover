// The relay plugin's client for the Cloudflare relay (services/relay/PROTOCOL.md). It never holds the relay's key:
// every request goes through the core's keyed fetch, which adds `Authorization: Bearer <relay-key>` from the plugin's
// `auth` entry (spec §5.4). What it hands the link layer is a room URL with a ticket, never the key.

export interface RelayEndpoint {
  kind: "iroh" | "websocket";
  url: string;
  region?: string;
}

export interface Mail {
  id: string;
  sealed: Uint8Array;
}

export class RelayError extends Error {
  constructor(
    readonly code: "not_configured" | "unauthorized" | "full" | "too_large" | "bad_request" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface RelayClientOptions {
  /** The relay's origin from the plugin's settings, or undefined while it isn't set. */
  origin: () => Promise<string | undefined>;
  /** The keyed fetch: adds the relay key. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** This device's id: whose mailbox `takeMail` and `ackMail` read. */
  device: string;
  now?: () => number;
}

/** A ticket is fetched again this long before it expires, so the link layer never dials with a dead one. */
const TICKET_MARGIN_MS = 60 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function b64uDecode(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class RelayClient {
  private ticket: { origin: string; url: string; expiresAt: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: RelayClientOptions) {
    this.now = options.now ?? Date.now;
  }

  private async origin(): Promise<string> {
    const raw = await this.options.origin();
    if (!raw) throw new RelayError("not_configured", "the relay's address isn't set");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new RelayError("not_configured", "the relay's address isn't a URL");
    }
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !local) throw new RelayError("not_configured", "the relay's address must be https");
    return url.origin;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const origin = await this.origin();
    let response: Response;
    try {
      response = await this.options.fetch(`${origin}${path}`, init);
    } catch {
      throw new RelayError("unavailable", "the relay can't be reached");
    }
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 401) {
      this.ticket = null;
      throw new RelayError("unauthorized", "the relay refused the key: check that it matches the Worker's RELAY_KEY");
    }
    if (response.status === 409) throw new RelayError("full", "the relay's mailbox for that device is full");
    if (response.status === 413) throw new RelayError("too_large", "the mail is larger than the relay takes");
    if (response.status === 400) throw new RelayError("bad_request", "the relay refused the request");
    throw new RelayError("unavailable", `the relay answered ${response.status}`);
  }

  /**
   * Where the link layer reaches the relay: one `websocket` endpoint, a room URL carrying a ticket. The link layer
   * adds `&room=<room>&peer=<its device id>` (PROTOCOL.md, "Rooms"). No address set: no endpoints.
   */
  async endpoints(): Promise<RelayEndpoint[]> {
    let origin: string;
    try {
      origin = await this.origin();
    } catch (err) {
      if (err instanceof RelayError && err.code === "not_configured") return [];
      throw err;
    }
    const cached = this.ticket;
    if (cached && cached.origin === origin && cached.expiresAt - TICKET_MARGIN_MS > this.now()) return [{ kind: "websocket", url: cached.url }];
    const response = await this.request("/v1/tickets", { method: "POST" });
    const body = (await response.json()) as { url?: unknown; expiresAt?: unknown };
    if (typeof body.url !== "string" || typeof body.expiresAt !== "number" || !/^wss?:\/\//.test(body.url)) {
      throw new RelayError("unavailable", "the relay's ticket answer was malformed");
    }
    this.ticket = { origin, url: body.url, expiresAt: body.expiresAt };
    return [{ kind: "websocket", url: body.url }];
  }

  async putMail(args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }): Promise<void> {
    if (!DEVICE_RE.test(args.to) || !ID_RE.test(args.id)) throw new RelayError("bad_request", "bad device or mail id");
    await this.request(`/v1/mail/${args.to}/${args.id}`, {
      method: "PUT",
      body: args.sealed as Uint8Array<ArrayBuffer>,
      headers: { "content-type": "application/octet-stream", "x-expires-at": String(args.expiresAt) },
    });
  }

  async takeMail(args: { max?: number } = {}): Promise<Mail[]> {
    const max = Math.min(Math.max(Math.floor(args.max ?? 16), 1), 64);
    const response = await this.request(`/v1/mail/${this.options.device}?max=${max}`);
    const body = (await response.json()) as { mail?: { id: string; sealed: string }[] };
    return (body.mail ?? []).map((m) => ({ id: m.id, sealed: b64uDecode(m.sealed) }));
  }

  async ackMail(args: { ids: string[] }): Promise<void> {
    if (args.ids.length === 0) return;
    for (let i = 0; i < args.ids.length; i += 256) {
      await this.request(`/v1/mail/${this.options.device}/ack`, {
        method: "POST",
        body: JSON.stringify({ ids: args.ids.slice(i, i + 256) }),
        headers: { "content-type": "application/json" },
      });
    }
  }
}
