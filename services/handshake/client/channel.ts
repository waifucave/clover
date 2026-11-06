// A pair's channel: the pair scope, its box key and the peer, so a member sends and receives plaintext values and
// never handles boxes. What the web companion's pairing and signalling run on; lane H's link layer can use it for
// `addr` and `dial` the same way.

import { HandshakeClient, type PairScope, type ScopeSocket, type SocketOptions } from "./client";
import { openJson, pairBoxKey, sealJson } from "./boxes";
import type { Signer } from "./signer";
import { KINDS, type Kind, type MessageView, type RecordView, type ServiceFrame } from "./wire";

export type ChannelEvent =
  | { type: "message"; kind: Kind; id: string; at: number; value: Record<string, unknown> }
  | { type: "record"; kind: Kind; gen: number; value: Record<string, unknown> }
  | { type: "presence"; online: boolean }
  | { type: "open"; peerOnline: boolean }
  | { type: "closed"; final: boolean; code: number }
  /** A box that didn't open: sealed for another pair or key, or changed on the way. Dropped. */
  | { type: "unreadable"; kind: Kind };

export interface PairChannelOptions {
  client: HandshakeClient;
  pair: string;
  signer: Signer;
  peer: string;
  /** The 32-byte pair secret, or the box key already derived from it. */
  secret: Uint8Array | CryptoKey;
}

export class PairChannel {
  readonly scope: PairScope;
  readonly pair: string;
  readonly peer: string;
  private boxKey: Promise<CryptoKey>;
  private lastGen = 0;
  private socket: ScopeSocket | null = null;

  constructor(private readonly options: PairChannelOptions) {
    this.pair = options.pair;
    this.peer = options.peer;
    this.scope = options.client.pair(options.pair, options.signer);
    this.boxKey = options.secret instanceof Uint8Array ? pairBoxKey(options.secret, options.pair) : Promise.resolve(options.secret);
  }

  get self(): string {
    return this.options.signer.key;
  }

  async send(kind: Kind, value: Record<string, unknown>, ttl?: number): Promise<{ id: string; delivered: boolean }> {
    if (KINDS[kind].as !== "message") throw new TypeError(`${kind} is a record kind`);
    const box = await sealJson(await this.boxKey, { pair: this.pair, from: this.self, to: this.peer, kind }, value);
    return this.scope.sendMessage(kind, { box, ...(ttl ? { ttl } : {}) });
  }

  async publish(kind: Kind, value: Record<string, unknown>, ttl?: number): Promise<number> {
    if (KINDS[kind].as !== "record") throw new TypeError(`${kind} is a message kind`);
    const gen = Math.max(this.options.client.now(), this.lastGen + 1);
    this.lastGen = gen;
    const box = await sealJson(await this.boxKey, { pair: this.pair, from: this.self, to: this.peer, kind, gen }, value);
    await this.scope.putRecord(kind, { gen, box, ...(ttl ? { ttl } : {}) });
    return gen;
  }

  /** Opens a message or record frame from the peer. */
  async open(frame: MessageView | RecordView): Promise<ChannelEvent> {
    if (frame.from !== this.peer) return { type: "unreadable", kind: frame.kind };
    const key = await this.boxKey;
    try {
      if ("gen" in frame) {
        const value = await openJson(key, { pair: this.pair, from: frame.from, to: this.self, kind: frame.kind, gen: frame.gen }, frame.box);
        return { type: "record", kind: frame.kind, gen: frame.gen, value };
      }
      const value = await openJson(key, { pair: this.pair, from: frame.from, to: this.self, kind: frame.kind }, frame.box);
      return { type: "message", kind: frame.kind, id: frame.id, at: frame.at, value };
    } catch {
      return { type: "unreadable", kind: frame.kind };
    }
  }

  /** Takes and opens the queued messages (for a member that polls instead of holding a socket). */
  async inbox(): Promise<ChannelEvent[]> {
    return Promise.all((await this.scope.inbox()).map((m) => this.open(m)));
  }

  /** Holds the pair's socket open and hands every event, opened, to `onEvent`, in order. */
  listen(onEvent: (event: ChannelEvent) => void, options?: SocketOptions): this {
    this.socket?.stop();
    let chain = Promise.resolve();
    const deliver = (make: () => Promise<ChannelEvent> | ChannelEvent) => {
      chain = chain.then(async () => onEvent(await make())).catch(() => undefined);
    };
    this.socket = this.scope
      .socket(
        {
          onFrame: (frame: ServiceFrame) => {
            if (frame.t === "hello" && frame.scope === "pair") deliver(() => ({ type: "open", peerOnline: frame.peer.online }));
            else if (frame.t === "message" || frame.t === "record") {
              const { t: _t, ...view } = frame;
              deliver(() => this.open(view as MessageView | RecordView));
            } else if (frame.t === "presence") deliver(() => ({ type: "presence", online: frame.online }));
          },
          onClose: (code, final) => deliver(() => ({ type: "closed", final, code })),
        },
        options,
      )
      .start();
    return this;
  }

  get listening(): boolean {
    return this.socket?.open ?? false;
  }

  close(): void {
    this.socket?.stop();
    this.socket = null;
  }
}
