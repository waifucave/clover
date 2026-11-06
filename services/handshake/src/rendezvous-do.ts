// One short pairing code's rendezvous slot (PROTOCOL.md, "Rendezvous"): the host's sealed box, the hash of the token
// that removes it, and when it ends. The Worker has checked the slot, the box, the ttl and the rate limits; this
// object only decides who holds the slot. It keeps nothing past the slot's end: an alarm clears it then.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

interface Slot {
  box: string;
  /** base64url SHA-256 of the removal token. */
  tokenHash: string;
  expiresAt: number;
}

export type RendezvousReply = { status: 200 | 201; expiresAt: number } | { status: 403 | 404 | 409 } | { status: 204 };

export class RendezvousDO extends DurableObject<Env> {
  private async live(now: number): Promise<Slot | undefined> {
    const slot = await this.ctx.storage.get<Slot>("slot");
    if (slot && slot.expiresAt <= now) {
      await this.ctx.storage.deleteAll();
      return undefined;
    }
    return slot;
  }

  /** Takes the slot, or replaces its box for the holder of the same token (a retried PUT). */
  async put(box: string, tokenHash: string, ttlSeconds: number, now: number): Promise<RendezvousReply> {
    const held = await this.live(now);
    if (held && held.tokenHash !== tokenHash) return { status: 409 };
    const expiresAt = now + ttlSeconds * 1000;
    await this.ctx.storage.put<Slot>("slot", { box, tokenHash, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt);
    return { status: held ? 200 : 201, expiresAt };
  }

  async get(now: number): Promise<{ box: string; expiresAt: number } | null> {
    const slot = await this.live(now);
    return slot ? { box: slot.box, expiresAt: slot.expiresAt } : null;
  }

  async remove(tokenHash: string, now: number): Promise<RendezvousReply> {
    const slot = await this.live(now);
    if (!slot) return { status: 404 };
    if (slot.tokenHash !== tokenHash) return { status: 403 };
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { status: 204 };
  }

  override async alarm(): Promise<void> {
    const slot = await this.live(Date.now());
    // Early by a clock's skew: once more at the slot's end, so nothing outlives it.
    if (slot) await this.ctx.storage.setAlarm(slot.expiresAt);
  }
}
