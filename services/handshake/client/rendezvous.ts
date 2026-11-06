// A short pairing code's slot at the handshake (PROTOCOL.md, "Rendezvous"), in the shape lane H's pairing asks for
// (`PairingRendezvous` in the core's links/pairing.ts): publish, lookup and remove. The caller seals the box under
// the code's secret; this only carries it. The token that removes a slot is made here at publish, kept in memory,
// and sent only to remove it.

import { b64u } from "../../shared/encoding";
import { type HandshakeClient, HandshakeError } from "./client";
import { LIMITS } from "./wire";

export class HandshakeRendezvous {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly client: HandshakeClient) {}

  /** Claims the slot with the host's sealed box. A claimed slot (by anyone, with any other box) is a HandshakeError 409
   *  `taken`: pick a new code. Publishing the same box again is a safe retry. */
  async publish(slot: string, box: string, ttlSeconds: number): Promise<void> {
    const held = this.tokens.get(slot);
    // Kept before the call, so a retry after a lost answer sends the same token and is taken as the same PUT.
    const token = held ?? b64u(crypto.getRandomValues(new Uint8Array(24)));
    this.tokens.set(slot, token);
    const ttl = Math.min(Math.max(1, Math.ceil(ttlSeconds)), LIMITS.rendezvous.maxTtl);
    const body = new TextEncoder().encode(JSON.stringify({ box, ttl, token }));
    try {
      await this.client.send("PUT", `/v1/rendezvous/${slot}`, body);
    } catch (err) {
      if (held === undefined && err instanceof HandshakeError && err.status === 409) this.tokens.delete(slot);
      throw err;
    }
  }

  /** The box in the slot, or undefined when there is none (never published, removed, or past its ttl). */
  async lookup(slot: string): Promise<string | undefined> {
    try {
      const found = await this.client.send("GET", `/v1/rendezvous/${slot}`, null);
      return typeof found.box === "string" ? found.box : undefined;
    } catch (err) {
      if (err instanceof HandshakeError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Clears a slot this instance published; anything else is left to its ttl. */
  async remove(slot: string): Promise<void> {
    const token = this.tokens.get(slot);
    if (token === undefined) return;
    this.tokens.delete(slot);
    try {
      await this.client.send("DELETE", `/v1/rendezvous/${slot}`, null, { authorization: `Bearer ${token}` });
    } catch (err) {
      if (err instanceof HandshakeError && err.status === 404) return;
      throw err;
    }
  }
}
