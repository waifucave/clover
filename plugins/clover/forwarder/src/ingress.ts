// The forwarder's entry in `webhook.ingress`, the point the bundled webhook trigger declares (spec §5.4, §7).
//
// The trigger calls these handlers (points.call); every argument and result is structured-clone data:
//   register({ routine, key | keyHash, takeover?, allowGet? })
//       -> { url } | { conflict: { device } }   a webhook routine this computer holds. key: the routine's
//          key (at least 43 characters; only its hash leaves this computer); or keyHash: base64url of
//          protocol.ts hookKeyHash(key), so the key need not reach this plugin at all. allowGet: let a GET to
//          the URL count (off by default: link previewers fetch pasted links).
//   unregister({ routine })      -> { heldElsewhere? }   stops it here. When another computer holds it (it
//                                                         moved), nothing changes there.
//   list()                       -> { routines: RoutineInfo[] }   with drops on this computer's routines,
//                                                                  reported once
//   next({ max?, waitMs? })      -> { deliveries: IngressDelivery[] }   a long poll, 8 s by default: within
//                                   the plugin API's default 10 s call limit. A longer waitMs needs the
//                                   caller to set a longer call limit.
//   ack({ ids })                 -> {}          taken: deleted at waifucave
//   drop({ ids })                -> {}          refused: deleted at waifucave too
//
// Webhooks reach the trigger by pull (next), since a point's handlers run when the declarer calls them; a
// webhook is acknowledged to the service only when the trigger acks it, so nothing is lost if the trigger
// stops between taking and running it. Delivery is at least once: the trigger keeps the ids it has run.
// The trigger should ack or drop every delivery promptly: unsettled ones fill the connection's window (32
// webhooks) and hold up this computer's other routines.

import type { ClientState, Delivery, ForwarderClient } from "./client";
import { RoutineHeldElsewhere } from "./client";
import { fromB64u } from "./wire/bytes";
import { MIN_ROUTINE_KEY_LENGTH } from "./wire/protocol";

export interface IngressDelivery {
  id: string;
  routine: string;
  receivedAt: number;
  method: string;
  query: string;
  headers: [string, string][];
  ip?: string;
  body: Uint8Array;
  /** Marked so the bot sees outside text as untrusted (spec §7). */
  untrusted: true;
}

export interface IngressOptions {
  now?: () => number;
  /** A delivery handed out by next() and not acked within this long is offered again. */
  reofferAfterMs?: number;
  maxWaitMs?: number;
}

export type RegisterResult = { url: string } | { conflict: { device: string } };

export interface RegisterArgs {
  routine: string;
  key?: string;
  keyHash?: string;
  takeover?: boolean;
  allowGet?: boolean;
}

/** Long polls end within the plugin API's default call limit (spec §5.4: 10 s) unless the caller asks for longer. */
export const DEFAULT_WAIT_MS = 8_000;

