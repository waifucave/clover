// Webhooks through the `webhook.ingress` point (spec §7; the plugin API's `WebhookIngressHandler`). Owner: lane D,
// as the webhook trigger's side; lane I's forwarder is the default ingress.
//
// * **Register:** each webhook routine this computer holds is registered with every ingress by its key's hash
//   (`webhookKeyHash`), never the key, which stays in the credential store. The first ingress's URL is the routine's.
// * **Deliver:** a long poll (`next`) takes what arrived; each delivery runs once (by its id, at least once from the
//   service), with the missed-run rule for one held while this computer was away, and is acked, or dropped when no
//   routine here takes it.
// * Until lane B's plugin API carries a trigger's calls, the core plays the bundled webhook trigger's part here and
//   calls the ingress handlers through the plugin host.
import { webhookKeyHash, WEBHOOK_NEXT_GRACE_MS } from "../../../plugin-sdk/src/api/plugin-api";
import type { Clock } from "../contracts/clock";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { RoutineEngine } from "./engine";

export const INGRESS_WAIT_MS = 60_000;
/** How long the loop waits while no ingress is installed, or after every one failed. */
export const IDLE_WAIT_MS = 5_000;

interface Ingress {
  pluginId: string;
  handler: string;
}

export interface WebhookIngressOptions {
  registry: Pick<PluginRegistry, "entries">;
  host: Pick<PluginHost, "invoke">;
  engine: Pick<RoutineEngine, "deliverWebhook" | "webhookRoutines">;
  clock: Pick<Clock, "now">;
  warn?: (m: string) => void;
}

export class WebhookIngress {
  readonly #o: WebhookIngressOptions;
  #running = false;
  /** Every ingress's `next` failed in the last round, so the loop waits before the next. */
  #allFailed = false;

  constructor(o: WebhookIngressOptions) {
    this.#o = o;
  }

  #ingresses(): Ingress[] {
    return this.#o.registry.entries("webhook.ingress")
      .filter((c) => c.state === "active" && typeof (c.value as { handler?: unknown }).handler === "string")
      .map((c) => ({ pluginId: c.pluginId, handler: (c.value as { handler: string }).handler }));
  }

  /** Registers a routine with every ingress; the first one's URL is its URL. */
  async register(routine: string, key: string): Promise<string> {
    const keyHash = await webhookKeyHash(key);
    let url: string | undefined;
    for (const i of this.#ingresses()) {
      try {
        const r = await this.#o.host.invoke<{ url: string } | { conflict: { device: string } }>({ pluginId: i.pluginId, handler: i.handler, method: "register", args: { routine, keyHash }, caller: { kind: "core" } });
        if ("url" in r) url ??= r.url;
        else this.#o.warn?.(`${routine}'s webhook is held by another computer (${r.conflict.device}) at ${i.pluginId}`);
      } catch (err) {
        this.#o.warn?.(`registering ${routine}'s webhook with ${i.pluginId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (url === undefined) throw new Error("no webhook ingress is installed and reachable here, so the routine has no URL yet");
    return url;
  }

  /** One round of every ingress's long poll; the deliveries it ran. */
  async pollOnce(waitMs = INGRESS_WAIT_MS): Promise<number> {
    let ran = 0;
    let failed = 0;
    const ingresses = this.#ingresses();
    for (const i of ingresses) {
      let deliveries: { id: string; routine: string; receivedAt: number; headers: [string, string][]; body: Uint8Array }[];
      try {
        deliveries = (await this.#o.host.invoke<{ deliveries: typeof deliveries }>({
          pluginId: i.pluginId, handler: i.handler, method: "next", args: { max: 16, waitMs }, caller: { kind: "core" }, timeoutMs: waitMs + WEBHOOK_NEXT_GRACE_MS,
        })).deliveries;
      } catch (err) {
        this.#o.warn?.(`${i.pluginId}'s webhooks weren't fetched: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
        continue;
      }
      const ack: string[] = [];
      const drop: string[] = [];
      for (const d of deliveries) {
        const contentType = d.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
        const outcome = await this.#o.engine.deliverWebhook({
          id: d.id, routine: d.routine, receivedAt: d.receivedAt, body: new TextDecoder().decode(d.body), ...(contentType === undefined ? {} : { contentType }),
        });
        if (outcome === "refused") drop.push(d.id);
        else ack.push(d.id);
        if (outcome === "accepted") ran++;
      }
      for (const [method, ids] of [["ack", ack], ["drop", drop]] as const) {
        if (ids.length === 0) continue;
        await this.#o.host.invoke({ pluginId: i.pluginId, handler: i.handler, method, args: { ids }, caller: { kind: "core" } }).catch((err: unknown) => {
          this.#o.warn?.(`${i.pluginId}'s ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
    this.#allFailed = ingresses.length > 0 && failed === ingresses.length;
    return ran;
  }

  /** Polls until `stop`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void (async () => {
      while (this.#running) {
        if (this.#ingresses().length === 0) {
          await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
          continue;
        }
        const began = Date.now();
        const ran = await this.pollOnce().catch((err: unknown) => {
          this.#o.warn?.(`webhooks: ${err instanceof Error ? err.message : String(err)}`);
          this.#allFailed = true;
          return 0;
        });
        // A failing ingress (offline, not started yet) answers at once, and so does one that ignores `waitMs`: don't
        // spin on either.
        if (this.#allFailed) await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
        else if (ran === 0 && Date.now() - began < 1_000) await new Promise((r) => setTimeout(r, 1_000));
      }
    })();
  }

  stop(): void {
    this.#running = false;
  }
}
