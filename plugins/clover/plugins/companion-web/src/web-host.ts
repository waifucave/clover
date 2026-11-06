// The computer's side of the web companion: browser pairing through the waifucave handshake, and each paired
// browser's WebRTC link (spec §8.4). It answers on the main computer, holding one handshake socket per paired
// browser; a browser that wants a link sends a WebRTC offer down it, and the link that comes up is handed to the core
// (`adopt`), which serves the `web` call list over it. The pairing exchange is services/web/protocol/pairing.ts.

import {
  type ChannelEvent,
  type HandshakeClient,
  PairChannel,
  pairStatement,
  signerFromSeed,
  signText,
  verifyText,
} from "@waifucave/clover-service-handshake/client";
import {
  answer,
  deviceIdFor,
  generateX25519,
  type Invite,
  inviteUrl,
  invitePairSecret,
  inviteSigner,
  isPairingMessage,
  lastingPairStatement,
  type PairingMessage,
  pairingResult,
  type PairRefused,
  type PairRequest,
  type RtcEnvironment,
  type RtcLink,
  SignalRouter,
} from "@waifucave/clover-service-web/protocol";
import type { AdoptLink, BrowserPair, ConfirmPairing, DeviceRegistryLike, PairStore } from "./contracts";

export interface WebLinkHostOptions {
  client: HandshakeClient;
  /** The web companion's origin, for invite links. */
  webOrigin: string;
  /** Put in invites when the handshake isn't the page's default (local emulators). */
  inviteHandshake?: string;
  computerName: string;
  rtc: RtcEnvironment;
  store: PairStore;
  registry: DeviceRegistryLike;
  confirm: ConfirmPairing;
  adopt: AdoptLink;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/** How long the person has to compare the words: inside the statements' 10-minute window, with room to register. */
const CONFIRM_LIMIT_MS = 8 * 60_000;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PAIR_RE = /^[A-Za-z0-9_-]{22}$/;

function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

interface Listening {
  record: BrowserPair;
  channel: PairChannel;
  link: RtcLink | null;
}

export class WebLinkHost {
  private readonly listening = new Map<string, Listening>();
  private readonly invites = new Set<PairChannel>();
  private unwatch: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: WebLinkHostOptions) {}

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unwatch = this.options.registry.watch((change) => {
      if (change.type === "revoked") void this.revoke(change.id);
    });
    for (const record of await this.options.store.list()) await this.listen(record);
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    for (const entry of this.listening.values()) {
      entry.link?.close("the computer stopped");
      entry.channel.close();
    }
    this.listening.clear();
    for (const invite of this.invites) invite.close();
    this.invites.clear();
  }

  /** The browsers' links that are up, by device id. */
  links(): Map<string, RtcLink> {
    const out = new Map<string, RtcLink>();
    for (const entry of this.listening.values()) if (entry.link?.open) out.set(entry.record.device, entry.link);
    return out;
  }

  // ---- pairing ----

  /** A one-time invite for a browser (the `companions` entry's `pairing`): the link the computer shows as text or QR. */
  async createInvite(args: { code: string; expiresAt: number }): Promise<string> {
    const seed = random(32);
    const signer = await signerFromSeed(seed);
    const invite: Invite = {
      pair: b64u(random(16)),
      computerKey: signer.key,
      secret: random(32),
      code: args.code,
      expiresAt: args.expiresAt,
      name: this.options.computerName.slice(0, 63),
      ...(this.options.inviteHandshake ? { handshake: this.options.inviteHandshake } : {}),
    };
    const inviteKey = await inviteSigner(invite);
    const t = Date.now();
    const statement = pairStatement(invite.pair, signer.key, inviteKey.key, t);
    await this.options.client.registerPair({
      pair: invite.pair,
      keys: [signer.key, inviteKey.key],
      t,
      sigs: [await signText(signer, statement), await signText(inviteKey, statement)],
    });
    const channel = new PairChannel({ client: this.options.client, pair: invite.pair, signer, peer: inviteKey.key, secret: await invitePairSecret(invite) });
    this.invites.add(channel);
    let taken = false;
    const finish = async () => {
      this.invites.delete(channel);
      await channel.scope.end().catch(() => undefined);
      channel.close();
    };
    const expiry = setTimeout(() => {
      if (!taken) void finish();
    }, Math.max(args.expiresAt - Date.now(), 0));
    channel.listen((event: ChannelEvent) => {
      if (taken || event.type !== "message" || event.kind !== "signal" || !isPairingMessage(event.value)) return;
      const message = event.value as PairingMessage;
      if (message.type !== "pair-request") return;
      taken = true;
      clearTimeout(expiry);
      void this.answerRequest(invite, seed, channel, message)
        .catch((err: unknown) => {
          this.log("warn", `web companion: pairing failed (${err instanceof Error ? err.message : "error"})`);
          return this.refuse(channel, "failed");
        })
        .finally(finish);
    });
    return inviteUrl(this.options.webOrigin, invite);
  }

  private async refuse(channel: PairChannel, reason: PairRefused["reason"]): Promise<void> {
    await channel.send("signal", { v: 1, at: Date.now(), type: "pair-refused", reason }).catch(() => undefined);
  }

  private async answerRequest(invite: Invite, seed: Uint8Array, channel: PairChannel, request: PairRequest): Promise<void> {
    if (Date.now() > invite.expiresAt) return this.refuse(channel, "expired");
    if (request.code !== invite.code) return this.refuse(channel, "code");
    if (!PAIR_RE.test(request.pair) || !KEY_RE.test(request.key) || typeof request.x25519 !== "string" || typeof request.t !== "number") {
      return this.refuse(channel, "failed");
    }
    if (!(await verifyText(request.key, request.sig, lastingPairStatement(request.pair, invite.computerKey, request.key, request.t)))) {
      return this.refuse(channel, "failed");
    }
    const x25519 = await generateX25519();
    const { secret, words } = await pairingResult(
      x25519.privateKey,
      request.x25519,
      {
        invitePair: invite.pair,
        pair: request.pair,
        computerKey: invite.computerKey,
        browserKey: request.key,
        computerX25519: x25519.publicKey,
        browserX25519: request.x25519,
        code: invite.code,
      },
      invite.secret,
    );
    await channel.send("signal", { v: 1, at: Date.now(), type: "pair-words", x25519: x25519.publicKey });

    const name = typeof request.name === "string" && request.name.trim() ? request.name.trim().slice(0, 63) : "A browser";
    const limit = new Promise<{ confirmed: boolean; card: string }>((resolve) => setTimeout(() => resolve({ confirmed: false, card: "" }), CONFIRM_LIMIT_MS));
    const verdict = await Promise.race([this.options.confirm({ browser: name, words, code: invite.code }), limit]);
    if (!verdict.confirmed) return this.refuse(channel, "denied");

    const signer = await signerFromSeed(seed);
    const statement = lastingPairStatement(request.pair, invite.computerKey, request.key, request.t);
    await this.options.client.registerPair({ pair: request.pair, keys: [invite.computerKey, request.key], t: request.t, sigs: [await signText(signer, statement), request.sig] });
    const keyBytes = fromB64u(request.key);
    const device = await deviceIdFor(keyBytes);
    await this.options.registry.add(
      { id: device, name, kind: "browser", runsCore: false, publicKey: btoa(String.fromCharCode(...keyBytes)) },
      { via: "code", card: verdict.card },
    );
    const record: BrowserPair = { pair: request.pair, seed, secret, browserKey: request.key, device, name, pairedAt: Date.now() };
    await this.options.store.put(record);
    await channel.send("signal", { v: 1, at: Date.now(), type: "paired", pair: request.pair, name: this.options.computerName, device });
    this.log("info", `web companion: paired ${name}`);
    await this.listen(record);
  }

  // ---- links ----

  private async listen(record: BrowserPair): Promise<void> {
    if (this.stopped || this.listening.has(record.pair)) return;
    const channel = new PairChannel({
      client: this.options.client,
      pair: record.pair,
      signer: await signerFromSeed(record.seed),
      peer: record.browserKey,
      secret: record.secret,
    });
    const entry: Listening = { record, channel, link: null };
    this.listening.set(record.pair, entry);
    const router = new SignalRouter();
    router.onOffer = (offer) => {
      void answer({ channel, router, rtc: this.options.rtc, offer, peer: record.device })
        .then((link) => {
          // One link per browser: a new one (a reload, a second tab) replaces the old.
          entry.link?.close("replaced");
          entry.link = link;
          link.onClose(() => {
            if (entry.link === link) entry.link = null;
          });
          this.options.adopt(link, record.device);
        })
        .catch((err: unknown) => this.log("warn", `web companion: a browser's connection failed (${err instanceof Error ? err.message : "error"})`));
    };
    channel.listen((event) => {
      router.feed(event);
      // The browser forgot this computer and ended the pair: forget it here too.
      if (event.type === "closed" && event.final && !this.stopped) void this.forget(record.pair);
    });
  }

  private async forget(pair: string): Promise<void> {
    const entry = this.listening.get(pair);
    this.listening.delete(pair);
    entry?.link?.close("the pairing ended");
    entry?.channel.close();
    await this.options.store.delete(pair);
  }

  /** Ends a browser's pairing (a revoke in the registry, or from here): at the handshake, then here. */
  async revoke(device: string): Promise<void> {
    for (const [pair, entry] of this.listening) {
      if (entry.record.device !== device) continue;
      await entry.channel.scope.end().catch(() => undefined);
      await this.forget(pair);
    }
  }
}