export class WebhookIngress {
  private readonly queue: Delivery[] = [];
  private readonly handedOut = new Map<string, { delivery: Delivery; at: number }>();
  private waiters: (() => void)[] = [];
  private readonly now: () => number;
  private readonly reofferAfterMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly client: Pick<ForwarderClient, "registerRoutine" | "registerRoutineHash" | "unregisterRoutine" | "listRoutines" | "state">,
    options: IngressOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.reofferAfterMs = options.reofferAfterMs ?? 5 * 60_000;
    this.maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  }

  /** Wired as the client's onDelivery. */
  accept(delivery: Delivery): void {
    if (this.handedOut.has(delivery.id) || this.queue.some((d) => d.id === delivery.id)) return;
    this.queue.push(delivery);
    this.wake();
  }

  get connection(): ClientState {
    return this.client.state;
  }

  async register(args: RegisterArgs): Promise<RegisterResult> {
    const options = { takeover: args.takeover === true, allowGet: args.allowGet === true };
    try {
      if (typeof args.keyHash === "string") {
        let keyHash: Uint8Array;
        try {
          keyHash = fromB64u(args.keyHash);
        } catch {
          throw new TypeError("register: keyHash must be base64url");
        }
        if (keyHash.length !== 32) throw new TypeError("register: keyHash must be 32 bytes");
        return await this.client.registerRoutineHash(args.routine, keyHash, options);
      }
      if (typeof args.key !== "string" || args.key.length < MIN_ROUTINE_KEY_LENGTH) {
        throw new TypeError(`register: a routine's key must be at least ${MIN_ROUTINE_KEY_LENGTH} characters`);
      }
      return await this.client.registerRoutine(args.routine, args.key, options);
    } catch (err) {
      if (err instanceof RoutineHeldElsewhere) return { conflict: { device: err.device } };
      throw err;
    }
  }

  /**
   * Stops a routine here. Its webhooks waiting on this computer are let go, not refused: the service keeps
   * them for whichever computer registers the routine next (it may be moving), and refuses a DELETE from a
   * computer that no longer holds it, which is then already done.
   */
  async unregister(args: { routine: string }): Promise<{ heldElsewhere?: string }> {
    let heldElsewhere: string | undefined;
    try {
      await this.client.unregisterRoutine(args.routine);
    } catch (err) {
      if (!(err instanceof RoutineHeldElsewhere)) throw err;
      heldElsewhere = err.device;
    }
    for (const delivery of this.queue.filter((d) => d.routine === args.routine)) this.remove(delivery.id, "release");
    for (const [id, entry] of [...this.handedOut]) if (entry.delivery.routine === args.routine) this.remove(id, "release");
    return heldElsewhere === undefined ? {} : { heldElsewhere };
  }

  async list(): Promise<{ routines: Awaited<ReturnType<ForwarderClient["listRoutines"]>> }> {
    return { routines: await this.client.listRoutines() };
  }

  async next(args: { max?: number; waitMs?: number } = {}): Promise<{ deliveries: IngressDelivery[] }> {
    const max = Math.max(1, Math.min(args.max ?? 16, 64));
    const waitMs = Math.max(0, Math.min(args.waitMs ?? DEFAULT_WAIT_MS, this.maxWaitMs));
    this.reofferStale();
    if (this.queue.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve();
        }, waitMs);
        this.waiters.push(waiter);
      });
    }
    const taken = this.queue.splice(0, max);
    const at = this.now();
    for (const delivery of taken) this.handedOut.set(delivery.id, { delivery, at });
    return { deliveries: taken.map(toIngressDelivery) };
  }

  async ack(args: { ids: string[] }): Promise<Record<string, never>> {
    for (const id of args.ids) this.remove(id, "ack");
    return {};
  }

  async drop(args: { ids: string[] }): Promise<Record<string, never>> {
    for (const id of args.ids) this.remove(id, "drop");
    return {};
  }

  private remove(id: string, how: "ack" | "drop" | "release"): void {
    const handed = this.handedOut.get(id);
    const index = this.queue.findIndex((d) => d.id === id);
    const delivery = handed?.delivery ?? (index >= 0 ? this.queue[index] : undefined);
    if (!delivery) return;
    this.handedOut.delete(id);
    if (index >= 0) this.queue.splice(index, 1);
    if (how === "ack") delivery.ack();
    else if (how === "drop") delivery.drop();
    else delivery.release();
  }

  private reofferStale(): void {
    const cutoff = this.now() - this.reofferAfterMs;
    for (const [id, entry] of this.handedOut) {
      if (entry.at > cutoff) continue;
      this.handedOut.delete(id);
      this.queue.unshift(entry.delivery);
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

function toIngressDelivery(delivery: Delivery): IngressDelivery {
  const out: IngressDelivery = {
    id: delivery.id,
    routine: delivery.routine,
    receivedAt: delivery.receivedAt,
    method: delivery.request.method,
    query: delivery.request.query,
    headers: delivery.request.headers,
    body: delivery.request.body,
    untrusted: true,
  };
  if (delivery.request.ip) out.ip = delivery.request.ip;
  return out;
}
