// A short pairing code's slot at the waifucave handshake (services/handshake/PROTOCOL.md, "Rendezvous"), as lane H's
// pairing asks for it (`PairingRendezvous`): publish, lookup and remove, over the service's three unsigned routes. The
// caller seals the box under the code's secret; this only carries it. The token that removes a slot early is made
// here at publish and kept in memory, never on disk: a slot this process loses track of simply ends at its ttl.
import { randomBytes } from "node:crypto";
import { ContractError } from "../contracts/common";
import type { PairingRendezvous } from "./pairing";

/** The service's longest slot, in seconds (`LIMITS.rendezvous.maxTtl`): a pairing lasts 10 minutes. */
export const RENDEZVOUS_MAX_TTL = 600;

export interface HandshakeRendezvousOptions {
  /** The handshake's origin: `https://handshake.waifucave.com`, or a local service in dev and tests. */
  baseUrl: string;
  fetch?: (req: Request) => Promise<Response>;
  /** How long a request may take before it counts as offline (10 s). */
  timeoutMs?: number;
}

export class HandshakeRendezvous implements PairingRendezvous {
  readonly #base: string;
  readonly #fetch: (req: Request) => Promise<Response>;
  readonly #timeoutMs: number;
  readonly #tokens = new Map<string, string>();

  constructor(o: HandshakeRendezvousOptions) {
    this.#base = o.baseUrl.replace(/\/+$/, "");
    this.#fetch = o.fetch ?? ((req) => fetch(req));
    this.#timeoutMs = o.timeoutMs ?? 10_000;
  }

  /** Claims the slot with the host's sealed box. A slot someone else holds is a `conflict` (as `MemoryRendezvous`):
   *  the host picks a new code. Publishing the same box again is a safe retry, with the same token. */
  async publish(slot: string, box: string, ttlSeconds: number): Promise<void> {
    const held = this.#tokens.get(slot);
    // Kept before the call, so a retry after a lost answer sends the same token and counts as the same claim.
    const token = held ?? randomBytes(24).toString("base64url");
    this.#tokens.set(slot, token);
    const ttl = Math.min(Math.max(1, Math.ceil(ttlSeconds)), RENDEZVOUS_MAX_TTL);
    const res = await this.#call("PUT", slot, JSON.stringify({ box, ttl, token }));
    if (res.status === 200 || res.status === 201) return;
    if (held === undefined && res.status === 409) this.#tokens.delete(slot);
    if (res.status === 409) throw new ContractError("conflict", "the slot is taken");
    throw await failure(res);
  }

  /** The box in the slot, or undefined when there is none (never published, removed, or past its ttl). */
  async lookup(slot: string): Promise<string | undefined> {
    const res = await this.#call("GET", slot);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw await failure(res);
    const body = (await res.json().catch(() => null)) as { box?: unknown } | null;
    return typeof body?.box === "string" ? body.box : undefined;
  }

  /** Clears a slot this instance published; anything else is left to its ttl. */
  async remove(slot: string): Promise<void> {
    const token = this.#tokens.get(slot);
    if (token === undefined) return;
    this.#tokens.delete(slot);
    const res = await this.#call("DELETE", slot, undefined, { authorization: `Bearer ${token}` });
    if (res.status === 204 || res.status === 404) return;
    throw await failure(res);
  }

  async #call(method: string, slot: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.#base}/v1/rendezvous/${encodeURIComponent(slot)}`;
    const init: RequestInit = { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) init.body = body;
    try {
      return await this.#fetch(new Request(url, init));
    } catch (err) {
      throw new ContractError("offline", "the handshake can't be reached", { cause: err instanceof Error ? err.name : "error" });
    }
  }
}

/** The service's answer as an error: its code, never its body's other fields. */
async function failure(res: Response): Promise<ContractError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
  return new ContractError(res.status === 429 || res.status >= 500 ? "offline" : "failed", `the handshake's rendezvous answered ${res.status} ${code}`, { status: res.status, code });
}
