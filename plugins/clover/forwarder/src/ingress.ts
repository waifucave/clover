// The forwarder's entry in `webhook.ingress`, the point the bundled webhook trigger declares (spec §5.4, §7).
//
// The trigger calls these handlers (points.call); every argument and result is structured-clone data:
//   register({ routine, key, takeover? })  -> { url }     a webhook routine this computer holds (key: the
//                                                          routine's key from the credential store; only its
//                                                          hash leaves this computer)
//   unregister({ routine })                -> {}
//   list()                                 -> { routines: [{ id, device, held }] }
//   next({ max?, waitMs? })                -> { deliveries: IngressDelivery[] }   a long poll
//   ack({ ids })                           -> {}          taken: deleted at waifucave
//   drop({ ids })                          -> {}          refused: deleted at waifucave too
//
// Webhooks reach the trigger by pull (next), since a point's handlers run when the declarer calls them; a
// webhook is acknowledged to the service only when the trigger acks it, so nothing is lost if the trigger
// stops between taking and running it. Delivery is at least once: the trigger keeps the ids it has run.

import type { ClientState, Delivery, ForwarderClient } from "./client";
import { RoutineHeldElsewhere } from "./client";

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

export class WebhookIngress {
  private readonly queue: Delivery[] = [];
  private readonly handedOut = new Map<string, { delivery: Delivery; at: number }>();
  private waiters: (() => void)[] = [];
  private readonly now: () => number;
  private readonly reofferAfterMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly client: Pick<ForwarderClient, "registerRoutine" | "unregisterRoutine" | "listRoutines" | "state">,
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

  async register(args: { routine: string; key: string; takeover?: boolean }): Promise<RegisterResult> {
    try {
      return await this.client.registerRoutine(args.routine, args.key, { takeover: args.takeover === true });
    } catch (err) {
      if (err instanceof RoutineHeldElsewhere) return { conflict: { device: err.device } };
      throw err;
    }
  }

  async unregister(args: { routine: string }): Promise<Record<string, never>> {
    await this.client.unregisterRoutine(args.routine);
    for (const delivery of this.queue.filter((d) => d.routine === args.routine)) this.remove(delivery.id, "drop");
    return {};
  }

  async list(): Promise<{ routines: Awaited<ReturnType<ForwarderClient["listRoutines"]>> }> {
    return { routines: await this.client.listRoutines() };
  }

  async next(args: { max?: number; waitMs?: number } = {}): Promise<{ deliveries: IngressDelivery[] }> {
    const max = Math.max(1, Math.min(args.max ?? 16, 64));
    const waitMs = Math.max(0, Math.min(args.waitMs ?? 25_000, this.maxWaitMs));
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

  private remove(id: string, how: "ack" | "drop"): void {
    const handed = this.handedOut.get(id);
    const index = this.queue.findIndex((d) => d.id === id);
    const delivery = handed?.delivery ?? (index >= 0 ? this.queue[index] : undefined);
    if (!delivery) return;
    this.handedOut.delete(id);
    if (index >= 0) this.queue.splice(index, 1);
    if (how === "ack") delivery.ack();
    else delivery.drop();
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
