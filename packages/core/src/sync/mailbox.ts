// Sync mail (H-M3, item 2 of the brief; spec §6.5 "When devices actually sync", §8.3): what a computer changed reaches
// one that is off now when it comes back, even if the writer is off by then. A relay plugin keeps the mail
// (`RelayHandler.putMail`, `takeMail`, `ackMail`; services/relay/PROTOCOL.md "Mail"): sealed blobs addressed to a
// device, kept until acknowledged or expired. The relay sees which device gets mail, when and how much, never what.
//
// Each piece is sealed to its recipient alone (`memory.ts`): HPKE to its X25519 box key, the account channel's box
// suite (identity/box-key.ts), and signed with the sender's link key, so the recipient checks who sent it against its
// own registry.

/** One device's view of a mail relay. */
export interface SyncMailbox {
  put(args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }): Promise<void>;
  /** This device's mail, oldest first; taken mail stays until `ack`. */
  take(args?: { max?: number }): Promise<{ id: string; sealed: Uint8Array }[]>;
  ack(ids: string[]): Promise<void>;
}

/** A relay plugin's mail handlers (lane B's `RelayHandler`, structurally: the core doesn't import the plugin SDK),
 *  as the plugin host calls them. */
export interface RelayMailHandlers {
  putMail(args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }): Promise<unknown>;
  takeMail(args: { max?: number }): Promise<{ mail: { id: string; sealed: Uint8Array }[] }>;
  ackMail(args: { ids: string[] }): Promise<unknown>;
}

/** A relay plugin's mail as this device's mailbox. */
export function relayMailbox(h: RelayMailHandlers): SyncMailbox {
  return {
    put: async (args) => void (await h.putMail(args)),
    take: async (args) => (await h.takeMail(args ?? {})).mail,
    ack: async (ids) => void (await h.ackMail({ ids })),
  };
}

/** The relay's limits (PROTOCOL.md "Mail"). */
export const MAIL_MAX_PIECE = 1024 * 1024;
export const MAIL_MAX_PIECES = 256;
export const MAIL_MAX_AHEAD_MS = 30 * 24 * 3_600_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A relay's mail in memory, for tests: the same limits and the same take-then-ack rule. */
export class MemoryMailRelay {
  readonly #boxes = new Map<string, Map<string, { sealed: Uint8Array; expiresAt: number }>>();
  readonly #now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.#now = o.now ?? Date.now;
  }

  /** What the relay holds for a device, as it holds it (sealed). */
  held(device: string): Uint8Array[] {
    return [...(this.#boxes.get(device)?.values() ?? [])].map((m) => m.sealed);
  }

  for(device: string): SyncMailbox {
    return {
      put: async ({ to, id, sealed, expiresAt }) => {
        if (!ID_RE.test(to) || !ID_RE.test(id)) throw new Error("bad_request");
        if (sealed.length > MAIL_MAX_PIECE) throw new Error("too_large");
        if (expiresAt > this.#now() + MAIL_MAX_AHEAD_MS) throw new Error("bad_request");
        const box = this.#boxes.get(to) ?? new Map();
        if (box.has(id)) return;
        if (box.size >= MAIL_MAX_PIECES) throw new Error("full");
        box.set(id, { sealed: new Uint8Array(sealed), expiresAt });
        this.#boxes.set(to, box);
      },
      take: async (args) => {
        const box = this.#boxes.get(device);
        if (!box) return [];
        const now = this.#now();
        for (const [id, m] of box) if (m.expiresAt <= now) box.delete(id);
        return [...box].slice(0, Math.min(Math.max(1, args?.max ?? 16), 64)).map(([id, m]) => ({ id, sealed: new Uint8Array(m.sealed) }));
      },
      ack: async (ids) => {
        const box = this.#boxes.get(device);
        for (const id of ids) box?.delete(id);
      },
    };
  }
}
