// The web companion's logic, apart from the page: pairing once with a computer from its invite link, and connecting
// to it over WebRTC with the handshake as the signalling channel (spec §8.4). It runs in a browser, and in Bun for
// the tests (with node-datachannel's RTCPeerConnection and a memory store).

import {
  generateSigner,
  HandshakeClient,
  HandshakeError,
  type Connect,
  type ChannelEvent,
  PairChannel,
  pairBoxKey,
  signerFromKeyPair,
  signText,
} from "@waifucave/clover-service-handshake/client";
import { b64u } from "../../shared/encoding";
import {
  generateX25519,
  type Invite,
  invitePairSecret,
  inviteSigner,
  isPairingMessage,
  lastingPairStatement,
  type PairingMessage,
  pairingResult,
  type PairRequest,
} from "../protocol/pairing";
import { LinkError, type RtcLink } from "../protocol/rtc-link";
import { dial, type RtcEnvironment, SignalRouter } from "../protocol/signalling";

/** A computer this browser has paired with. The keys are CryptoKeys that can't be read back out. */
export interface PairRecord {
  /** The lasting pair P2. */
  pair: string;
  computerKey: string;
  computerName: string;
  /** This browser's device id at the computer. */
  device: string;
  signer: CryptoKeyPair;
  boxKey: CryptoKey;
  handshake: string;
  pairedAt: number;
}

export interface CompanionStore {
  list(): Promise<PairRecord[]>;
  put(record: PairRecord): Promise<void>;
  delete(pair: string): Promise<void>;
}

export class MemoryStore implements CompanionStore {
  private readonly records = new Map<string, PairRecord>();
  async list(): Promise<PairRecord[]> {
    return [...this.records.values()];
  }
  async put(record: PairRecord): Promise<void> {
    this.records.set(record.pair, record);
  }
  async delete(pair: string): Promise<void> {
    this.records.delete(pair);
  }
}

export interface CompanionOptions {
  store: CompanionStore;
  rtc: RtcEnvironment;
  /** The handshake's origin. */
  handshake: string;
  /** Other handshake origins an invite may name (local emulators); the default is the only one in production. */
  allowedHandshakes?: string[];
  /** What this browser calls itself to the computer. */
  name: string;
  fetch?: (request: Request) => Promise<Response>;
  connect?: Connect;
}

export type PairingErrorCode = "expired" | "refused" | "code" | "handshake" | "timeout" | "failed";

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export interface Connection {
  link: RtcLink;
  record: PairRecord;
  /** The pair's handshake channel stays open, so the computer can be re-dialled when the link drops. */
  close(): void;
}

export class Companion {
  constructor(private readonly options: CompanionOptions) {}

