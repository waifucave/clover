// Webhooks through the `webhook.ingress` point (spec §7; the plugin API's `WebhookIngressHandler`). Owner: lane D,
// as the webhook trigger's side; lane I's forwarder is the default ingress.
//
// * **One ingress per routine** (review S2): a routine registers with its trigger's named ingress (`ingress:` in the
//   file, an entry id or a plugin id), else the first one installed, and only that ingress's deliveries for it run; a
//   delivery for it from any other ingress is dropped.
// * **Register:** by its key's hash (`webhookKeyHash`), never the key, which stays in the credential store. Each
//   webhook routine here is registered as the loop finds it (a file written directly, one moved here, a restart), and
//   one that has gone is let go of.
// * **Deliver:** a long poll (`next`) takes what arrived; each delivery runs once (by its ingress and id, at least once
//   from the service), with the missed-run rule for one held while this computer was away, and is acked, or dropped
//   when no routine here takes it.
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
/** How long a routine whose registration failed waits before the loop tries it again. */
export const REGISTER_RETRY_MS = 5 * 60_000;

interface Ingress {
  pluginId: string;
  entryId: string;
  handler: string;
}

export interface WebhookIngressOptions {
  registry: Pick<PluginRegistry, "entries">;
  host: Pick<PluginHost, "invoke">;
  engine: Pick<RoutineEngine, "deliverWebhook" | "webhookRoutines" | "webhook">;
  clock: Pick<Clock, "now">;
  warn?: (m: string) => void;
}

export class WebhookIngress {
  readonly #o: WebhookIngressOptions;
  #running = false;
  /** Every ingress's `next` failed in the last round, so the loop waits before the next. */
  #allFailed = false;
  /** Each registered routine's one ingress (its plugin). */
  readonly #chosen = new Map<string, string>();
  /** Routines whose registration failed, and when, so the loop doesn't retry each round. */
  readonly #failed = new Map<string, number>();

  constructor(o: WebhookIngressOptions) {
    this.#o = o;
  }

  #ingresses(): Ingress[] {
    return this.#o.registry.entries("webhook.ingress")
      .filter((c) => c.state === "active" && typeof (c.value as { handler?: unknown }).handler === "string")
      .map((c) => ({ pluginId: c.pluginId, entryId: c.entryId ?? (c.value as { id?: string }).id ?? "", handler: (c.value as { handler: string }).handler }));
  }

  /** The routine's ingress: the one it names (an entry id or a plugin id), else the first installed. */
  #pick(name: string | undefined): Ingress {
    const all = this.#ingresses();
    const found = name === undefined ? all[0] : all.find((i) => i.entryId === name || i.pluginId === name);
    if (found === undefined) {
      throw new Error(name === undefined ? "no webhook ingress is installed and reachable here, so the routine has no URL yet" : `no webhook ingress "${name}" is installed here, so the routine has no URL yet`);
    }
    return found;
  }

  /** Registers a routine with its one ingress, which gives its URL. */
  async register(routine: string, key: string, name?: string): Promise<string> {
    const keyHash = await webhookKeyHash(key);
    const i = this.#pick(name);
    const r = await this.#o.host.invoke<{ url: string } | { conflict: { device: string } }>({ pluginId: i.pluginId, handler: i.handler, method: "register", args: { routine, keyHash }, caller: { kind: "core" } });
    if (!("url" in r)) throw new Error(`${routine}'s webhook is held by another computer (${r.conflict.device}) at ${i.pluginId}`);
    const before = this.#chosen.get(routine);
    this.#chosen.set(routine, i.pluginId);
    this.#failed.delete(routine);
    // A routine that changed ingress lets go of the old one.
    if (before !== undefined && before !== i.pluginId) await this.#unregister(routine, before);
    return r.url;
  }

  async #unregister(routine: string, pluginId: string): Promise<void> {
    const i = this.#ingresses().find((x) => x.pluginId === pluginId);
    if (i === undefined) return;
    await this.#o.host.invoke({ pluginId: i.pluginId, handler: i.handler, method: "unregister", args: { routine }, caller: { kind: "core" } }).catch((err: unknown) => {
      this.#o.warn?.(`letting go of ${routine}'s webhook at ${pluginId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Registers the webhook routines here that aren't yet, and lets go of the ones that have gone. */
  async sync(): Promise<void> {
    const now = this.#o.clock.now();
    const here = new Set(this.#o.engine.webhookRoutines());
    for (const id of here) {
      if (this.#chosen.has(id)) continue;
      const failedAt = this.#failed.get(id);
      if (failedAt !== undefined && now - failedAt < REGISTER_RETRY_MS) continue;
      // `webhook` mints the key the first time and calls `register` with the routine's named ingress.
      await this.#o.engine.webhook(id).catch((err: unknown) => {
        this.#failed.set(id, now);
        this.#o.warn?.(`${id}'s webhook isn't registered: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    for (const [id, pluginId] of [...this.#chosen]) {
      if (here.has(id)) continue;
      this.#chosen.delete(id);
      await this.#unregister(id, pluginId);
    }
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
        // Only the routine's own ingress delivers for it.
        if (this.#chosen.get(d.routine) !== i.pluginId) {
          drop.push(d.id);
          continue;
        }
        const contentType = d.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
        const outcome = await this.#o.engine.deliverWebhook({
          ingress: i.pluginId, id: d.id, routine: d.routine, receivedAt: d.receivedAt, body: new TextDecoder().decode(d.body), ...(contentType === undefined ? {} : { contentType }),
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

  /** Registers and polls until `stop`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void (async () => {
      while (this.#running) {
        if (this.#ingresses().length === 0) {
          await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
          continue;
        }
        await this.sync().catch((err: unknown) => this.#o.warn?.(`webhooks: ${err instanceof Error ? err.message : String(err)}`));
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