  private client(origin: string): HandshakeClient {
    return new HandshakeClient({
      origin,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.connect ? { connect: this.options.connect } : {}),
    });
  }

  private handshakeFor(invite: Invite): string {
    const origin = invite.handshake ?? this.options.handshake;
    const allowed = [this.options.handshake, ...(this.options.allowedHandshakes ?? [])];
    if (!allowed.includes(origin)) throw new PairingError("handshake", "the invite names a handshake this page doesn't use");
    return origin;
  }

  paired(): Promise<PairRecord[]> {
    return this.options.store.list();
  }

  /**
   * Pairs with the computer that made `invite` (protocol/pairing.ts). `onWords` gets the four words to compare with
   * the computer's; it resolves once the person has confirmed them on the computer.
   */
  async pair(invite: Invite, handlers: { onWords(words: string[], computer: string): void; timeoutMs?: number }): Promise<PairRecord> {
    if (invite.expiresAt <= Date.now()) throw new PairingError("expired", "this pairing link has expired; make a new one on the computer");
    const origin = this.handshakeFor(invite);
    const client = this.client(origin);
    const computer = invite.name ?? "your computer";
    const p1 = new PairChannel({
      client,
      pair: invite.pair,
      signer: await inviteSigner(invite),
      peer: invite.computerKey,
      secret: await invitePairSecret(invite),
    });
    const { signer, pair: keyPair } = await generateSigner(false);
    const x25519 = await generateX25519();
    const pair = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const t = Date.now();
    const request: PairRequest = {
      v: 1,
      at: t,
      type: "pair-request",
      pair,
      key: signer.key,
      x25519: x25519.publicKey,
      t,
      sig: await signText(signer, lastingPairStatement(pair, invite.computerKey, signer.key, t)),
      code: invite.code,
      name: this.options.name.slice(0, 63),
    };

    let secret: Uint8Array | null = null;
    let cancel: (err: Error) => void = () => undefined;
    // The request goes out only once this browser's socket is open at the service: the computer answers at once and
    // ends the invite right after `paired`, and what it sends before the socket is there waits in the invite's inbox,
    // which the invite's end deletes. With the socket open first, every answer arrives live, in order.
    let opened: () => void = () => undefined;
    const open = new Promise<void>((resolve) => (opened = resolve));
    const done = new Promise<PairRecord>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PairingError("timeout", "the computer didn't confirm in time")),
        Math.min(handlers.timeoutMs ?? 10 * 60_000, Math.max(invite.expiresAt - Date.now(), 0) + 5 * 60_000),
      );
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      cancel = (err) => settle(() => reject(err));
      let chain = Promise.resolve();
      const onEvent = (event: ChannelEvent) => {
        if (event.type === "open") opened();
        if (event.type === "closed" && event.final) {
          // After whatever came before it on the socket: a `paired` then the invite's end is a success.
          chain = chain.then(() => settle(() => reject(new PairingError("refused", "the computer ended the pairing"))));
          return;
        }
        if (event.type !== "message" || event.kind !== "signal" || !isPairingMessage(event.value)) return;
        const message = event.value as PairingMessage;
        chain = chain.then(async () => {
          if (message.type === "pair-words") {
            let result: Awaited<ReturnType<typeof pairingResult>>;
            try {
              result = await pairingResult(
                x25519.privateKey,
                message.x25519,
                { invitePair: invite.pair, pair, computerKey: invite.computerKey, browserKey: signer.key, computerX25519: message.x25519, browserX25519: x25519.publicKey, code: invite.code },
                invite.secret,
              );
            } catch {
              // The computer's X25519 key isn't one to agree a secret with.
              return settle(() => reject(new PairingError("failed", "the computer's pairing key isn't usable")));
            }
            secret = result.secret;
            handlers.onWords(result.words, computer);
          } else if (message.type === "paired") {
            if (!secret || message.pair !== pair) return settle(() => reject(new PairingError("failed", "the computer answered for another pairing")));
            const record: PairRecord = {
              pair,
              computerKey: invite.computerKey,
              computerName: message.name || computer,
              device: message.device,
              signer: keyPair,
              boxKey: await pairBoxKey(secret, pair),
              handshake: origin,
              pairedAt: Date.now(),
            };
            secret.fill(0);
            await this.options.store.put(record);
            settle(() => resolve(record));
          } else if (message.type === "pair-refused") {
            const code = message.reason === "expired" ? "expired" : message.reason === "code" ? "code" : "refused";
            settle(() => reject(new PairingError(code, message.reason === "denied" ? "pairing was declined on the computer" : `the computer refused: ${message.reason}`)));
          }
        });
      };
      p1.listen(onEvent);
    });
    try {
      // An invite that has ended never opens: its final close settles `done` with the refusal instead.
      await Promise.race([open, done]);
      await p1.send("signal", request as unknown as Record<string, unknown>);
      return await done;
    } catch (err) {
      // A request that never went out (the invite already used or ended) ends the wait at once, timer and all.
      done.catch(() => undefined);
      cancel(err instanceof Error ? err : new Error("failed"));
      if (err instanceof PairingError) throw err;
      if (err instanceof HandshakeError && (err.status === 410 || err.status === 403)) throw new PairingError("refused", "this pairing link has been used or ended");
      throw new PairingError("failed", err instanceof Error ? err.message : "failed");
    } finally {
      p1.close();
    }
  }

  /** Connects to a paired computer: the pair's socket, then a WebRTC offer through it. */
  async connect(record: PairRecord, options: { timeoutMs?: number; onEnded?: () => void } = {}): Promise<Connection> {
    const channel = new PairChannel({
      client: this.client(record.handshake),
      pair: record.pair,
      signer: await signerFromKeyPair(record.signer),
      peer: record.computerKey,
      secret: record.boxKey,
    });
    const router = new SignalRouter();
    let ended = false;
    // The dial waits for the computer to be on its socket too: what is sent to a member whose socket isn't open waits
    // in its inbox, which keeps only the newest 16, so an offer followed by many ICE candidates (a restarted computer
    // still coming up) could lose the offer. Once the computer is online, every signal reaches it live, in order.
    let online: () => void = () => undefined;
    const computerOnline = new Promise<void>((resolve) => (online = resolve));
    const opened = new Promise<void>((resolve, reject) => {
      channel.listen((event) => {
        router.feed(event);
        if (event.type === "open") {
          if (event.peerOnline) online();
          resolve();
        }
        if (event.type === "presence" && event.online) online();
        if (event.type === "closed" && event.final) {
          ended = true;
          reject(new PairingError("refused", "this browser's pairing has ended"));
          void this.options.store.delete(record.pair);
          options.onEnded?.();
        }
      });
    });
    opened.catch(() => undefined);
    const timeoutMs = options.timeoutMs ?? 20_000;
    try {
      // The handshake may be unreachable: the socket keeps retrying, but this attempt gives up in time.
      let reached = false;
      await Promise.race([
        opened.then(() => {
          reached = true;
          return computerOnline;
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new LinkError("offline", reached ? `${record.computerName} isn't online` : "the handshake can't be reached")),
            timeoutMs,
          ),
        ),
      ]);
      const link = await dial({ channel, router, rtc: this.options.rtc, peer: record.computerKey, timeoutMs });
      return {
        link,
        record,
        close: () => {
          link.close("closed by the page");
          channel.close();
        },
      };
    } catch (err) {
      channel.close();
      if (ended) throw new PairingError("refused", "this browser's pairing has ended");
      throw err instanceof LinkError || err instanceof PairingError ? err : new PairingError("failed", err instanceof Error ? err.message : "failed");
    }
  }

  /** Forgets a computer here and ends the pair at the handshake, so neither side can use it again. */
  async forget(record: PairRecord): Promise<void> {
    const client = this.client(record.handshake);
    try {
      await client.pair(record.pair, await signerFromKeyPair(record.signer)).end();
    } catch {
      // Already ended, or offline: forgetting here still stands.
    }
    await this.options.store.delete(record.pair);
  }
}
